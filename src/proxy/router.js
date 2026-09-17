import { randomUUID } from 'crypto';
import {
  logRequest,
  updateRequestUsage,
  updateProviderHealth,
  getUnhealthyProviders,
  getEffectiveComparisons,
  getLatencyStats,
} from '../db/store.js';
import { detectTaskType, estimatePromptTokens } from '../tasks.js';
import { getRatings, probabilityWorse } from '../arena/ratings.js';

export const STRATEGIES = ['best', 'value', 'cheapest', 'fastest', 'round-robin'];

const PROVIDER_OPTION_KEYS = [
  'temperature', 'maxTokens', 'topP', 'stop', 'seed', 'frequencyPenalty',
  'presencePenalty', 'responseFormat', 'tools', 'toolChoice', 'timeout', 'signal',
];

const LATENCY_WINDOW_HOURS = 24;
const MAX_ATTEMPTS = 3;
// When every attempt in the sweep fails and the last one was one of these,
// the caller gets that provider's own status/message back instead of a
// generic 502 — the request really was rejected, not merely unservable.

export class PrismRoutingError extends Error {
  constructor(message, code, { status, retryable = false } = {}) {
    super(message);
    this.name = 'PrismRoutingError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map(p => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  }
  return '';
}

function promptPreviewOf(messages) {
  return textOf(messages?.[messages.length - 1]).slice(0, 200);
}

// A model's price per 1k tokens as one number strategies can compare: input and
// output blended 3:1, since most requests read far more than they write. Local
// providers cost nothing; a non-local model with either price missing is
// "unknown", never treated as free.
export function blendedCostPer1k(model) {
  if (!model) return null;
  if (model.local) return 0;
  if (model.costPer1kInput == null || model.costPer1kOutput == null) return null;
  return (model.costPer1kInput * 3 + model.costPer1kOutput) / 4;
}

// The actual dollar cost of one served request. Unknown price is null, same
// as blendedCostPer1k — a model missing either price is "unknown", never free.
function calculateCost(meta, inputTokens, outputTokens) {
  if (!meta || meta.local) return 0;
  if (meta.costPer1kInput == null || meta.costPer1kOutput == null) return null;
  const inCost = (inputTokens / 1000) * meta.costPer1kInput;
  const outCost = (outputTokens / 1000) * meta.costPer1kOutput;
  return Math.round((inCost + outCost) * 1_000_000) / 1_000_000;
}

function everyModel(providers) {
  const models = [];
  for (const [providerName, provider] of providers) {
    for (const model of provider.models) {
      models.push({
        provider: providerName,
        model: model.id,
        name: model.name || model.id,
        costPer1kInput: model.costPer1kInput ?? null,
        costPer1kOutput: model.costPer1kOutput ?? null,
        local: Boolean(provider.local),
        featured: providerName !== 'openrouter' && model.featured !== false,
      });
    }
  }
  return models;
}

// A typo in PRISM_POOL would otherwise shrink the pool, or empty it, without a
// word. Said once per distinct set of unknown ids: catalogs load after startup,
// so an id can be unknown at first and known a moment later.
const warnedPools = new Set();
function warnAboutUnknownPoolIds(poolEnv, all, pool) {
  const known = new Set(all.map(m => m.model));
  const unknown = poolEnv.filter(id => !known.has(id));
  if (unknown.length === 0) return;
  const key = unknown.join(',');
  if (warnedPools.has(key)) return;
  warnedPools.add(key);
  console.warn(`[router] PRISM_POOL names ${unknown.length === 1 ? 'a model' : 'models'} no configured provider offers: ${unknown.join(', ')}.${pool.length === 0 ? ' The routing pool is empty, so requests that do not name a model will fail.' : ''}`);
}

// The models the router chooses between. PRISM_POOL pins it. Otherwise it is each
// provider's curated models plus anything that has been compared. A live catalog
// lists every snapshot and legacy model a provider still serves (OpenAI alone
// returns about a hundred, OpenRouter several hundred): they can all be named in
// a request or entered in the arena, but the router should not pick one it has no
// reason to, and should not walk hundreds of candidates per request.
function buildPool(providers) {
  const all = everyModel(providers);

  const poolEnv = (process.env.PRISM_POOL || '').split(',').map(s => s.trim()).filter(Boolean);
  if (poolEnv.length > 0) {
    const wanted = new Set(poolEnv);
    const pool = all.filter(m => wanted.has(m.model));
    warnAboutUnknownPoolIds(poolEnv, all, pool);
    return pool;
  }

  if (all.every(m => m.featured)) return all;
  const compared = new Set();
  for (const c of getEffectiveComparisons({ sources: ['human', 'judge'] })) {
    compared.add(c.a);
    compared.add(c.b);
  }
  return all.filter(m => m.featured || compared.has(m.model));
}

// Ratings for a task type, falling back to the pooled (all task types) ratings
// when fewer than two of THIS POOL's models have enough games in that specific
// task type — the same rule "best" and "value" both use to decide what "the
// leader" means. Scoping to the pool matters: some other pool entirely (a
// different PRISM_POOL, a different provider set) may be well-rated for this
// task type without any of that being relevant to the models actually being
// routed here.
function resolveRatings(taskType, pool) {
  const poolModels = new Set(pool.map(p => p.model));
  let ratings = getRatings(taskType, { sources: ['human', 'judge'] });
  let usedTaskType = taskType;
  const ratedInPool = ratings.models.filter(m => m.rated && poolModels.has(m.model)).length;
  if (ratedInPool < 2 && taskType) {
    ratings = getRatings(null, { sources: ['human', 'judge'] });
    usedTaskType = null;
  }
  return { ratings, usedTaskType };
}

function leaderOf(ratings, pool) {
  const poolModels = new Set(pool.map(p => p.model));
  return ratings.models.find(m => m.rated && poolModels.has(m.model)) || null;
}

function rankCheapest(pool) {
  const priced = [];
  const unpriced = [];
  for (const p of pool) {
    const price = blendedCostPer1k(p);
    if (price != null) priced.push({ p, price });
    else unpriced.push(p);
  }
  priced.sort((a, b) => a.price - b.price);

  const result = priced.map(({ p, price }) => ({
    ...p,
    reason: `Cheapest available · $${price.toFixed(4)}/1k blended`,
  }));
  for (const p of unpriced) {
    result.push({ ...p, reason: 'Price unknown — not considered for cheapest' });
  }
  return result;
}

function rankFastest(pool) {
  const stats = getLatencyStats(LATENCY_WINDOW_HOURS);
  const latencyMap = new Map();
  for (const s of stats) {
    if (s.samples >= 3) latencyMap.set(`${s.provider}::${s.model}`, s.avg_latency);
  }

  const withData = [];
  const withoutData = [];
  for (const p of pool) {
    const latency = latencyMap.get(`${p.provider}::${p.model}`);
    if (latency != null) withData.push({ p, latency });
    else withoutData.push(p);
  }
  withData.sort((a, b) => a.latency - b.latency);

  const result = withData.map(({ p, latency }) => ({
    ...p,
    reason: `Fastest observed · ${Math.round(latency)}ms avg (last ${LATENCY_WINDOW_HOURS}h)`,
  }));
  for (const p of withoutData) {
    result.push({ ...p, reason: 'No latency data yet' });
  }
  return result;
}

function rankBest(pool, taskType) {
  const { ratings, usedTaskType } = resolveRatings(taskType, pool);
  const byModel = new Map(ratings.models.map(r => [r.model, r]));
  const leader = leaderOf(ratings, pool);

  if (!leader) {
    return pool.map((p, i) => ({
      ...p,
      reason: i === 0
        ? 'No rated comparisons yet — using the first pool model.'
        : 'No rated comparisons yet.',
    }));
  }

  const sorted = [...pool].sort((a, b) => {
    const ra = byModel.get(a.model);
    const rb = byModel.get(b.model);
    const aRated = Boolean(ra?.rated);
    const bRated = Boolean(rb?.rated);
    if (aRated !== bRated) return aRated ? -1 : 1;
    if (aRated) return rb.rating - ra.rating;
    return 0;
  });

  return sorted.map(p => {
    const r = byModel.get(p.model);
    if (!r?.rated) return { ...p, reason: 'Not enough comparisons yet to rate.' };
    // The leader's reason carries how sure that is: "highest rated" on five games
    // and a P(best) of 0.4 is a different claim from the same words at 0.97.
    const lead = p.model === leader.model ? `, highest rated, P(best) ${r.pBest.toFixed(2)}` : '';
    return {
      ...p,
      reason: `Rated ${Math.round(r.rating)} for ${usedTaskType || 'all tasks'} (${r.games} comparisons${lead})`,
    };
  });
}

function rankValue(pool, taskType) {
  const { ratings, usedTaskType } = resolveRatings(taskType, pool);
  const leader = leaderOf(ratings, pool);

  if (!leader) {
    return rankCheapest(pool).map(c => ({
      ...c,
      reason: `No rated comparisons yet, falling back to cheapest — ${c.reason}`,
    }));
  }

  const confidence = Number.isFinite(Number(process.env.PRISM_VALUE_CONFIDENCE))
    ? Number(process.env.PRISM_VALUE_CONFIDENCE)
    : 0.9;
  const byModel = new Map(ratings.models.map(r => [r.model, r]));

  const withinReach = [];
  const rest = [];
  for (const p of pool) {
    const r = byModel.get(p.model);
    if (r?.rated) {
      const worse = p.model === leader.model ? 0 : probabilityWorse(ratings, p.model, leader.model);
      if (worse < confidence) {
        withinReach.push({ p, worse, price: blendedCostPer1k(p) });
        continue;
      }
    }
    rest.push(p);
  }

  const priced = withinReach.filter(x => x.price != null).sort((a, b) => a.price - b.price);
  const unpriced = withinReach.filter(x => x.price == null);

  const result = [...priced, ...unpriced].map(({ p, worse, price }) => ({
    ...p,
    reason: price != null
      ? `Cheapest not shown worse than leader ${leader.model} for ${usedTaskType || 'all tasks'} (p=${worse.toFixed(2)}) · $${price.toFixed(4)}/1k blended`
      : `Not shown worse than leader ${leader.model} (p=${worse.toFixed(2)}) but price is unknown`,
  }));

  // Failover order past the contenders: rated models by rating, then the unrated.
  rest.sort((a, b) => (byModel.get(b.model)?.rated ? byModel.get(b.model).rating : -Infinity)
    - (byModel.get(a.model)?.rated ? byModel.get(a.model).rating : -Infinity));
  for (const p of rest) {
    const r = byModel.get(p.model);
    result.push({
      ...p,
      reason: r?.rated
        ? `Likely worse than leader ${leader.model} for ${usedTaskType || 'all tasks'}`
        : 'Not enough comparisons yet to rate.',
    });
  }
  return result;
}

// The strategy's first choice, then the best candidate from each other provider
// before any provider is tried twice. When a provider is down, its next model is
// usually down too, so failing over within it burns attempts.
function spreadAcrossProviders(candidates, limit) {
  const picked = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    if (seen.has(candidate.provider)) continue;
    seen.add(candidate.provider);
    picked.push(candidate);
  }
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    if (!picked.includes(candidate)) picked.push(candidate);
  }
  return picked;
}

