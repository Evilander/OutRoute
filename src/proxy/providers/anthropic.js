import { BaseProvider, ProviderError, isChatModelId } from './base.js';
import { getOpenRouterCatalog, priceForSync } from './pricing.js';

// Prices checked 2026-09-17 against claude.com/pricing and OpenRouter's listing.
// These are aliases; the models endpoint may list a dated snapshot instead.
const MODELS = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, costPer1kInput: 0.01, costPer1kOutput: 0.05 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000, costPer1kInput: 0.005, costPer1kOutput: 0.025 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, costPer1kInput: 0.002, costPer1kOutput: 0.01 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000, costPer1kInput: 0.001, costPer1kOutput: 0.005 },
];

const DEFAULT_MODEL = 'claude-sonnet-5';
const API_VERSION = '2023-06-01';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => p?.text || '').join('');
  return '';
}

// OpenAI-shaped content blocks -> Anthropic's. image_url (base64 data: URL or a
// remote URL) becomes an `image` block; anything else this doesn't recognize is
// dropped with a logged reason rather than silently forwarded or silently empty.
function convertBlock(part) {
  if (part?.type === 'text') return { type: 'text', text: part.text || '' };
  if (part?.type === 'image_url') {
    const url = part.image_url?.url || '';
    const dataMatch = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (dataMatch) return { type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } };
    if (url) return { type: 'image', source: { type: 'url', url } };
  }
  console.error(`[anthropic] dropping unsupported content block type: ${part?.type}`);
  return null;
}

function convertContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(convertBlock).filter(Boolean);
}

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export class AnthropicProvider extends BaseProvider {
  #apiKey;
  #baseUrl;
  #discovered = null;

  constructor(config = {}) {
    super(config);
    this.#apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.#baseUrl = config.baseUrl || 'https://api.anthropic.com';
  }

  get name() {
    return 'anthropic';
  }

  get available() {
    return Boolean(this.#apiKey);
  }

  get models() {
    return this.#discovered || MODELS;
  }

  #buildHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.#apiKey,
      'anthropic-version': API_VERSION,
    };
  }

  // Convert OpenAI-style messages [{role, content}] to Anthropic format. Anthropic
  // requires: system is a top-level field, messages only contain user/assistant
  // (strictly alternating — consecutive same-role turns must be merged), and the
  // first message must be role "user".
  #convertMessages(messages) {
    let system = '';
    const converted = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n\n' : '') + textOf(msg.content);
        continue;
      }
      if (msg.role !== 'user' && msg.role !== 'assistant') continue; // tool/function roles: not translated yet

      const content = convertContent(msg.content);
      if (Array.isArray(content) && content.length === 0) continue; // nothing left after dropping unsupported blocks

      const last = converted[converted.length - 1];
      if (last && last.role === msg.role) {
        const prevBlocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
        const nextBlocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
        last.content = [...prevBlocks, ...nextBlocks];
      } else {
        converted.push({ role: msg.role, content });
      }
    }

    if (converted.length > 0 && converted[0].role === 'assistant') {
      converted.unshift({ role: 'user', content: '.' });
    }
    if (converted.length === 0) {
      converted.push({ role: 'user', content: system || 'Hello' });
      system = '';
    }

    return { system, messages: converted };
  }

  #buildRequestBody(messages, options) {
    const { system, messages: convertedMessages } = this.#convertMessages(messages);
    const model = options.model || DEFAULT_MODEL;

    const body = {
      model,
      max_tokens: options.maxTokens || 4096,
      messages: convertedMessages,
    };

    if (system) body.system = system;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.topK !== undefined) body.top_k = options.topK;
    if (options.stop !== undefined) body.stop_sequences = Array.isArray(options.stop) ? options.stop : [options.stop];
    if (options.stream) body.stream = true;

    return body;
  }

  #parseResponse(data, model, latencyMs) {
    let content = '';
    if (Array.isArray(data.content)) {
      content = data.content.filter(block => block.type === 'text').map(block => block.text).join('');
    }

    return {
      content,
      model: data.model || model,
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      latencyMs,
      finishReason: mapStopReason(data.stop_reason),
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

    const body = this.#buildRequestBody(messages, { ...options, model });
    const timeoutMs = options.timeout || 120_000;

    let response, clear;
    try {
      ({ response, clear } = await this.fetchWithTimeout(
        `${this.#baseUrl}/v1/messages`,
        { method: 'POST', headers: this.#buildHeaders(), body: JSON.stringify(body) },
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
      return this.#parseResponse(data, model, latencyMs);
    } finally {
      clear();
    }
  }

  async *#streamChat(messages, options, startTime) {
    const model = options.model;
    const body = this.#buildRequestBody(messages, { ...options, stream: true });
    const timeoutMs = options.timeout || 120_000;
    const { signal, clear } = this.createExchangeSignal(timeoutMs, options.signal);

    let response;
    try {
      response = await fetch(`${this.#baseUrl}/v1/messages`, {
        method: 'POST', headers: this.#buildHeaders(), body: JSON.stringify(body), signal,
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

    // SSE event types: message_start, content_block_start, content_block_delta,
    // content_block_stop, message_delta, message_stop.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalModel = model;
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';
    // Lives outside consumeLines(): an "event: " line and its "data: " line can
    // land in separate reader.read() chunks, so the event name has to survive
    // across calls instead of resetting each time consumeLines() runs.
    let currentEvent = '';

    const handleEvent = function* (eventType, data) {
      switch (eventType) {
        case 'message_start':
          if (data.message?.model) finalModel = data.message.model;
          if (data.message?.usage?.input_tokens) inputTokens = data.message.usage.input_tokens;
          break;
        case 'content_block_delta':
          if (data.delta?.type === 'text_delta' && data.delta.text) {
            yield { type: 'delta', content: data.delta.text };
          }
          break;
        case 'message_delta':
          if (data.delta?.stop_reason) finishReason = mapStopReason(data.delta.stop_reason);
          if (data.usage?.output_tokens) outputTokens = data.usage.output_tokens;
          break;
      }
    };

    const consumeLines = function* (lines) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event: ')) {
          currentEvent = trimmed.slice(7);
          continue;
        }
        if (!trimmed.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(trimmed.slice(6)); } catch { currentEvent = ''; continue; }
        yield* handleEvent(currentEvent || data.type, data);
        currentEvent = '';
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) yield* consumeLines(buffer.split('\n'));
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        yield* consumeLines(lines);
      }
    } finally {
      reader.releaseLock();
      clear();
    }

    yield { type: 'done', model: finalModel, inputTokens, outputTokens, latencyMs: Date.now() - startTime, finishReason };
  }

  async discoverModels() {
    if (!this.available) return;
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.#baseUrl}/v1/models`, { method: 'GET', headers: this.#buildHeaders() }, 15_000);
      let rows;
      try {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        rows = (data.data || []).filter(m => isChatModelId(m.id));
      } finally {
        clear();
      }
      if (rows.length === 0) throw new Error('no chat models returned');

      await getOpenRouterCatalog();
      const byId = new Map(MODELS.map(m => [m.id, m]));
      this.#discovered = rows.map(m => {
        // The catalog lists some models only as dated snapshots
        // (claude-haiku-4-5-20251001) where the curated list has the alias.
        const known = byId.get(m.id) || byId.get(m.id.replace(/-\d{8}$/, ''));
        const price = priceForSync(m.id);
        return {
          id: m.id,
          name: m.display_name || known?.name || m.id,
          contextWindow: m.max_input_tokens || known?.contextWindow || 200_000,
          costPer1kInput: known?.costPer1kInput ?? price?.input ?? null,
          costPer1kOutput: known?.costPer1kOutput ?? price?.output ?? null,
          featured: Boolean(known),
        };
      }).sort((a, b) => Number(b.featured) - Number(a.featured));
    } catch (err) {
      console.error('[anthropic] model discovery failed, keeping fallback list:', err.message);
    }
  }

  // Anthropic's models-list endpoint never runs an inference, so this health check
  // costs nothing — unlike the old implementation, which billed a real /v1/messages
  // call every interval.
  async healthCheck() {
    if (!this.available) return { healthy: false, reason: 'API key not configured' };

    const startTime = Date.now();
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.#baseUrl}/v1/models`, { method: 'GET', headers: this.#buildHeaders() }, 10_000);
      try {
        const latencyMs = Date.now() - startTime;
        if (response.status === 401) return { healthy: false, latencyMs, reason: 'Invalid API key' };
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
