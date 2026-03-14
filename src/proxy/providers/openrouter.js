import { OpenAIProvider } from './openai.js';
import { getRegistryModels } from '../../db/store.js';

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      apiKey: config.apiKey || process.env.OPENROUTER_API_KEY || '',
      baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1',
      providerName: 'openrouter',
      models: [], // populated dynamically from DB
    });
  }

  get name() {
    return 'openrouter';
  }

  get models() {
    const rows = getRegistryModels('openrouter');
    return rows.map(r => ({
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
    // OpenRouter model IDs contain a slash (e.g., meta-llama/llama-3-8b-instruct)
    // Also check the registry directly for performance
    if (modelId.includes('/')) {
      const model = this.getModel(modelId);
      return model !== null;
    }
    return false;
  }

  buildHeaders() {
    const headers = super.buildHeaders();
    headers['HTTP-Referer'] = 'https://github.com/Evilander/prism';
    headers['X-Title'] = 'Prism';
    return headers;
  }

  buildRequestBody(messages, options) {
    const body = super.buildRequestBody(messages, options);
    // OpenRouter uses the full model ID including org prefix
    body.model = options.model;
    return body;
  }
}
