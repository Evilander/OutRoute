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

// Model ids that show up in a provider's own catalog but aren't chat models:
// embeddings, speech-to-text/TTS, image generation, moderation/guard, realtime
// audio, rerankers. Heuristic on the id string — provider catalogs don't all
// carry a structured modality field, so this is the common denominator.
// The last alternative is OpenAI's completion-only models. A bare "-instruct" is
// not excluded: most open-weight chat models carry it in their name.
const NON_CHAT_ID = /(embed|whisper|voxtral|speech|\btts\b|text-to-speech|audio|realtime|moderat|dall-e|imagen|-image\b|image-gen|rerank|\bclip\b|guard|turbo-instruct|davinci|babbage)/i;

export function isChatModelId(id) {
  return typeof id === 'string' && id.length > 0 && !NON_CHAT_ID.test(id);
}

// Merges a live list of model ids with a fallback metadata list: an id already
// in the fallback keeps its known name/context/price; a genuinely new id gets a
// default context window and whatever price priceFor() can find (null if none —
// never a guess).
//
// `featured` separates the curated list from everything else the provider's
// catalog happens to contain. A live catalog runs to dozens of snapshots and
// legacy models: all of them can be named or put in the arena, but the router
// only chooses among featured models and ones that have been compared.
export function mergeModelCatalog(ids, fallback, { defaultContextWindow = 128_000, priceFor } = {}) {
  const byId = new Map(fallback.map(m => [m.id, m]));
  const merged = ids.map(id => {
    const known = byId.get(id);
    if (known) return { ...known, featured: true };
    const price = priceFor ? priceFor(id) : null;
    return {
      id,
      name: id,
      contextWindow: defaultContextWindow,
      costPer1kInput: price?.input ?? null,
      costPer1kOutput: price?.output ?? null,
      featured: false,
    };
  });
  // Curated models first, in their curated order (flagship down), then the rest.
  const rank = new Map(fallback.map((m, i) => [m.id, i]));
  return merged.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
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

  // True for providers that cost nothing to call. Overridden by ollama/mock.
  get local() {
    return false;
  }

  // True once a provider knows how to translate tools/tool_choice into its own
  // wire format. Overridden by the OpenAI-compatible adapters.
  get supportsTools() {
    return false;
  }

  getModel(modelId) {
    return this.models.find(m => m.id === modelId) || null;
  }

  ownsModel(modelId) {
    return this.models.some(m => m.id === modelId);
  }

  // Refreshes `models` from the provider's own catalog. Optional, must never throw —
  // callers run this best-effort in the background and fall back to the built-in list.
  async discoverModels() {}

  // Null propagates: an unknown price is unknown, never free.
  estimateCost(inputTokens, outputTokens, model) {
    const m = typeof model === 'string' ? this.getModel(model) : model;
    if (!m || m.costPer1kInput == null || m.costPer1kOutput == null) return null;
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

  // An AbortSignal that fires on timeoutMs OR when externalSignal aborts (a client
  // disconnect), plus the teardown to call once the WHOLE exchange is done —
  // not just once headers arrive, but after the body/stream has been fully read.
  // Callers own calling clear(); that's what makes the timeout cover the body.
  createExchangeSignal(timeoutMs, externalSignal) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
      timeoutMs,
    );
    // Every non-stream and streaming chat() call shares this timer. An abandoned
    // stream (consumer never finishes the for-await-of loop) must not keep the
    // process alive for up to timeoutMs waiting on it — same reasoning already
    // applied to model-sync.js's retry timer and health/monitor.js's interval.
    timer.unref?.();
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    return {
      signal: controller.signal,
      clear: () => {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  // Bounds fetch() with createExchangeSignal(). Returns { response, clear } —
  // the caller must call clear() only after it has fully consumed the response
  // body (json() or a stream read loop), so the timeout covers the whole exchange
  // and not just time-to-headers.
  async fetchWithTimeout(url, options, timeoutMs = 60_000, externalSignal) {
    const { signal, clear } = this.createExchangeSignal(timeoutMs, externalSignal);
    try {
      const response = await fetch(url, { ...options, signal });
      return { response, clear };
    } catch (err) {
      clear();
      throw err;
    }
  }
}
