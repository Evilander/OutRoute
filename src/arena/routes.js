import { Router } from 'express';
import { runBattle, voteBattle } from './arena.js';
import { getLeaderboard } from './scorer.js';
import { getBattle, getRecentBattles, getEvaluation } from '../db/store.js';
import { initSession, getSession, streamCombatant, finalizeSession } from './streaming.js';
import { createRateLimiter } from '../proxy/server.js';

const VALID_TASK_TYPES = new Set(['general', 'code', 'creative', 'analysis', 'factual']);
const arenaLimiter = createRateLimiter(60_000, 10);

const DEFAULT_MODELS = [
  'gpt-4o',
  'claude-sonnet-4-6',
  'gemini-2.5-flash',
  'llama-3.3-70b-versatile',
  'claude-haiku-4-5-20251001',
];

function autoSelectModels(providers, count = 3) {
  // Build a pool of models grouped by provider for diversity
  const byProvider = [];
  for (const [name, provider] of providers) {
    if (provider.models && provider.models.length > 0) {
      // Pick one model per provider (cheapest/most capable heuristic: first in list)
      byProvider.push({ provider: name, models: [...provider.models] });
    }
  }

  if (byProvider.length === 0) {
    return DEFAULT_MODELS.slice(0, count);
  }

  // Round-robin across providers to maximize diversity, shuffle within each
  for (const p of byProvider) {
    for (let i = p.models.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [p.models[i], p.models[j]] = [p.models[j], p.models[i]];
    }
  }

  // Shuffle provider order for variety
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
        selected.push(p.models[round].id || p.models[round]);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }

  return selected.slice(0, count);
}

let autoJudge = null;

export function setAutoJudge(judge) {
  autoJudge = judge;
}

