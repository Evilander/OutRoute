import { BaseProvider, ProviderError, isChatModelId, mergeModelCatalog } from './base.js';
import { getOpenRouterCatalog, priceForSync } from './pricing.js';

// Prices checked 2026-09-17 (developers.openai.com/api/docs/pricing, cross-validated
// against OpenRouter's openai/ listing). gpt-4o/gpt-4-turbo/o1 are retired — this is
// what OpenAI actually serves current API keys today.
const MODELS = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 200_000, costPer1kInput: 0.01, costPer1kOutput: 0.05 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 200_000, costPer1kInput: 0.004, costPer1kOutput: 0.02 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 128_000, costPer1kInput: 0.002, costPer1kOutput: 0.012 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 128_000, costPer1kInput: 0.0002, costPer1kOutput: 0.0012 },
];

// o-series and the gpt-5.x/gpt-6.x families are "reasoning" models: they reject
// max_tokens (use max_completion_tokens) and reject non-default temperature/top_p.
// OpenRouter-style prefixed ids ("openai/gpt-6-astra") don't match — OpenRouter
// normalizes those params away, so no branching is needed there.
const REASONING_MODEL = /^(o\d|gpt-5|gpt-6)(\.|-|$)/i;
export function isReasoningModel(modelId) {
  return REASONING_MODEL.test(String(modelId || ''));
}

const FINISH_REASONS = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  content_filter: 'content_filter',
};
export function mapFinishReason(reason) {
  return FINISH_REASONS[reason] || 'stop';
}

// OpenAI's 400 for an unsupported parameter names it either in `error.param` or
// quoted in `error.message` ("'temperature' is not supported with this model").
function extractRejectedParam(errorBody) {
  const err = errorBody?.error;
  if (!err) return null;
  if (err.param) return err.param;
  const match = /'([a-z_]+)'/i.exec(err.message || '');
  return match ? match[1] : null;
}

function applyStreamChunk(chunk, state) {
  const out = [];
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (delta?.content) out.push({ type: 'delta', content: delta.content });
  if (delta?.tool_calls) out.push({ type: 'delta', content: '', toolCalls: delta.tool_calls });
  if (chunk.model) state.model = chunk.model;
  if (choice?.finish_reason) state.finishReason = mapFinishReason(choice.finish_reason);
  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens ?? state.inputTokens;
    state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
  }
  return out;
}

