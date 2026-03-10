import { OpenAIProvider } from './openai.js';

const MODELS = [
  {
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B Versatile',
    contextWindow: 128_000,
    costPer1kInput: 0.00059,
    costPer1kOutput: 0.00079,
  },
  {
    id: 'llama-3.1-8b-instant',
    name: 'Llama 3.1 8B Instant',
    contextWindow: 128_000,
    costPer1kInput: 0.00005,
    costPer1kOutput: 0.00008,
  },
  {
    id: 'mixtral-8x7b-32768',
    name: 'Mixtral 8x7B',
    contextWindow: 32_768,
    costPer1kInput: 0.00024,
    costPer1kOutput: 0.00024,
  },
];

export class GroqProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      apiKey: config.apiKey || process.env.GROQ_API_KEY || '',
      baseUrl: config.baseUrl || 'https://api.groq.com/openai/v1',
      providerName: 'groq',
      models: MODELS,
    });
  }

  get name() {
    return 'groq';
  }

  get models() {
    return MODELS;
  }
}