export function createArenaRouter(providers) {
  const router = Router();

  router.post('/battle', arenaLimiter, async (req, res) => {
    try {
      const { prompt, models, taskType, maxTokens, temperature } = req.body;
      const safeTaskType = VALID_TASK_TYPES.has(taskType) ? taskType : 'general';

      if (!prompt || (typeof prompt !== 'string' && !Array.isArray(prompt))) {
        return res.status(400).json({ error: 'prompt is required (string or message array)' });
      }

      const selectedModels = models && models.length > 0
        ? models.slice(0, 8).filter(m => typeof m === 'string' && m.length <= 100)
        : autoSelectModels(providers);

      if (selectedModels.length < 2) {
        return res.status(400).json({ error: 'At least 2 models are required for a battle' });
      }

      const result = await runBattle(prompt, selectedModels, providers, {
        taskType: safeTaskType,
        maxTokens: maxTokens || 1024,
        temperature: temperature ?? 0.7,
      });

      // Return anonymized entries (no model/provider info, just position + response)
      const blindEntries = result.entries.map(e => ({
        id: e.entryId,
        position: e.position,
        response: e.response,
        latencyMs: e.latencyMs,
        costUsd: e.cost,
        error: e.error || null,
      }));

      // Auto-judge in background if available and autoJudge is enabled
      if (autoJudge && autoJudge.available && req.body.autoJudge !== false) {
        autoJudge.enqueue(result.battleId);
      }

      res.json({
        battleId: result.battleId,
        entries: blindEntries,
        autoJudge: autoJudge?.available ? 'queued' : 'unavailable',
      });
    } catch (err) {
      console.error('[Arena] Battle error:', err.message);
      res.status(500).json({ error: 'Battle failed' });
    }
  });

  router.post('/vote', async (req, res) => {
    try {
      const { battleId, winnerPosition } = req.body;

      if (!battleId || !winnerPosition) {
        return res.status(400).json({ error: 'battleId and winnerPosition are required' });
      }

      const battle = getBattle(battleId);
      if (!battle) {
        return res.status(404).json({ error: `Battle ${battleId} not found` });
      }

      const winnerEntry = battle.entries.find(e => e.position === winnerPosition);
      if (!winnerEntry) {
        return res.status(400).json({
          error: `No entry at position ${winnerPosition} in battle ${battleId}`,
        });
      }

      const leaderboard = await voteBattle(battleId, winnerEntry.id);

      res.json({
        success: true,
        leaderboard,
      });
    } catch (err) {
      console.error('[Arena] Vote error:', err.message);
      const status = err.message?.includes('already been voted') ? 409 : 500;
      const safeMsg = status === 409 ? 'This battle has already been voted on' : 'Vote failed';
      res.status(status).json({ error: safeMsg });
    }
  });

  router.get('/reveal/:battleId', (req, res) => {
    try {
      const battleId = Number(req.params.battleId);
      const battle = getBattle(battleId);

      if (!battle) {
        return res.status(404).json({ error: `Battle ${battleId} not found` });
      }

      if (battle.status !== 'voted') {
        return res.status(403).json({ error: 'Vote on this battle before revealing model identities' });
      }

      const entries = battle.entries.map(e => ({
        position: e.position,
        model: e.model,
        provider: e.provider,
        latencyMs: e.latency_ms,
        costUsd: e.cost_usd,
        isWinner: !!e.is_winner,
      }));

      const evaluation = getEvaluation(battleId);

      res.json({
        battleId,
        prompt: battle.prompt,
        taskType: battle.task_type,
        status: battle.status,
        entries,
        ...(evaluation ? {
          judgeReasoning: evaluation.reasoning,
          judgeModel: evaluation.judge_model,
          inferredDomain: evaluation.inferred_domain,
        } : {}),
      });
    } catch (err) {
      console.error('[Arena] Reveal error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/leaderboard', (req, res) => {
    try {
      const taskType = req.query.taskType || null;
      const leaderboard = getLeaderboard(taskType);
      res.json({ leaderboard });
    } catch (err) {
      console.error('[Arena] Leaderboard error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
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
        timestamp: b.timestamp,
        entryCount: b.entries.length,
        entries: b.entries.map(e => ({
          id: e.id,
          position: e.position,
          model: b.status === 'voted' ? e.model : undefined,
          provider: b.status === 'voted' ? e.provider : undefined,
          latencyMs: e.latency_ms,
          costUsd: e.cost_usd,
          isWinner: !!e.is_winner,
        })),
      }));

      res.json({ battles: sanitized });
    } catch (err) {
      console.error('[Arena] Battles list error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/session', arenaLimiter, (req, res) => {
    try {
      const { prompt, models, taskType, maxTokens, temperature } = req.body;
      const safeTaskType = VALID_TASK_TYPES.has(taskType) ? taskType : 'general';

      if (!prompt) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      const selectedModels = models && models.length >= 2
        ? models.slice(0, 8).filter(m => typeof m === 'string' && m.length <= 100)
        : autoSelectModels(providers);

      if (selectedModels.length < 2) {
        return res.status(400).json({ error: 'At least 2 models are required' });
      }

      const session = initSession(prompt, selectedModels, providers, {
        taskType: safeTaskType,
        maxTokens: maxTokens || 1024,
        temperature: temperature ?? 0.7,
      });

      res.json(session);
    } catch (err) {
      console.error('[Arena] Session init error:', err.message);
      res.status(500).json({ error: 'Session init failed' });
    }
  });

  // Stream a single combatant's response (SSE)
  router.get('/stream/:sessionId/:combatantId', async (req, res) => {
    const { sessionId, combatantId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      for await (const chunk of streamCombatant(sessionId, combatantId)) {
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
      if (!aborted) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });

  // Finalize a streaming session (stores entries in DB, returns battleId for voting)
  router.post('/session/:sessionId/finalize', (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const battleId = finalizeSession(sessionId);

      // Auto-judge in background if available
      if (autoJudge && autoJudge.available) {
        autoJudge.enqueue(battleId);
      }

      res.json({
        battleId,
        autoJudge: autoJudge?.available ? 'queued' : 'unavailable',
      });
    } catch (err) {
      console.error('[Arena] Session finalize error:', err.message);
      res.status(500).json({ error: 'Session finalize failed' });
    }
  });

  return router;
}
