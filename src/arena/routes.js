import { Router } from 'express';
import { runBattle, voteBattle, dedupeModels, isErroredEntry } from './arena.js';
import { getBattle, getRecentBattles, getEvaluation, getJudgeConsistency, getJudgeLengthBias, setBattleStatus } from '../db/store.js';
import { getLeaderboard, getRatings, judgeAgreement, MIN_GAMES } from './ratings.js';
import { initSession, streamCombatant, finalizeSession } from './streaming.js';
import { createRateLimiter } from '../proxy/server.js';
import { TASK_TYPES } from '../tasks.js';

// Starting a comparison spends money, so it is limited tightly. Voting, revealing
// and finalizing cost nothing and happen in bursts: a person votes, the page
// reveals, then polls for the judge's verdict.
const arenaLimiter = createRateLimiter(60_000, 10);
const voteLimiter = createRateLimiter(60_000, 240);

const DEFAULT_MODELS = ['gpt-6-astra', 'claude-sonnet-5', 'gemini-3.8-flash', 'claude-haiku-4-5', 'mock-balanced'];

function autoSelectModels(providers, count = 3) {
  const byProvider = [];
  for (const [name, provider] of providers) {
    if (provider.models?.length > 0) byProvider.push({ provider: name, models: [...provider.models] });
  }
  if (byProvider.length === 0) return DEFAULT_MODELS.slice(0, count);

  for (const p of byProvider) {
    for (let i = p.models.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [p.models[i], p.models[j]] = [p.models[j], p.models[i]];
    }
  }
  for (let i = byProvider.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [byProvider[i], byProvider[j]] = [byProvider[j], byProvider[i]];
  }

  const selected = [];
  let round = 0;
  while (selected.length < count) {
    let added = false;
    for (const p of byProvider) {
      if (selected.length >= count) break;
      if (round < p.models.length) {
        selected.push(p.models[round].id);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return dedupeModels(selected).slice(0, count);
}

// `|| default` would coerce an explicit 0 to the default (0 is a valid
// temperature). NaN is the only case that should fall back. Exported for
// direct unit testing of the falsy-zero edge case.
export function clampTemperature(value) {
  if (value === undefined) return 0.7;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0.7;
}

export function clampMaxTokens(value) {
  if (value === undefined) return 1024;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 1024 : Math.min(Math.max(1, n), 16384);
}

// Deduplicate before truncating to 8: slicing the raw list first can drop a
// genuinely distinct model that only appears after 8 duplicates of another.
export function parseModelList(models) {
  if (!Array.isArray(models)) return [];
  return dedupeModels(models.filter(m => typeof m === 'string' && m.length <= 100)).slice(0, 8);
}

function sendError(res, err, fallback) {
  console.error(`[arena] ${fallback}:`, err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });
}

export function createArenaRouter(providers, { autoJudge } = {}) {
  const router = Router();

  router.post('/battle', arenaLimiter, async (req, res) => {
    try {
      const { prompt, models, taskType, maxTokens, temperature } = req.body;
      if (!prompt || (typeof prompt !== 'string' && !Array.isArray(prompt))) {
        return res.status(400).json({ error: 'prompt is required (string or message array)' });
      }

      // Auto-select only when the caller named no models at all. A caller who
      // names one (or two duplicates that collapse to one) gets a 400, not a
      // silent substitution of models they didn't ask for.
      const requested = parseModelList(models);
      const selectedModels = requested.length > 0 ? requested : autoSelectModels(providers);
      if (selectedModels.length < 2) {
        return res.status(400).json({ error: 'At least 2 distinct models are required for a battle' });
      }

      const result = await runBattle(prompt, selectedModels, providers, {
        taskType: TASK_TYPES.includes(taskType) ? taskType : undefined,
        maxTokens: clampMaxTokens(maxTokens),
        temperature: clampTemperature(temperature),
      });

      // Blind: no model, provider, cost or token counts. Latency is fine, and a
      // failed combatant is flagged structurally, never via leaked "[ERROR]" text.
      const blindEntries = result.entries.map(e => ({
        id: e.entryId,
        position: e.position,
        response: e.response,
        latencyMs: e.latencyMs,
        error: e.error,
      }));

      if (autoJudge?.available && req.body.autoJudge !== false) autoJudge.enqueue(result.battleId);

      res.json({
        battleId: result.battleId,
        taskType: result.taskType,
        entries: blindEntries,
        autoJudge: autoJudge?.available ? 'queued' : 'unavailable',
      });
    } catch (err) {
      sendError(res, err, 'Battle failed');
    }
  });

  router.post('/vote', voteLimiter, (req, res) => {
    try {
      const { battleId, winnerPosition, tie } = req.body;
      const id = Number(battleId);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'battleId is required' });
      if (!tie && !Number.isInteger(winnerPosition)) {
        return res.status(400).json({ error: 'winnerPosition (or tie: true) is required' });
      }

      const result = voteBattle(id, { winnerPosition, tie: Boolean(tie) });
      res.json({ success: true, ...result });
    } catch (err) {
      sendError(res, err, 'Vote failed');
    }
  });

  router.get('/reveal/:battleId', voteLimiter, (req, res) => {
    try {
      const battleId = Number(req.params.battleId);
      if (!Number.isInteger(battleId)) return res.status(400).json({ error: 'invalid battle id' });

      const battle = getBattle(battleId);
      if (!battle) return res.status(404).json({ error: `Battle ${battleId} not found` });

      // Shadow/eval battles have no human voter to wait on, so they are always
      // revealable. An arena battle needs a vote, or an explicit forfeit.
      const origin = battle.origin || 'arena';
      if (origin === 'arena' && battle.status === 'pending') {
        if (req.query.forfeit !== '1') {
          return res.status(403).json({ error: 'Vote on this battle before revealing model identities, or pass ?forfeit=1' });
        }
        setBattleStatus(battleId, 'revealed');
        battle.status = 'revealed';
      }

      const entries = battle.entries.map(e => ({
        position: e.position,
        model: e.model,
        provider: e.provider,
        latencyMs: e.latency_ms,
        costUsd: e.cost_usd,
        isWinner: !!e.is_winner,
        error: isErroredEntry({ response: e.response }),
      }));

      const evaluation = getEvaluation(battleId);
      res.json({
        battleId,
        prompt: battle.prompt,
        taskType: battle.task_type,
        status: battle.status,
        origin,
        entries,
        ...(evaluation ? {
          judgeReasoning: evaluation.reasoning,
          judgeModel: evaluation.judge_model,
          inferredDomain: evaluation.inferred_domain,
          winnerModel: evaluation.winner_model,
        } : {}),
      });
    } catch (err) {
      sendError(res, err, 'Internal server error');
    }
  });

  router.get('/leaderboard', (req, res) => {
    try {
      const taskType = TASK_TYPES.includes(req.query.taskType) ? req.query.taskType : null;
      const sourceParam = req.query.source;
      const sources = sourceParam === 'human' ? ['human'] : sourceParam === 'judge' ? ['judge'] : ['human', 'judge'];

      const ratings = getRatings(taskType, { sources });
      res.json({
        leaderboard: getLeaderboard(taskType, { sources }),
        taskType: taskType || 'overall',
        comparisons: ratings.comparisons,
        minGames: MIN_GAMES,
      });
    } catch (err) {
      sendError(res, err, 'Internal server error');
    }
  });

  router.get('/judge', (req, res) => {
    try {
      const { pairs, longerWins } = getJudgeLengthBias();
      res.json({
        judge: autoJudge?.available ? autoJudge.judgeInfo : { provider: null, model: null },
        agreement: judgeAgreement(),
        consistency: getJudgeConsistency(),
        lengthBias: { judged: pairs, pickedLonger: longerWins, rate: pairs ? Math.round((longerWins / pairs) * 1000) / 1000 : null },
      });
    } catch (err) {
      sendError(res, err, 'Internal server error');
    }
  });

  router.get('/battles', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const battles = getRecentBattles(limit);

      const sanitized = battles.map(b => ({
        id: b.id,
        prompt: b.prompt,
        taskType: b.task_type,
        status: b.status,
        origin: b.origin,
        timestamp: b.timestamp,
        entryCount: b.entries.length,
        entries: b.entries.map(e => ({
          id: e.id,
          position: e.position,
          // Blind while pending: identity, cost and tokens only appear once a
          // battle has a verdict or has been explicitly revealed.
          model: b.status === 'pending' ? undefined : e.model,
          provider: b.status === 'pending' ? undefined : e.provider,
          latencyMs: e.latency_ms,
          costUsd: b.status === 'pending' ? undefined : e.cost_usd,
          isWinner: !!e.is_winner,
        })),
      }));

      res.json({ battles: sanitized });
    } catch (err) {
      sendError(res, err, 'Internal server error');
    }
  });

  router.post('/session', arenaLimiter, (req, res) => {
    try {
      const { prompt, models, taskType, maxTokens, temperature } = req.body;
      if (!prompt || (typeof prompt !== 'string' && !Array.isArray(prompt))) {
        return res.status(400).json({ error: 'prompt is required (string or message array)' });
      }

      const requested = parseModelList(models);
      const selectedModels = requested.length > 0 ? requested : autoSelectModels(providers);
      if (selectedModels.length < 2) {
        return res.status(400).json({ error: 'At least 2 distinct models are required' });
      }

      const session = initSession(prompt, selectedModels, providers, {
        taskType: TASK_TYPES.includes(taskType) ? taskType : undefined,
        maxTokens: clampMaxTokens(maxTokens),
        temperature: clampTemperature(temperature),
      });
      res.json(session);
    } catch (err) {
      sendError(res, err, 'Session init failed');
    }
  });

  router.get('/stream/:sessionId/:combatantId', voteLimiter, async (req, res) => {
    const { sessionId, combatantId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const controller = new AbortController();
    let aborted = false;
    req.on('close', () => {
      aborted = true;
      controller.abort();
    });

    try {
      for await (const chunk of streamCombatant(sessionId, combatantId, controller.signal)) {
        if (aborted) break;
        if (chunk.type === 'delta') {
          res.write(`data: ${JSON.stringify({ type: 'delta', content: chunk.content })}\n\n`);
        } else if (chunk.type === 'done') {
          res.write(`data: ${JSON.stringify({ type: 'done', latencyMs: chunk.latencyMs })}\n\n`);
        } else if (chunk.type === 'error') {
          res.write(`data: ${JSON.stringify({ type: 'error', message: chunk.message })}\n\n`);
        }
      }
    } catch (err) {
      if (!aborted) res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }

    if (!aborted) {
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });

  router.post('/session/:sessionId/finalize', voteLimiter, (req, res) => {
    try {
      const battleId = finalizeSession(req.params.sessionId);
      if (autoJudge?.available) autoJudge.enqueue(battleId);
      res.json({ battleId, autoJudge: autoJudge?.available ? 'queued' : 'unavailable' });
    } catch (err) {
      sendError(res, err, 'Session finalize failed');
    }
  });

  return router;
}