export class Router {
  #providers;
  #roundRobinIndex = 0;

  constructor(providers) {
    this.#providers = providers;
  }

  get providers() {
    return this.#providers;
  }

  getPool() {
    return buildPool(this.#providers);
  }

  // Everything that can be named in a request, which is more than the router will
  // choose from on its own.
  getAllModels() {
    return everyModel(this.#providers);
  }

  // Exact id match first, then a match unique among prefixes. Never a substring
  // match in either direction — "gpt-4" must not silently resolve to "gpt-4o".
  findModelByName(name) {
    if (typeof name !== 'string' || !name.trim()) return null;
    const lower = name.trim().toLowerCase();
    const models = this.getAllModels();

    const exact = models.find(m => m.model.toLowerCase() === lower);
    if (exact) return exact;

    const prefixMatches = models.filter(m => m.model.toLowerCase().startsWith(lower));
    return prefixMatches.length === 1 ? prefixMatches[0] : null;
  }

  #rankRoundRobin(pool) {
    if (pool.length === 0) return [];
    const start = this.#roundRobinIndex % pool.length;
    this.#roundRobinIndex = (this.#roundRobinIndex + 1) % pool.length;
    const rotated = [...pool.slice(start), ...pool.slice(0, start)];
    return rotated.map((p, i) => ({
      ...p,
      reason: i === 0 ? 'Round-robin turn' : `Round-robin fallback (position ${i + 1})`,
    }));
  }

  // Ordered candidates for a strategy, each with a human-readable reason. Used
  // both to pick the primary model and, for the rest of the list, as the
  // failover order.
  rank(strategy, taskType = null) {
    const pool = this.getPool();
    if (pool.length === 0) return [];
    switch (strategy) {
      case 'cheapest': return rankCheapest(pool);
      case 'fastest': return rankFastest(pool);
      case 'value': return rankValue(pool, taskType);
      case 'round-robin': return this.#rankRoundRobin(pool);
      case 'best':
      default: return rankBest(pool, taskType);
    }
  }

  async route(messages, options = {}) {
    const { strategy: requestedStrategy, model: requestedModel, stream = false } = options;
    const taskType = detectTaskType(messages);
    const inputTokenEstimate = estimatePromptTokens(messages);
    const promptPreview = promptPreviewOf(messages);

    let effectiveStrategy;
    let candidates;

    if (requestedModel !== undefined) {
      if (typeof requestedModel !== 'string') {
        throw new PrismRoutingError('"model" must be a string', 'INVALID_MODEL', { status: 400 });
      }
      const found = this.findModelByName(requestedModel);
      if (!found) {
        throw new PrismRoutingError(`Model "${requestedModel}" not found in any configured provider`, 'MODEL_NOT_FOUND', { status: 404 });
      }
      // Naming a model is asking for that model. If it fails the caller gets its
      // error back, not a different model's answer under the same request.
      effectiveStrategy = 'specific';
      candidates = [{ ...found, reason: `Specific model requested: ${found.model}` }];
    } else {
      effectiveStrategy = STRATEGIES.includes(requestedStrategy)
        ? requestedStrategy
        : (STRATEGIES.includes(process.env.DEFAULT_STRATEGY) ? process.env.DEFAULT_STRATEGY : 'best');
      candidates = this.rank(effectiveStrategy, taskType);
    }

    if (candidates.length === 0) {
      throw new PrismRoutingError('No available models to route to', 'NO_MODELS_AVAILABLE', { status: 503 });
    }

    if (options.tools) {
      if (effectiveStrategy === 'specific') {
        if (!this.#providers.get(candidates[0].provider)?.supportsTools) {
          throw new PrismRoutingError(`Model "${candidates[0].model}" does not support tools`, 'TOOLS_UNSUPPORTED', { status: 400 });
        }
      } else {
        const supported = candidates.filter(c => this.#providers.get(c.provider)?.supportsTools);
        if (supported.length === 0) {
          throw new PrismRoutingError('No available models support tools', 'TOOLS_UNSUPPORTED', { status: 400 });
        }
        candidates = supported;
      }
    }

    // Providers with a run of failures go to the back of the queue rather than out
    // of it: if everything healthy fails, a struggling provider is still worth a try.
    const unhealthy = new Set(getUnhealthyProviders());
    const ordered = effectiveStrategy === 'specific'
      ? candidates
      : [...candidates.filter(c => !unhealthy.has(c.provider)), ...candidates.filter(c => unhealthy.has(c.provider))];
    const attempts = spreadAcrossProviders(ordered, MAX_ATTEMPTS);
    const primary = attempts[0];

    const abandonedProviders = new Set();
    let lastError = null;

    for (const attempt of attempts) {
      // A client that already left is not worth failing over for — that would
      // just spend more provider calls nobody will ever read the result of.
      if (options.signal?.aborted) {
        throw new PrismRoutingError('Request aborted by client', 'ABORTED', { status: 499, retryable: false });
      }
      if (abandonedProviders.has(attempt.provider)) continue;
      const provider = this.#providers.get(attempt.provider);
      if (!provider) continue;

      const startedAt = Date.now();
      const providerOpts = { model: attempt.model, stream };
      for (const key of PROVIDER_OPTION_KEYS) {
        if (options[key] !== undefined) providerOpts[key] = options[key];
      }

      try {
        // Awaited here (not `return this.#attempt...(...)`) so a rejection is
        // caught by this loop's catch and can fail over — returning a promise
        // unawaited would let it reject after route() had already returned.
        if (stream) {
          return await this.#attemptStream({ provider, attempt, messages, providerOpts, startedAt, effectiveStrategy, routingReason: attempt.reason, taskType, promptPreview, inputTokenEstimate, isFailover: attempt !== primary, primaryModel: primary.model });
        }
        return await this.#attemptOnce({ provider, attempt, messages, providerOpts, startedAt, effectiveStrategy, routingReason: attempt.reason, taskType, promptPreview, inputTokenEstimate, isFailover: attempt !== primary, primaryModel: primary.model });
      } catch (err) {
        const latencyMs = Date.now() - startedAt;

        // The provider merges our signal into its own fetch controller, so an
        // in-flight call rejects the moment the client disconnects. That is
        // not a provider fault — recording it as one would let three ordinary
        // client disconnects mark a perfectly healthy provider unhealthy for
        // every other caller. Nothing here is worth logging or failing over
        // for either, per the same reasoning as the pre-attempt check above.
        if (options.signal?.aborted) {
          throw new PrismRoutingError('Request aborted by client', 'ABORTED', { status: 499, retryable: false });
        }

        lastError = err;
        console.error(`[router] ${attempt.provider}/${attempt.model} failed:`, err.message);

        try {
          logRequest({
            provider: attempt.provider, model: attempt.model, strategy: effectiveStrategy, promptPreview,
            inputTokens: inputTokenEstimate, outputTokens: 0, totalTokens: inputTokenEstimate, latencyMs,
            costUsd: 0, status: 'error', errorMessage: (err.message || '').slice(0, 500), taskType, routingReason: null,
          });
        } catch (logErr) {
          console.error('[router] failed to log error:', logErr.message);
        }
        try { updateProviderHealth(attempt.provider, 'degraded', latencyMs); } catch { /* non-fatal */ }

        // A non-retryable error (bad key, malformed request, ...) rules out
        // this provider, not the whole sweep — skip it and let a different
        // candidate, possibly on a healthy provider, take the next attempt.
        const retryable = err.retryable ?? true;
        if (!retryable) abandonedProviders.add(attempt.provider);
      }
    }

    // A 4xx from the last provider tried is the caller's to see: a retired model
    // (404), a bad request (400), a rate limit (429). Anything else is a 502.
    const upstream = lastError?.status;
    const clientError = upstream >= 400 && upstream < 500;
    throw new PrismRoutingError(
      clientError ? lastError.message : `All providers failed. Last error: ${lastError?.message || 'unknown'}`,
      clientError ? 'UPSTREAM_CLIENT_ERROR' : 'ALL_PROVIDERS_FAILED',
      { status: clientError ? upstream : undefined },
    );
  }

  async #attemptOnce({ provider, attempt, messages, providerOpts, startedAt, effectiveStrategy, routingReason, taskType, promptPreview, inputTokenEstimate, isFailover, primaryModel }) {
    const result = await provider.chat(messages, providerOpts);
    const latencyMs = Date.now() - startedAt;
    const inTok = result.inputTokens ?? inputTokenEstimate;
    const outTok = result.outputTokens ?? 0;
    const costUsd = calculateCost(attempt, inTok, outTok);

    const requestId = logRequest({
      provider: attempt.provider, model: attempt.model, strategy: effectiveStrategy, promptPreview,
      inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok, latencyMs, costUsd,
      status: 'ok', errorMessage: null, taskType,
      routingReason: isFailover ? `Failover from ${primaryModel}: ${routingReason}` : routingReason,
    });
    try { updateProviderHealth(attempt.provider, 'healthy', latencyMs); } catch { /* non-fatal */ }

    const message = result.message || { role: 'assistant', content: result.content || '' };

    return {
      id: `prism-${randomUUID()}`,
      requestId,
      object: 'chat.completion',
      model: attempt.model,
      content: result.content ?? '',
      message,
      finishReason: result.finishReason || 'stop',
      usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
      prism: {
        provider: attempt.provider,
        strategy: effectiveStrategy,
        routing_reason: isFailover ? `Failover from ${primaryModel}: ${routingReason}` : routingReason,
        latency_ms: latencyMs,
        cost_usd: costUsd,
        task_type: taskType,
        failover: isFailover,
        original_model: isFailover ? primaryModel : undefined,
      },
    };
  }

  // Pulling the first chunk here, before route() returns, is what lets a dead
  // connection fail over to the next candidate instead of surfacing mid-stream
  // to a client that already has bytes on the wire.
  async #attemptStream({ provider, attempt, messages, providerOpts, startedAt, effectiveStrategy, routingReason, taskType, promptPreview, inputTokenEstimate, isFailover, primaryModel }) {
    // provider.chat() is itself async, so even when it hands back an async
    // generator, the call returns a promise of one — it must be awaited before
    // anything can call .next() on it.
    const rawGen = await provider.chat(messages, { ...providerOpts, stream: true });
    if (!rawGen || typeof rawGen.next !== 'function') {
      const err = new Error('Provider did not return a stream');
      err.retryable = true;
      throw err;
    }

    const first = await rawGen.next();
    if (first.done) {
      const err = new Error('Provider stream ended with no data');
      err.retryable = true;
      throw err;
    }
    const firstChunk = first.value;

    const requestId = logRequest({
      provider: attempt.provider, model: attempt.model, strategy: effectiveStrategy, promptPreview,
      inputTokens: inputTokenEstimate, outputTokens: 0, totalTokens: inputTokenEstimate, latencyMs: 0,
      costUsd: 0, status: 'ok', errorMessage: null, taskType,
      routingReason: isFailover ? `Failover from ${primaryModel}: ${routingReason}` : routingReason,
    });
    try { updateProviderHealth(attempt.provider, 'healthy', Date.now() - startedAt); } catch { /* non-fatal */ }

    return {
      id: `prism-${randomUUID()}`,
      requestId,
      object: 'chat.completion.chunk',
      model: attempt.model,
      stream: driveStream({ rawGen, firstChunk, requestId, startedAt, meta: attempt, inputTokenEstimate }),
      prism: {
        provider: attempt.provider,
        strategy: effectiveStrategy,
        routing_reason: isFailover ? `Failover from ${primaryModel}: ${routingReason}` : routingReason,
        task_type: taskType,
        failover: isFailover,
        original_model: isFailover ? primaryModel : undefined,
      },
    };
  }
}