function parseSSEPayload(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return null;
  const payload = trimmed.slice(6);
  if (payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export class OpenAIProvider extends BaseProvider {
  #apiKey;
  #baseUrl;
  #providerName;
  #fallbackModels;
  #discovered = null;
  #rejectedParams = new Map(); // model id -> Set of body field names this model has 400'd on

  constructor(config = {}) {
    super(config);
    this.#apiKey = config.apiKey !== undefined ? config.apiKey : (process.env.OPENAI_API_KEY || '');
    this.#baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.#providerName = config.providerName || 'openai';
    this.#fallbackModels = config.models || MODELS;
  }

  get name() {
    return this.#providerName;
  }

  get available() {
    return Boolean(this.#apiKey);
  }

  get supportsTools() {
    return true;
  }

  get models() {
    return this.#discovered || this.#fallbackModels;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  // Lets a subclass (xai.js) replace the discovered list with one built from its
  // own /models response instead of this class's generic discovery.
  setDiscoveredModels(list) {
    this.#discovered = list;
  }

  buildHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.#apiKey}`,
    };
  }

  buildRequestBody(messages, options, { omit = new Set() } = {}) {
    const model = options.model || this.#fallbackModels[0]?.id;
    const reasoning = isReasoningModel(model);
    const body = { model, messages };

    if (options.maxTokens !== undefined) {
      // A prior 400 telling us this exact field is unsupported flips it to the
      // other name, rather than the fixed reasoning-model guess, so an id our
      // regex misclassifies still lands on the field the model actually wants.
      const preferred = reasoning ? 'max_completion_tokens' : 'max_tokens';
      const key = omit.has(preferred) ? (preferred === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens') : preferred;
      body[key] = options.maxTokens;
    }

    const optional = [
      ['temperature', options.temperature],
      ['top_p', options.topP],
      ['stop', options.stop],
      ['seed', options.seed],
      ['frequency_penalty', options.frequencyPenalty],
      ['presence_penalty', options.presencePenalty],
      ['response_format', options.responseFormat],
      ['tools', options.tools],
      ['tool_choice', options.toolChoice],
    ];
    for (const [key, value] of optional) {
      if (value !== undefined && !omit.has(key)) body[key] = value;
    }

    if (options.stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    return body;
  }

  parseResponse(data, model, latencyMs) {
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      message: choice?.message,
      model: data.model || model,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      latencyMs,
      finishReason: mapFinishReason(choice?.finish_reason),
      raw: data,
    };
  }

  // Bounds the whole exchange (fetch + response.json()) under one timeout/abort
  // signal and returns the parsed body without throwing on a non-2xx response —
  // callers decide whether that's a retry-without-the-param case or a real error.
  async #postJSON(url, body, options) {
    const timeoutMs = options.timeout || 120_000;
    const { response, clear } = await this.fetchWithTimeout(
      url,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      timeoutMs,
      options.signal,
    ).catch(err => {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new ProviderError('Request timed out', { provider: this.name, model: body.model, retryable: true });
      }
      throw new ProviderError(`Network error: ${err.message}`, { provider: this.name, model: body.model, retryable: true });
    });
    try {
      const data = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, data };
    } finally {
      clear();
    }
  }

  async chat(messages, options = {}) {
    if (!this.available) {
      throw new ProviderError('API key not configured', { provider: this.name, model: options.model, retryable: false });
    }

    const model = options.model || this.#fallbackModels[0]?.id;
    if (options.tools && !this.supportsTools) {
      throw new ProviderError('This provider does not support tools', {
        provider: this.name, model, status: 400, retryable: false,
      });
    }

    const startTime = Date.now();
    if (options.stream) return this.#streamChat(messages, { ...options, model }, startTime);

    const rejected = new Set(this.#rejectedParams.get(model));
    let body = this.buildRequestBody(messages, { ...options, model }, { omit: rejected });
    let result = await this.#postJSON(`${this.#baseUrl}/chat/completions`, body, options);

    if (!result.ok && result.status === 400) {
      const badParam = extractRejectedParam(result.data);
      if (badParam && !rejected.has(badParam)) {
        rejected.add(badParam);
        this.#rejectedParams.set(model, rejected);
        body = this.buildRequestBody(messages, { ...options, model }, { omit: rejected });
        result = await this.#postJSON(`${this.#baseUrl}/chat/completions`, body, options);
      }
    }

    if (!result.ok) {
      const msg = result.data?.error?.message || `HTTP ${result.status}`;
      throw new ProviderError(msg, {
        provider: this.name, model, status: result.status,
        retryable: this.isRetryable({ status: result.status }), raw: result.data,
      });
    }

    return this.parseResponse(result.data, model, Date.now() - startTime);
  }

  async *#streamChat(messages, options, startTime) {
    const model = options.model;
    const rejected = new Set(this.#rejectedParams.get(model));
    const body = this.buildRequestBody(messages, { ...options, stream: true }, { omit: rejected });
    const timeoutMs = options.timeout || 120_000;
    const { signal, clear } = this.createExchangeSignal(timeoutMs, options.signal);

    let response;
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body), signal,
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
    const state = { model, finishReason: 'stop', inputTokens: 0, outputTokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const chunk = parseSSEPayload(buffer);
          if (chunk) for (const evt of applyStreamChunk(chunk, state)) yield evt;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const chunk = parseSSEPayload(line);
          if (chunk) for (const evt of applyStreamChunk(chunk, state)) yield evt;
        }
      }
    } finally {
      reader.releaseLock();
      clear();
    }

    yield {
      type: 'done',
      model: state.model,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      latencyMs: Date.now() - startTime,
      finishReason: state.finishReason,
    };
  }

  async discoverModels() {
    if (!this.available) return;
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.#baseUrl}/models`, { method: 'GET', headers: this.buildHeaders() }, 15_000);
      let ids;
      try {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        ids = (data.data || []).map(m => m.id).filter(isChatModelId);
      } finally {
        clear();
      }
      if (ids.length === 0) throw new Error('no chat models returned');
      await getOpenRouterCatalog();
      this.#discovered = mergeModelCatalog(ids, this.#fallbackModels, { priceFor: priceForSync });
    } catch (err) {
      console.error(`[${this.name}] model discovery failed, keeping fallback list:`, err.message);
    }
  }

  async healthCheck() {
    if (!this.available) return { healthy: false, reason: 'API key not configured' };

    const startTime = Date.now();
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.#baseUrl}/models`, { method: 'GET', headers: this.buildHeaders() }, 10_000);
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
