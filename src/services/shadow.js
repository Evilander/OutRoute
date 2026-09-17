import { createBattle, addBattleEntry, getShadowSpendSince, getShadowStats } from '../db/store.js';
import { getRatings, sampleRatings, MIN_GAMES } from '../arena/ratings.js';
import { detectTaskType, estimatePromptTokens } from '../tasks.js';

const DEFAULT_RATE = 0;
const DEFAULT_BUDGET_USD = 1.0;
const MAX_PROMPT_TOKENS = 8000;
const MAX_PROMPT_CHARS = 32_000;

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map(p => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  }
  return '';
}

function transcriptOf(messages) {
  return messages.map(m => `${m.role}: ${textOf(m)}`).join('\n\n').slice(0, MAX_PROMPT_CHARS);
}

function hasNonTextContent(messages) {
  return messages.some(m => Array.isArray(m?.content) && m.content.some(part => part?.type && part.type !== 'text'));
}

function headerTruthy(value) {
  if (Array.isArray(value)) value = value[0];
  return value !== undefined && value !== null && value !== '' && value !== '0' && value !== 'false';
}

// Runs a served request's prompt against a challenger model, blind, for the
// judge to score. It is deliberately best-effort: nothing in here is allowed
// to throw into the request path or slow the response the caller is waiting on.
export class ShadowEvaluator {
  #providers;
  #router;
  #autoJudge;
  #rate;
  #budgetUsd;
  #random;
  #now;

  constructor({ providers, router, autoJudge, rate = DEFAULT_RATE, budgetUsd = DEFAULT_BUDGET_USD, random = Math.random, now = () => new Date() } = {}) {
    this.#providers = providers;
    this.#router = router;
    this.#autoJudge = autoJudge;
    this.#rate = Number.isFinite(Number(rate)) ? Math.max(0, Math.min(1, Number(rate))) : DEFAULT_RATE;
    this.#budgetUsd = Number.isFinite(Number(budgetUsd)) ? Math.max(0, Number(budgetUsd)) : DEFAULT_BUDGET_USD;
    this.#random = random;
    this.#now = now;
  }

  get enabled() {
    return this.#rate > 0;
  }

  #todayStartIso() {
    const now = this.#now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }

  stats() {
    let spentTodayUsd = 0;
    let battlesToday = 0;
    let judgedToday = 0;
    try {
      const s = getShadowStats(this.#todayStartIso());
      spentTodayUsd = s.spendUsd;
      battlesToday = s.battles;
      judgedToday = s.judged;
    } catch (err) {
      console.error('[shadow] failed to read stats:', err.message);
    }
    return { enabled: this.enabled, rate: this.#rate, budgetUsd: this.#budgetUsd, spentTodayUsd, battlesToday, judgedToday };
  }

  // Fire-and-forget: the probability draw happens synchronously (so it is not
  // delayed by anything), everything after it runs in the background.
  maybeShadow({ messages, served, options = {}, headers = {} } = {}) {
    if (!this.enabled) return;
    try {
      if (this.#random() >= this.#rate) return;
    } catch (err) {
      console.error('[shadow] random source failed:', err.message);
      return;
    }
    this.#run({ messages, served, options, headers }).catch(err => {
      console.error('[shadow] evaluation failed:', err.message);
    });
  }

  #shouldRun({ messages, served, options, headers }) {
    if (options?.tools || options?.toolChoice) return false;
    if (!Array.isArray(messages) || messages.length === 0) return false;
    if (hasNonTextContent(messages)) return false;
    if (estimatePromptTokens(messages) > MAX_PROMPT_TOKENS) return false;
    if (headerTruthy(headers?.['x-prism-no-shadow'])) return false;
    if (!served?.content) return false;
    return true;
  }

  #pickChallenger(servedModel, taskType) {
    const pool = this.#router.getPool().filter(m => {
      if (m.model === servedModel) return false;
      return m.local || (m.costPer1kInput != null && m.costPer1kOutput != null);
    });
    if (pool.length === 0) return null;

    let ratings;
    try {
      ratings = getRatings(taskType, { sources: ['human', 'judge'] });
    } catch (err) {
      console.error('[shadow] failed to load ratings:', err.message);
      return null;
    }
    const gamesOf = model => ratings.models.find(m => m.model === model)?.games ?? 0;

    const underSampled = pool.filter(m => gamesOf(m.model) < MIN_GAMES);
    if (underSampled.length > 0) {
      const min = Math.min(...underSampled.map(m => gamesOf(m.model)));
      const tied = underSampled.filter(m => gamesOf(m.model) === min);
      return tied[Math.floor(this.#random() * tied.length)];
    }

    const draw = sampleRatings(ratings, this.#random);
    if (!draw) return pool[Math.floor(this.#random() * pool.length)];

    let best = null;
    let bestValue = -Infinity;
    for (const m of pool) {
      const value = draw(m.model);
      if (value > bestValue) { bestValue = value; best = m; }
    }
    return best;
  }

  async #run({ messages, served, options, headers }) {
    if (!this.#shouldRun({ messages, served, options, headers })) return;

    let spentToday;
    try {
      spentToday = getShadowSpendSince(this.#todayStartIso());
    } catch (err) {
      console.error('[shadow] could not read today\'s spend, skipping (fail closed):', err.message);
      return;
    }
    if (spentToday >= this.#budgetUsd) return;

    const taskType = detectTaskType(messages);
    const challenger = this.#pickChallenger(served.model, taskType);
    if (!challenger) return;

    const provider = this.#providers.get(challenger.provider);
    if (!provider) return;

    let result;
    try {
      result = await provider.chat(messages, { model: challenger.model, temperature: options.temperature, maxTokens: options.maxTokens });
    } catch (err) {
      console.error(`[shadow] challenger ${challenger.provider}/${challenger.model} failed:`, err.message);
      return;
    }
    if (!result?.content) return;

    const inputTokens = result.inputTokens ?? 0;
    const outputTokens = result.outputTokens ?? 0;
    const costUsd = provider.estimateCost ? provider.estimateCost(inputTokens, outputTokens, challenger.model) : 0;

    const battleId = createBattle(transcriptOf(messages), taskType, 'shadow');
    addBattleEntry(battleId, {
      provider: served.provider, model: served.model, response: served.content,
      inputTokens: served.inputTokens || 0, outputTokens: served.outputTokens || 0,
      latencyMs: served.latencyMs || 0, costUsd: served.costUsd || 0, position: 1,
    });
    addBattleEntry(battleId, {
      provider: challenger.provider, model: challenger.model, response: result.content,
      inputTokens, outputTokens, latencyMs: result.latencyMs || 0, costUsd, position: 2,
    });

    try {
      this.#autoJudge?.enqueue?.(battleId);
    } catch (err) {
      console.error('[shadow] failed to enqueue judge:', err.message);
    }
  }
}
