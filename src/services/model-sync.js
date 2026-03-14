import { upsertModels, deactivateStaleModels } from '../db/store.js';

const SYNC_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

// Filter out models that are too niche or have no pricing
function isUsableModel(model) {
  if (!model.id) return false;
  if (!model.pricing) return false;
  // Skip models with no pricing data
  const prompt = parseFloat(model.pricing.prompt) || 0;
  const completion = parseFloat(model.pricing.completion) || 0;
  if (prompt === 0 && completion === 0 && !model.id.includes(':free')) return false;
  return true;
}

function mapOpenRouterModel(model) {
  const prompt = parseFloat(model.pricing?.prompt) || 0;
  const completion = parseFloat(model.pricing?.completion) || 0;

  return {
    id: model.id,
    provider: 'openrouter',
    providerModelId: model.id,
    displayName: model.name || model.id,
    contextWindow: model.context_length || 4096,
    // OpenRouter pricing is per-token, convert to per-1k-tokens
    pricePrompt1k: prompt * 1000,
    priceCompletion1k: completion * 1000,
  };
}

async function fetchOpenRouterModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API returned ${response.status}`);
    }

    const data = await response.json();
    return data.data || [];
  } finally {
    clearTimeout(timer);
  }
}

export async function syncOpenRouterModels() {
  try {
    console.log('[model-sync] Syncing OpenRouter models...');
    const rawModels = await fetchOpenRouterModels();
    const usable = rawModels.filter(isUsableModel);
    const mapped = usable.map(mapOpenRouterModel);

    if (mapped.length === 0) {
      console.warn('[model-sync] No usable models returned from OpenRouter');
      return 0;
    }

    upsertModels(mapped);

    // Deactivate models no longer in OpenRouter's list
    const activeIds = mapped.map(m => m.id);
    deactivateStaleModels('openrouter', activeIds);

    console.log(`[model-sync] Synced ${mapped.length} OpenRouter models`);
    return mapped.length;
  } catch (err) {
    console.error('[model-sync] Failed to sync OpenRouter models:', err.message);
    return 0;
  }
}

export class ModelSyncService {
  #timer = null;
  #hasApiKey = false;

  constructor() {
    this.#hasApiKey = Boolean(process.env.OPENROUTER_API_KEY);
  }

  async start() {
    if (!this.#hasApiKey) {
      console.log('[model-sync] No OPENROUTER_API_KEY — skipping model sync');
      return;
    }

    await syncOpenRouterModels();

    this.#timer = setInterval(() => {
      syncOpenRouterModels().catch(err => {
        console.error('[model-sync] Scheduled sync failed:', err.message);
      });
    }, SYNC_INTERVAL);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
