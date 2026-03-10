import { BaseProvider, ProviderError } from './base.js';

const MODELS = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    contextWindow: 128_000,
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    contextWindow: 128_000,
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    contextWindow: 128_000,
    costPer1kInput: 0.01,
    costPer1kOutput: 0.03,
  },
  {
    id: 'o1',
    name: 'o1',
    contextWindow: 200_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.06,
  },
];

export class OpenAIProvider extends BaseProvider {
  #apiKey;
  #baseUrl;
  #providerName;

  constructor(config = {}) {
    super(config);
    this.#apiKey = config.apiKey !== undefined ? config.apiKey : (process.env.OPENAI_API_KEY || '');
    this.#baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.#providerName = config.providerName || 'openai';
  }

  get name() {
    return this.#providerName;
  }

  get available() {
    return Boolean(this.#apiKey);
  }

  get models() {
    return this.config.models || MODELS;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  buildHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.#apiKey}`,
    };
  }

  buildRequestBody(messages, options) {
    const body = {
      model: options.model || 'gpt-4o',
      messages,
    };

    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.stop !== undefined) body.stop = options.stop;
    if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty;
    if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty;
    if (options.stream) body.stream = true;
    if (options.responseFormat) body.response_format = options.responseFormat;

    return body;
  }

  parseResponse(data, model, latencyMs) {
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      model: data.model || model,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      latencyMs,
      raw: data,
    };
  }

  async chat(messages, options = {}) {
    if (!this.available) {
      throw new ProviderError('API key not configured', {
        provider: this.name,
        model: options.model,
        retryable: false,
      });
    }

    const model = options.model || 'gpt-4o';
    const startTime = Date.now();

    if (options.stream) {
      return this.#streamChat(messages, options, startTime);
    }

    const body = this.buildRequestBody(messages, options);

    let response;
    try {
      response = await this.fetchWithTimeout(
        `${this.#baseUrl}/chat/completions`,
        { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
        options.timeout || 120_000
      );
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ProviderError('Request timed out', {
          provider: this.name, model, retryable: true,
        });
      }
      throw new ProviderError(`Network error: ${err.message}`, {
        provider: this.name, model, retryable: true,
      });
    }

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errorBody;
      try { errorBody = await response.json(); } catch { errorBody = null; }
      const msg = errorBody?.error?.message || `HTTP ${response.status}`;
      throw new ProviderError(msg, {
        provider: this.name,
        model,
        status: response.status,
        retryable: this.isRetryable({ status: response.status }),
        raw: errorBody,
      });
    }

    const data = await response.json();
    return this.parseResponse(data, model, latencyMs);
  }

  async *#streamChat(messages, options, startTime) {
    const body = this.buildRequestBody(messages, { ...options, stream: true });

    let response;
    try {
      response = await this.fetchWithTimeout(
        `${this.#baseUrl}/chat/completions`,
        { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
        options.timeout || 120_000
      );
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ProviderError('Request timed out', {
          provider: this.name, model: options.model, retryable: true,
        });
      }
      throw new ProviderError(`Network error: ${err.message}`, {
        provider: this.name, model: options.model, retryable: true,
      });
    }

    if (!response.ok) {
      let errorBody;
      try { errorBody = await response.json(); } catch { errorBody = null; }
      const msg = errorBody?.error?.message || `HTTP ${response.status}`;
      throw new ProviderError(msg, {
        provider: this.name,
        model: options.model,
        status: response.status,
        retryable: this.isRetryable({ status: response.status }),
        raw: errorBody,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let finalModel = options.model || 'gpt-4o';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;

          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }

          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            yield {
              type: 'delta',
              content: delta.content,
              model: chunk.model || finalModel,
            };
          }

          if (chunk.model) finalModel = chunk.model;

          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || 0;
            outputTokens = chunk.usage.completion_tokens || 0;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: 'done',
      content: fullContent,
      model: finalModel,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startTime,
    };
  }

  async healthCheck() {
    if (!this.available) return { healthy: false, reason: 'API key not configured' };

    const startTime = Date.now();
    try {
      const response = await this.fetchWithTimeout(
        `${this.#baseUrl}/models`,
        { method: 'GET', headers: this.buildHeaders() },
        10_000
      );
      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        return { healthy: false, latencyMs, reason: `HTTP ${response.status}` };
      }

      return { healthy: true, latencyMs, provider: this.name };
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - startTime, reason: err.message };
    }
  }
}
