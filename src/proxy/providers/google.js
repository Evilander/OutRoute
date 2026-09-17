import { BaseProvider, ProviderError, isChatModelId } from './base.js';
import { getOpenRouterCatalog, priceForSync } from './pricing.js';

// Prices checked 2026-09-17 (ai.google.dev/gemini-api/docs/pricing, cross-validated
// against OpenRouter's google/ listing). Gemini 1.5 and 2.5 are deprecated/being
// shut down in 2026 — this is the current 3.x line. Base (<=200K) tier for the pro
// model; it doubles above that context, which this flat per-1k field can't express.
const MODELS = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', contextWindow: 2_000_000, costPer1kInput: 0.002, costPer1kOutput: 0.012 },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1_000_000, costPer1kInput: 0.00075, costPer1kOutput: 0.00375 },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextWindow: 1_000_000, costPer1kInput: 0.0003, costPer1kOutput: 0.0025 },
];

const DEFAULT_MODEL = 'gemini-3.8-flash';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => p?.text || '').join('');
  return '';
}

// OpenAI-shaped content blocks -> Gemini `parts`. image_url (base64 data: URL or a
// remote URL) becomes inlineData/fileData; anything else is dropped with a logged
// reason instead of silently contributing nothing.
function convertPart(part) {
  if (part?.type === 'text') return { text: part.text || '' };
  if (part?.type === 'image_url') {
    const url = part.image_url?.url || '';
    const dataMatch = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (dataMatch) return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
    if (url) return { fileData: { fileUri: url } };
  }
  console.error(`[google] dropping unsupported content block type: ${part?.type}`);
  return null;
}

function convertParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: '' }];
  const parts = content.map(convertPart).filter(Boolean);
  return parts.length ? parts : [{ text: '' }];
}

const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

function mapFinishReason(reason) {
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'MALFORMED_FUNCTION_CALL') return 'tool_calls';
  if (BLOCKED_FINISH_REASONS.has(reason)) return 'content_filter';
  return 'stop';
}

export class GoogleProvider extends BaseProvider {
  #apiKey;
  #baseUrl;
  #discovered = null;

  constructor(config = {}) {
    super(config);
    this.#apiKey = config.apiKey || process.env.GOOGLE_API_KEY || '';
    this.#baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  get name() {
    return 'google';
  }

  get available() {
    return Boolean(this.#apiKey);
  }

  get models() {
    return this.#discovered || MODELS;
  }

  #authHeaders(extra = {}) {
    return { ...extra, 'x-goog-api-key': this.#apiKey };
  }

  // Convert OpenAI-style messages to Gemini format:
  // {contents: [{role: "user"|"model", parts: [...]}], systemInstruction: ...}
  #convertMessages(messages) {
    let systemText = '';
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText += (systemText ? '\n\n' : '') + textOf(msg.content);
        continue;
      }
      if (msg.role !== 'user' && msg.role !== 'assistant') continue; // tool/function roles: not translated yet (mirrors anthropic.js)

      // Gemini uses "model" instead of "assistant"
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = convertParts(msg.content);

