import { upsertModels, deactivateStaleModels } from '../db/store.js';
import { getOpenRouterCatalog } from '../proxy/providers/pricing.js';
import { isChatModelId } from '../proxy/providers/base.js';

const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours once a sync has actually landed models
// Backoff after a startup sync that returns zero models, instead of waiting the
// full 12h interval for the next attempt: 30s, 2m, 10m, then settle at 30m.
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

// A missing or unparsable price is null, not 0. The registry's price columns are
// nullable for this reason: null means unknown, and 0 means the model is free.
function parsePrice(raw) {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function isUsableModel(model) {
  if (!model.id) return false;
  if (model.id.includes(':batch')) return false; // same model as the base entry, priced differently
  if (!isChatModelId(model.id)) return false;
  if (!model.pricing) return false;
  const prompt = parsePrice(model.pricing.prompt);
  const completion = parsePrice(model.pricing.completion);
  // Both fields explicitly parse to 0 (not just missing) and it's not a declared
  // free variant: OpenRouter occasionally lists dead/placeholder entries this way.
  if (prompt === 0 && completion === 0 && !model.id.includes(':free')) return false;
  return true;
}

function mapOpenRouterModel(model) {
  const prompt = parsePrice(model.pricing?.prompt);
  const completion = parsePrice(model.pricing?.completion);

  return {
    id: model.id,
    provider: 'openrouter',
    providerModelId: model.id,
    displayName: model.name || model.id,
    contextWindow: model.context_length || 4096,
    // OpenRouter pricing is per-token; the registry's convention is per-1k.
    // A field that didn't parse stays null (unknown), never becomes a fabricated 0.
    pricePrompt1k: prompt === null ? null : prompt * 1000,
    priceCompletion1k: completion === null ? null : completion * 1000,
  };
}

// Reuses pricing.js's OpenRouter fetch (and its in-memory cache) instead of
// making a second, separate HTTP call to the same endpoint.
export async function syncOpenRouterModels() {
  try {
    console.log('[model-sync] Syncing OpenRouter models...');
    const rawModels = await getOpenRouterCatalog({ force: true });
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
  #retryIndex = 0;
  #retryDelaysMs;
  #intervalMs;

  // retryDelaysMs/intervalMs are only ever overridden by tests; production code
  // always calls `new ModelSyncService()`.
  constructor({ retryDelaysMs = RETRY_DELAYS_MS, intervalMs = SYNC_INTERVAL_MS } = {}) {
    this.#hasApiKey = Boolean(process.env.OPENROUTER_API_KEY);
    this.#retryDelaysMs = retryDelaysMs;
    this.#intervalMs = intervalMs;
  }

  async start() {
    if (!this.#hasApiKey) {
      console.log('[model-sync] No OPENROUTER_API_KEY — skipping model sync');
      return;
    }
    await this.#syncAndSchedule();
  }

  async #syncAndSchedule() {
    const count = await syncOpenRouterModels();
    if (count > 0) {
      this.#retryIndex = 0;
      this.#scheduleNext(this.#intervalMs);
    } else {
      const delay = this.#retryDelaysMs[Math.min(this.#retryIndex, this.#retryDelaysMs.length - 1)];
      this.#retryIndex++;
      console.warn(`[model-sync] sync returned no models, retrying in ${Math.round(delay / 1000)}s`);
      this.#scheduleNext(delay);
    }
  }

  #scheduleNext(delayMs) {
    this.#timer = setTimeout(() => {
      this.#syncAndSchedule().catch(err => console.error('[model-sync] scheduled sync failed:', err.message));
    }, delayMs);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
