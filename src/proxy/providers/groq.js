import { OpenAIProvider } from './openai.js';

// Groq moved the Llama/Mixtral lines to Enterprise-only pricing on 2026-08-26 and
// mixtral-8x7b is long decommissioned there — this is what's left for a self-serve
// key. Prices checked 2026-09-17 (console.groq.com/docs/pricing, "starting" tier).
const MODELS = [
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B (Groq)', contextWindow: 128_000, costPer1kInput: 0.000075, costPer1kOutput: 0.0003 },
  { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B (Groq)', contextWindow: 128_000, costPer1kInput: 0.000075, costPer1kOutput: 0.0003 },
];

export class GroqProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      // !== undefined, not ||, so an explicit empty string (force-unavailable)
      // isn't silently overridden by an env var — same fix as OpenAIProvider's
      // own base constructor already applies to its apiKey.
      apiKey: config.apiKey !== undefined ? config.apiKey : (process.env.GROQ_API_KEY || ''),
      baseUrl: config.baseUrl || 'https://api.groq.com/openai/v1',
      providerName: 'groq',
      models: config.models || MODELS,
    });
  }

  get name() {
    return 'groq';
  }
}
