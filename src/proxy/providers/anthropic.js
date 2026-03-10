import { BaseProvider, ProviderError } from './base.js';

const MODELS = [
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4',
    contextWindow: 200_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    contextWindow: 200_000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
  },
];

const API_VERSION = '2023-06-01';

export class AnthropicProvider extends BaseProvider {
  #apiKey;
  #baseUrl;

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
    return MODELS;
  }

  #buildHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.#apiKey,
      'anthropic-version': API_VERSION,
    };
  }

  // Convert OpenAI-style messages [{role, content}] to Anthropic format.
  // Anthropic requires: system is a top-level field, messages only contain user/assistant,
  // and the first message must be role: "user".
  #convertMessages(messages) {
    let system = '';
    const converted = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Anthropic takes system as a separate param. Concatenate multiple system messages.
        system += (system ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : msg.content.map(p => p.text || '').join(''));
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        converted.push({
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : msg.content,
        });
      }
      // Skip tool/function/etc roles — not relevant for basic chat
    }

    // Anthropic requires at least one message, and it must start with user
    if (converted.length === 0) {
      converted.push({ role: 'user', content: system || 'Hello' });
      system = '';
    }

    return { system, messages: converted };
  }

  #buildRequestBody(messages, options) {
    const { system, messages: convertedMessages } = this.#convertMessages(messages);

    const body = {
      model: options.model || 'claude-sonnet-4-20250514',
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

  // Convert Anthropic response to normalized format
  #parseResponse(data, model, latencyMs) {
    // Anthropic returns content as array: [{type: "text", text: "..."}]
    let content = '';
    if (Array.isArray(data.content)) {
      content = data.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
    }

    return {
      content,
      model: data.model || model,
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
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

    const model = options.model || 'claude-sonnet-4-20250514';
    const startTime = Date.now();

    if (options.stream) {
      return this.#streamChat(messages, options, startTime);
    }

    const body = this.#buildRequestBody(messages, options);

    let response;
    try {
      response = await this.fetchWithTimeout(
        `${this.#baseUrl}/v1/messages`,
        { method: 'POST', headers: this.#buildHeaders(), body: JSON.stringify(body) },
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
    return this.#parseResponse(data, model, latencyMs);
  }

  async *#streamChat(messages, options, startTime) {
    const body = this.#buildRequestBody(messages, { ...options, stream: true });

    let response;
    try {
      response = await this.fetchWithTimeout(
        `${this.#baseUrl}/v1/messages`,
        { method: 'POST', headers: this.#buildHeaders(), body: JSON.stringify(body) },
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

    // Anthropic SSE stream uses event types:
    // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let finalModel = options.model || 'claude-sonnet-4-20250514';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7);
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);

          let data;
          try { data = JSON.parse(payload); } catch { continue; }

          switch (currentEvent || data.type) {
            case 'message_start':
              if (data.message?.model) finalModel = data.message.model;
              if (data.message?.usage?.input_tokens) {
                inputTokens = data.message.usage.input_tokens;
              }
              break;

            case 'content_block_delta':
              if (data.delta?.type === 'text_delta' && data.delta.text) {
                fullContent += data.delta.text;
                yield {
                  type: 'delta',
                  content: data.delta.text,
                  model: finalModel,
                };
              }
              break;

            case 'message_delta':
              if (data.usage?.output_tokens) {
                outputTokens = data.usage.output_tokens;
              }
              break;

            case 'message_stop':
              break;
          }
          currentEvent = '';
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

    // Anthropic doesn't have a /models endpoint, so we send a minimal message
    const startTime = Date.now();
    try {
      const response = await this.fetchWithTimeout(
        `${this.#baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: this.#buildHeaders(),
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        },
        15_000
      );
      const latencyMs = Date.now() - startTime;

      // Any response (even 400) means the API is reachable.
      // 401 means bad key, but the service is up. Only network failures = unhealthy.
      if (response.status === 401) {
        return { healthy: false, latencyMs, reason: 'Invalid API key' };
      }

      return { healthy: true, latencyMs, provider: this.name };
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - startTime, reason: err.message };
    }
  }
}