      // Gemini requires alternating user/model turns; merge consecutive same-role messages.
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    }

    // Gemini requires contents to start with "user". If it starts with "model", prepend a synthetic user turn.
    if (contents.length > 0 && contents[0].role === 'model') {
      contents.unshift({ role: 'user', parts: [{ text: '.' }] });
    }

    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: systemText || 'Hello' }] });
      systemText = '';
    }

    return { systemText, contents };
  }

  #buildRequestBody(messages, options) {
    const { systemText, contents } = this.#convertMessages(messages);
    const body = { contents };

    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

    const generationConfig = {
      // Symmetric with Anthropic's forced default: an omitted max_tokens shouldn't
      // behave differently depending on which provider happened to serve the request.
      maxOutputTokens: options.maxTokens !== undefined ? options.maxTokens : 4096,
    };
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.topP !== undefined) generationConfig.topP = options.topP;
    if (options.topK !== undefined) generationConfig.topK = options.topK;
    if (options.stop !== undefined) {
      generationConfig.stopSequences = Array.isArray(options.stop) ? options.stop : [options.stop];
    }
    body.generationConfig = generationConfig;

    return body;
  }

  // Returns { error: true, message, inputTokens, outputTokens } for a blocked/filtered
  // response instead of a normal result, so chat() can throw and the router's
  // existing failure/failover path handles it rather than silently "succeeding".
  #parseResponse(data, model, latencyMs) {
    const candidate = data.candidates?.[0];

    if (!candidate) {
      const blockReason = data.promptFeedback?.blockReason;
      return {
        error: true,
        message: blockReason ? `Response blocked: ${blockReason}` : 'No response candidate returned',
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
      };
    }

    if (BLOCKED_FINISH_REASONS.has(candidate.finishReason)) {
      return {
        error: true,
        message: `Response filtered: ${candidate.finishReason}`,
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      };
    }

    const content = candidate.content?.parts
      ?.filter(p => p.text !== undefined)
      .map(p => p.text)
      .join('') || '';

    return {
      content,
      model,
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      latencyMs,
      finishReason: mapFinishReason(candidate.finishReason),
      raw: data,
    };
  }

  async chat(messages, options = {}) {
    if (!this.available) {
      throw new ProviderError('API key not configured', { provider: this.name, model: options.model, retryable: false });
    }

    const model = options.model || DEFAULT_MODEL;
    if (options.tools && !this.supportsTools) {
      throw new ProviderError('This provider does not support tools', { provider: this.name, model, status: 400, retryable: false });
    }
    const startTime = Date.now();

    if (options.stream) return this.#streamChat(messages, { ...options, model }, startTime);

    const body = this.#buildRequestBody(messages, options);
    const url = `${this.#baseUrl}/models/${model}:generateContent`;
    const timeoutMs = options.timeout || 120_000;

    let response, clear;
    try {
      ({ response, clear } = await this.fetchWithTimeout(
        url,
        { method: 'POST', headers: this.#authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) },
        timeoutMs,
        options.signal,
      ));
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new ProviderError('Request timed out', { provider: this.name, model, retryable: true });
      }
      throw new ProviderError(`Network error: ${err.message}`, { provider: this.name, model, retryable: true });
    }

    try {
      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        const msg = errorBody?.error?.message || `HTTP ${response.status}`;
        throw new ProviderError(msg, {
          provider: this.name, model, status: response.status,
          retryable: this.isRetryable({ status: response.status }), raw: errorBody,
        });
      }

      const data = await response.json();
      const parsed = this.#parseResponse(data, model, latencyMs);
      if (parsed.error) {
        throw new ProviderError(parsed.message, { provider: this.name, model, status: 400, retryable: false, raw: data });
      }
      return parsed;
    } finally {
      clear();
    }
  }

  async *#streamChat(messages, options, startTime) {
    const model = options.model;
    const body = this.#buildRequestBody(messages, options);
    const url = `${this.#baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
    const timeoutMs = options.timeout || 120_000;
    const { signal, clear } = this.createExchangeSignal(timeoutMs, options.signal);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST', headers: this.#authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body), signal,
      });
    } catch (err) {
      clear();
      if (err.name === 'AbortError') throw new ProviderError('Request timed out', { provider: this.name, model, retryable: true });
      throw new ProviderError(`Network error: ${err.message}`, { provider: this.name, model, retryable: true });
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      clear();
      throw new ProviderError(errorBody?.error?.message || `HTTP ${response.status}`, {
        provider: this.name, model, status: response.status,
        retryable: this.isRetryable({ status: response.status }), raw: errorBody,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';
    let blocked = null;

    const handleLine = function* (line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) return;
      let data;
      try { data = JSON.parse(trimmed.slice(6)); } catch { return; }

      const candidate = data.candidates?.[0];
      if (candidate && BLOCKED_FINISH_REASONS.has(candidate.finishReason)) {
        blocked = `Response filtered: ${candidate.finishReason}`;
      }
      if (candidate?.finishReason) finishReason = mapFinishReason(candidate.finishReason);
      if (candidate?.content?.parts) {
        const text = candidate.content.parts.filter(p => p.text !== undefined).map(p => p.text).join('');
        if (text) yield { type: 'delta', content: text };
      }
      if (data.usageMetadata) {
        inputTokens = data.usageMetadata.promptTokenCount || inputTokens;
        outputTokens = data.usageMetadata.candidatesTokenCount || outputTokens;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) yield* handleLine(buffer);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) yield* handleLine(line);
      }
    } finally {
      reader.releaseLock();
      clear();
    }

    if (blocked) {
      throw new ProviderError(blocked, { provider: this.name, model, status: 400, retryable: false });
    }

    yield { type: 'done', model, inputTokens, outputTokens, latencyMs: Date.now() - startTime, finishReason };
  }

  async discoverModels() {
    if (!this.available) return;
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.#baseUrl}/models`, { method: 'GET', headers: this.#authHeaders() }, 15_000);
      let rows;
      try {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        rows = (data.models || [])
          .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map(m => ({
            id: (m.baseModelId || m.name || '').replace(/^models\//, ''),
            display: m.displayName,
            inputTokenLimit: m.inputTokenLimit,
          }))
          .filter(m => m.id && isChatModelId(m.id));
      } finally {
        clear();
      }
      if (rows.length === 0) throw new Error('no chat models returned');

      await getOpenRouterCatalog();
      const byId = new Map(MODELS.map(m => [m.id, m]));
      this.#discovered = rows.map(m => {
        const known = byId.get(m.id);
        const price = priceForSync(m.id);
        return {
          id: m.id,
          name: m.display || known?.name || m.id,
          contextWindow: m.inputTokenLimit || known?.contextWindow || 1_000_000,
          costPer1kInput: known?.costPer1kInput ?? price?.input ?? null,
          costPer1kOutput: known?.costPer1kOutput ?? price?.output ?? null,
          featured: Boolean(known),
        };
      }).sort((a, b) => Number(b.featured) - Number(a.featured));
    } catch (err) {
      console.error('[google] model discovery failed, keeping fallback list:', err.message);
    }
  }

  async healthCheck() {
    if (!this.available) return { healthy: false, reason: 'API key not configured' };

    const startTime = Date.now();
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.#baseUrl}/models`, { method: 'GET', headers: this.#authHeaders() }, 10_000);
      try {
        const latencyMs = Date.now() - startTime;
        if (!response.ok) return { healthy: false, latencyMs, reason: `HTTP ${response.status}` };
        return { healthy: true, latencyMs, provider: this.name };
      } finally {
        clear();
      }
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - startTime, reason: err.message };
    }
  }
}
