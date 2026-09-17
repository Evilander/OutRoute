// Single price source for every provider adapter and the OpenRouter model-registry
// sync. OpenRouter's public catalog needs no key and its prices cross-validate
// against every first-party pricing page checked during research (2026-09-17), so
// one fetch here backs both a keyed provider's discoverModels() and model-sync.js.

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000; // prices don't move minute to minute

let cache = null; // { fetchedAt, bySlug: Map<normalizedSlug, {input, output}>, raw }
let inflight = null;

// Native model id -> the key we match against an OpenRouter slug. Conservative on
// purpose: strip the "org/" prefix, drop a ":batch"/":free" variant suffix (it's a
// different price than the base entry), drop a trailing YYYYMMDD date snapshot,
// then treat '.', '-', '_' as equivalent. A miss means price null, never a guess.
//
// Only an exact 8-digit run is treated as a date. A wider \d{4,8} match (an earlier
// version of this function) also caught ordinary context-window suffixes like
// "-8192" or "-4096" (e.g. llama3-70b-8192 vs llama3-70b-4096), collapsing two
// distinctly-priced models onto the same slug and returning one's price for the
// other with no error. That's worse than the miss this function is built to accept.
export function normalizeSlug(id) {
  if (!id) return '';
  let s = String(id).toLowerCase();
  if (s.startsWith('~')) s = s.slice(1);
  s = s.replace(/^[^/]+\//, '');
  s = s.replace(/:.*$/, '');
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/[.\-_]/g, '');
  return s;
}

async function fetchRaw() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`OpenRouter models fetch failed: HTTP ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.data) ? data.data : [];
  } finally {
    clearTimeout(timer);
  }
}

// Fetches (or reuses a cached) OpenRouter catalog. Concurrent callers share one
// in-flight request, so a provider's discoverModels() racing the OpenRouter sync
// at startup never fires two network calls.
export async function getOpenRouterCatalog({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.raw;
  if (!inflight) {
    inflight = fetchRaw()
      .then(raw => {
        const bySlug = new Map();
        for (const model of raw) {
          // A ":batch"/":free" id is the same model at a different price; skip it
          // so the base (standard-priced) entry is the one we index.
          if (!model?.id || model.id.includes(':')) continue;
          const prompt = Number.parseFloat(model.pricing?.prompt);
          const completion = Number.parseFloat(model.pricing?.completion);
          if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
          // OpenRouter prices are USD per single token; the codebase's convention is per-1k.
          bySlug.set(normalizeSlug(model.id), { input: prompt * 1000, output: completion * 1000 });
        }
        cache = { fetchedAt: Date.now(), bySlug, raw };
        return raw;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function priceFor(nativeId) {
  await getOpenRouterCatalog();
  return priceForSync(nativeId);
}

// Synchronous lookup against whatever is currently cached. Used once a caller has
// already primed the cache with getOpenRouterCatalog() and just needs per-id prices.
export function priceForSync(nativeId) {
  if (!cache) return null;
  return cache.bySlug.get(normalizeSlug(nativeId)) || null;
}

export function clearPriceCache() {
  cache = null;
  inflight = null;
}
