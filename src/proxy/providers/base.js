export class ProviderError extends Error {
  constructor(message, { provider, model, status, retryable = false, raw = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.model = model;
    this.status = status;
    this.retryable = retryable;
    this.raw = raw;
  }
}

export class BaseProvider {
  #config;

  constructor(config = {}) {
    this.#config = config;
    if (new.target === BaseProvider) {
      throw new Error('BaseProvider is abstract — extend it');
    }
  }

  get config() {
    return this.#config;
  }

  get name() {
    throw new Error(`${this.constructor.name} must implement get name()`);
  }

  get available() {
    throw new Error(`${this.constructor.name} must implement get available()`);
  }

  get models() {
    throw new Error(`${this.constructor.name} must implement get models()`);
  }

  getModel(modelId) {
    return this.models.find(m => m.id === modelId) || null;
  }

  ownsModel(modelId) {
    return this.models.some(m => m.id === modelId);
  }

  estimateCost(inputTokens, outputTokens, model) {
    const m = typeof model === 'string' ? this.getModel(model) : model;
    if (!m) return 0;
    return (inputTokens * m.costPer1kInput / 1000) + (outputTokens * m.costPer1kOutput / 1000);
  }

  async chat(_messages, _options) {
    throw new Error(`${this.constructor.name} must implement chat()`);
  }

  async healthCheck() {
    throw new Error(`${this.constructor.name} must implement healthCheck()`);
  }

  buildErrorResponse(error, model, startTime) {
    return {
      content: null,
      model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      error: {
        message: error.message,
        status: error.status || error.statusCode || 500,
        retryable: error.retryable ?? this.isRetryable(error),
      },
      raw: error.raw || null,
    };
  }

  isRetryable(error) {
    const status = error.status || error.statusCode;
    if (!status) return true;
    // 429 rate limit, 500+ server errors are retryable; 401/403/400 are not
    return status === 429 || status >= 500;
  }

  async fetchWithTimeout(url, options, timeoutMs = 60_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}