// Yields the pre-fetched first chunk, then drains the provider's generator.
// The 'done' chunk is augmented with costUsd so the server can report it
// without duplicating pricing logic, and updateRequestUsage always runs —
// on a clean end, an upstream error, or the consumer breaking out early.
async function* driveStream({ rawGen, firstChunk, requestId, startedAt, meta, inputTokenEstimate }) {
  let inputTokens = inputTokenEstimate;
  let outputTokens = 0;
  let sawDone = false;
  const record = chunk => {
    if (chunk.type !== 'done') return;
    sawDone = true;
    if (chunk.inputTokens != null) inputTokens = chunk.inputTokens;
    if (chunk.outputTokens != null) outputTokens = chunk.outputTokens;
    chunk.costUsd = calculateCost(meta, inputTokens, outputTokens);
  };

  try {
    record(firstChunk);
    yield firstChunk;
    while (true) {
      const { done, value } = await rawGen.next();
      if (done) break;
      record(value);
      yield value;
    }
    if (!sawDone) {
      // The generator ended cleanly (no thrown error) but never emitted the
      // contractual 'done' event — an upstream connection drop after the last
      // delta looks exactly like this. Surfacing it as a stream error, same as
      // a thrown one, stops the server from reporting finish_reason: 'stop'
      // for content that may be truncated, and keeps shadow from evaluating it.
      throw new Error('Provider stream ended without a done event');
    }
  } finally {
    const latencyMs = Date.now() - startedAt;
    const costUsd = calculateCost(meta, inputTokens, outputTokens);
    try {
      updateRequestUsage(requestId, { outputTokens, totalTokens: inputTokens + outputTokens, costUsd, latencyMs });
    } catch (err) {
      console.error('[router] failed to record stream usage:', err.message);
    }
  }
}
