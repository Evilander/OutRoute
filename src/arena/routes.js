import { Router } from 'express';
import { runBattle, voteBattle } from './arena.js';
import { getLeaderboard } from './scorer.js';
import { getBattle, getRecentBattles } from '../db/store.js';

const DEFAULT_MODELS = [
  'gpt-4o',
  'claude-sonnet-4-20250514',
  'gemini-2.0-flash',
  'llama-3.3-70b-versatile',
  'claude-haiku-4-5-20251001',
];

function autoSelectModels(providers, count = 3) {
  const available = [];
  for (const [name, provider] of providers) {
    if (provider.models) {
      for (const model of provider.models) {
        available.push(model);
      }
    }
  }
  if (available.length > 0) {
    // Shuffle and pick `count` models
    const shuffled = available.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }
  // Fallback: try defaults that might have providers
  const fallback = [];
  for (const model of DEFAULT_MODELS) {
    if (fallback.length >= count) break;
    fallback.push(model);
  }
  return fallback.slice(0, count);
}

export function createArenaRouter(providers) {
  const router = Router();

  // Start a new battle
  router.post('/battle', async (req, res) => {
    try {
      const { prompt, models, taskType, maxTokens, temperature } = req.body;

      if (!prompt || (typeof prompt !== 'string' && !Array.isArray(prompt))) {
        return res.status(400).json({ error: 'prompt is required (string or message array)' });
      }

      const selectedModels = models && models.length > 0
        ? models
        : autoSelectModels(providers);

      if (selectedModels.length < 2) {
        return res.status(400).json({ error: 'At least 2 models are required for a battle' });
      }

      const result = await runBattle(prompt, selectedModels, providers, {
        taskType: taskType || 'general',
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

      res.json({
        battleId: result.battleId,
        entries: blindEntries,
      });
    } catch (err) {
      console.error('[Arena] Battle error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Vote on a battle winner
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
      const status = err.message.includes('already been voted') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // Reveal which model produced which response
  router.get('/reveal/:battleId', (req, res) => {
    try {
      const battleId = Number(req.params.battleId);
      const battle = getBattle(battleId);

      if (!battle) {
        return res.status(404).json({ error: `Battle ${battleId} not found` });
      }

      const entries = battle.entries.map(e => ({
        position: e.position,
        model: e.model,
        provider: e.provider,
        latencyMs: e.latency_ms,
        costUsd: e.cost_usd,
        isWinner: !!e.is_winner,
      }));

      res.json({
        battleId,
        prompt: battle.prompt,
        taskType: battle.task_type,
        status: battle.status,
        entries,
      });
    } catch (err) {
      console.error('[Arena] Reveal error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Get ELO leaderboard
  router.get('/leaderboard', (req, res) => {
    try {
      const taskType = req.query.taskType || null;
      const leaderboard = getLeaderboard(taskType);
      res.json({ leaderboard });
    } catch (err) {
      console.error('[Arena] Leaderboard error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Get recent battles
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
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
