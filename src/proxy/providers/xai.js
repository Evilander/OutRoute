import { OpenAIProvider } from './openai.js';
import { isChatModelId } from './base.js';

// Prices checked 2026-09-17 (docs.x.ai/docs/models). Tiered by context length on
// xAI's own pricing page; these are the base (<200K) rates.
const MODELS = [
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 200_000, costPer1kInput: 0.002, costPer1kOutput: 0.006 },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 200_000, costPer1kInput: 0.002, costPer1kOutput: 0.006 },
  { id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 128_000, costPer1kInput: 0.00125, costPer1kOutput: 0.0025 },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1', contextWindow: 128_000, costPer1kInput: 0.001, costPer1kOutput: 0.002 },
];

// xAI's own price fields, in integer USD-cents per 100,000,000 tokens ($/1M = raw/10,000).
function xaiPricePer1k(raw) {
  return typeof raw === 'number' ? raw / 10_000_000 : null;
}

export class XAIProvider extends OpenAIProvider {
  constructor(config = {}) {
    super({
      ...config,
      // !== undefined, not ||, so an explicit empty string (force-unavailable)
      // isn't silently overridden by an env var — same fix as OpenAIProvider's
      // own base constructor already applies to its apiKey.
      apiKey: config.apiKey !== undefined ? config.apiKey : (process.env.XAI_API_KEY || ''),
      baseUrl: config.baseUrl || 'https://api.x.ai/v1',
      providerName: 'xai',
      models: config.models || MODELS,
    });
  }

  get name() {
    return 'xai';
  }

  // xAI's /v1/models embeds its own per-token prices — more authoritative than the
  // OpenRouter cross-reference every other adapter's discoverModels() falls back on.
  async discoverModels() {
    if (!this.available) return;
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.baseUrl}/models`, { method: 'GET', headers: this.buildHeaders() }, 15_000);
      let rows;
      try {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        rows = (data.data || []).filter(m => isChatModelId(m.id));
      } finally {
        clear();
      }
      if (rows.length === 0) throw new Error('no chat models returned');

      const known = new Map(this.models.map(m => [m.id, m]));
      const list = rows.map(m => {
        const fallback = known.get(m.id);
        const input = xaiPricePer1k(m.prompt_text_token_price);
        const output = xaiPricePer1k(m.completion_text_token_price);
        return {
          id: m.id,
          name: fallback?.name || m.id,
          contextWindow: fallback?.contextWindow || 128_000,
          costPer1kInput: input ?? fallback?.costPer1kInput ?? null,
          costPer1kOutput: output ?? fallback?.costPer1kOutput ?? null,
          // `known` is the curated list on the first run and the previous discovery
          // after that, so the flag has to be carried forward rather than recomputed.
          featured: fallback ? fallback.featured !== false : false,
        };
      }).sort((a, b) => Number(b.featured) - Number(a.featured));
      this.setDiscoveredModels(list);
    } catch (err) {
      console.error('[xai] model discovery failed, keeping fallback list:', err.message);
    }
  }
}
