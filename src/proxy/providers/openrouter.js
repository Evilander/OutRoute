import { OpenAIProvider } from './openai.js';
import { ProviderError } from './base.js';
import { getRegistryModels } from '../../db/store.js';

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      // Distinguish "not provided" (fall back to the env var) from an explicit
      // empty string (force unavailable) — an `||` here would let an env var
      // silently override a caller's deliberate override, same fix as base.js's
      // own OpenAIProvider constructor already makes for the base apiKey.
      apiKey: config.apiKey !== undefined ? config.apiKey : (process.env.OPENROUTER_API_KEY || ''),
      baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1',
      providerName: 'openrouter',
      models: [], // populated dynamically from the DB registry, not a fallback list
    });
  }

  get name() {
    return 'openrouter';
  }

  get models() {
    return getRegistryModels('openrouter').map(r => ({
      id: r.id,
      name: r.display_name,
      contextWindow: r.context_window,
      costPer1kInput: r.price_prompt_1k,
      costPer1kOutput: r.price_completion_1k,
    }));
  }

  getModel(modelId) {
    return this.models.find(m => m.id === modelId) || null;
  }

  ownsModel(modelId) {
    // OpenRouter model IDs contain a slash (e.g., meta-llama/llama-3-8b-instruct).
    return typeof modelId === 'string' && modelId.includes('/') && this.getModel(modelId) !== null;
  }

  buildHeaders() {
    const headers = super.buildHeaders();
    headers['HTTP-Referer'] = 'https://github.com/Evilander/prism';
    headers['X-Title'] = 'Prism';
    return headers;
  }

  buildRequestBody(messages, options, extra) {
    // Must forward `extra` ({omit}) to super — OpenAIProvider.chat()'s retry-
    // without-the-rejected-param path calls buildRequestBody(messages, opts, {omit})
    // a second time; dropping the 3rd arg here made every retry resend the exact
    // body that just 400'd, silently defeating the retry for this provider only.
    const body = super.buildRequestBody(messages, options, extra);
    // OpenRouter uses the full model ID including org prefix; never let a missing
    // options.model silently drop the field super's fallback filled in.
    body.model = options.model || body.model;
    return body;
  }

  // OpenRouter has no static fallback model (its catalog is DB-driven), so unlike
  // every other adapter, `options.model` is not optional here — without this guard
  // a caller that omits it would silently send a body with no `model` field at all.
  async chat(messages, options = {}) {
    if (!options.model) {
      throw new ProviderError('OpenRouter requires an explicit model id', {
        provider: this.name, model: options.model, status: 400, retryable: false,
      });
    }
    return super.chat(messages, options);
  }

  // The registry is kept current by ModelSyncService on its own schedule (with
  // startup backoff) — this provider doesn't duplicate that fetch itself.
  async discoverModels() {}
}
