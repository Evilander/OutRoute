import { OpenAIProvider } from './openai.js';

// Prices checked 2026-09-17 against mistral.ai/pricing/api and OpenRouter's
// mistralai/ listing. Mistral's pricing page uses names (Large 3, Small 4) that
// do not match these dated slugs, and the ids have not been checked against an
// authenticated GET /v1/models. They are replaced by whatever that endpoint
// returns once a key is present; a wrong id fails loudly with a 404.
const MODELS = [
  { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5', contextWindow: 128_000, costPer1kInput: 0.0015, costPer1kOutput: 0.0075 },
  { id: 'mistral-large-2512', name: 'Mistral Large 3', contextWindow: 128_000, costPer1kInput: 0.0005, costPer1kOutput: 0.0015 },
  { id: 'mistral-small-2603', name: 'Mistral Small 4', contextWindow: 128_000, costPer1kInput: 0.00015, costPer1kOutput: 0.0006 },
  { id: 'ministral-3b-2512', name: 'Ministral 3B', contextWindow: 32_000, costPer1kInput: 0.0001, costPer1kOutput: 0.0001 },
];

export class MistralProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      // !== undefined, not ||, so an explicit empty string (force-unavailable)
      // isn't silently overridden by an env var — same fix as OpenAIProvider's
      // own base constructor already applies to its apiKey.
      apiKey: config.apiKey !== undefined ? config.apiKey : (process.env.MISTRAL_API_KEY || ''),
      baseUrl: config.baseUrl || 'https://api.mistral.ai/v1',
      providerName: 'mistral',
      models: config.models || MODELS,
    });
  }

  get name() {
    return 'mistral';
  }
}
