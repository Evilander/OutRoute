import { BaseProvider, ProviderError } from './base.js';

const MODELS = [
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    contextWindow: 1_000_000,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    contextWindow: 2_000_000,
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.005,
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    contextWindow: 1_000_000,
    costPer1kInput: 0.000075,
    costPer1kOutput: 0.0003,
  },
];

export class GoogleProvider extends BaseProvider {
  #apiKey;
  #baseUrl;

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
    return MODELS;
  }

  // Convert OpenAI-style messages to Gemini format:
  // {contents: [{role: "user"|"model", parts: [{text: "..."}]}], systemInstruction: ...}
  #convertMessages(messages) {
    let systemText = '';
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText += (systemText ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : msg.content.map(p => p.text || '').join(''));
        continue;
      }

      // Gemini uses "model" instead of "assistant"
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const text = typeof msg.content === 'string' ? msg.content : msg.content.map(p => p.text || '').join('');

      // Gemini requires alternating user/model turns. If we have consecutive same-role
      // messages, merge them.
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push({ text });
      } else {
        contents.push({ role, parts: [{ text }] });
      }
    }

    // Gemini requires contents to start with "user" role. If it starts with "model",
    // prepend a synthetic user turn.
    if (contents.length > 0 && contents[0].role === 'model') {
      contents.unshift({ role: 'user', parts: [{ text: '.' }] });
    }

    // Gemini requires at least one content entry
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: systemText || 'Hello' }] });
      systemText = '';
    }

    return { systemText, contents };
  }

  #buildRequestBody(messages, options) {
    const { systemText, contents } = this.#convertMessages(messages);

    const body = { contents };

    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

    const generationConfig = {};
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
    if (options.topP !== undefined) generationConfig.topP = options.topP;
    if (options.topK !== undefined) generationConfig.topK = options.topK;
    if (options.stop !== undefined) {
      generationConfig.stopSequences = Array.isArray(options.stop) ? options.stop : [options.stop];
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    return body;
  }

  #parseResponse(data, model, latencyMs) {
    const candidate = data.candidates?.[0];

    // Check for blocked/filtered responses
    if (!candidate) {
      const blockReason = data.promptFeedback?.blockReason;
      return {
        content: '',
        model,
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: 0,
        latencyMs,
        raw: data,
        error: blockReason ? { message: `Response blocked: ${blockReason}`, status: 400, retryable: false } : undefined,
      };
    }

    // Check finish reason for safety filtering
    if (candidate.finishReason === 'SAFETY') {
      return {
        content: '',
        model,
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
        latencyMs,
        raw: data,
        error: { message: 'Response filtered by safety settings', status: 400, retryable: false },
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

    const model = options.model || 'gemini-2.5-flash';
    const startTime = Date.now();

    if (options.stream) {
      return this.#streamChat(messages, options, startTime);
    }

    const body = this.#buildRequestBody(messages, options);
    const url = `${this.#baseUrl}/models/${model}:generateContent?key=${this.#apiKey}`;

    let response;
    try {
      response = await this.fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
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
    const model = options.model || 'gemini-2.5-flash';
    const body = this.#buildRequestBody(messages, options);
    const url = `${this.#baseUrl}/models/${model}:streamGenerateContent?key=${this.#apiKey}&alt=sse`;

    let response;
    try {
      response = await this.fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
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
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);

          let data;
          try { data = JSON.parse(payload); } catch { continue; }

          const candidate = data.candidates?.[0];
          if (candidate?.content?.parts) {
            const text = candidate.content.parts
              .filter(p => p.text !== undefined)
              .map(p => p.text)
              .join('');
            if (text) {
              fullContent += text;
              yield {
                type: 'delta',
                content: text,
                model,
              };
            }
          }

          if (data.usageMetadata) {
            inputTokens = data.usageMetadata.promptTokenCount || inputTokens;
            outputTokens = data.usageMetadata.candidatesTokenCount || outputTokens;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: 'done',
      content: fullContent,
      model,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startTime,
    };
  }

  async healthCheck() {
    if (!this.available) return { healthy: false, reason: 'API key not configured' };

    const startTime = Date.now();
    try {
      // Use the models list endpoint for a lightweight health check
      const response = await this.fetchWithTimeout(
        `${this.#baseUrl}/models?key=${this.#apiKey}`,
        { method: 'GET' },
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
