import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function getDb() {
  if (!db) {
    const dbPath = process.env.DB_PATH || join(__dirname, '../../prism.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);
    // Additive column migrations (safe to re-run; SQLite throws if column exists)
    for (const sql of [
      'ALTER TABLE requests ADD COLUMN routing_reason TEXT',
      'ALTER TABLE evaluations ADD COLUMN judge_consistency_score REAL',
    ]) {
      try { db.prepare(sql).run(); } catch {}
    }
  }
  return db;
}

// --- Requests ---

export function logRequest(data) {
  return getDb().prepare(`
    INSERT INTO requests (provider, model, strategy, prompt_preview, input_tokens, output_tokens, total_tokens, latency_ms, cost_usd, status, error_message, task_type, routing_reason)
    VALUES (@provider, @model, @strategy, @promptPreview, @inputTokens, @outputTokens, @totalTokens, @latencyMs, @costUsd, @status, @errorMessage, @taskType, @routingReason)
  `).run({
    routingReason: null,
    ...data,
    promptPreview: (data.promptPreview || '').slice(0, 500),
  });
}

export function getRequestStats(hours = 24) {
  const d = new Date(Date.now() - hours * 3600000);
  const since = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  return getDb().prepare(`
    SELECT
      provider,
      model,
      COUNT(*) as total_requests,
      SUM(cost_usd) as total_cost,
      AVG(latency_ms) as avg_latency,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
    FROM requests
    WHERE timestamp > ?
    GROUP BY provider, model
    ORDER BY total_requests DESC
  `).all(since);
}

export function getRecentRequests(limit = 50) {
  return getDb().prepare(
    'SELECT * FROM requests ORDER BY timestamp DESC LIMIT ?'
  ).all(limit);
}

export function getCostTimeline(hours = 24) {
  const d = new Date(Date.now() - hours * 3600000);
  const since = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  return getDb().prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00', timestamp) as bucket,
      provider,
      SUM(cost_usd) as cost,
      COUNT(*) as requests
    FROM requests
    WHERE timestamp > ?
    GROUP BY bucket, provider
    ORDER BY bucket ASC
  `).all(since);
}

// --- Battles ---

export function createBattle(prompt, taskType = 'general') {
  const result = getDb().prepare(
    'INSERT INTO battles (prompt, task_type) VALUES (?, ?)'
  ).run(prompt, taskType);
  return result.lastInsertRowid;
}

export function addBattleEntry(battleId, entry) {
  return getDb().prepare(`
    INSERT INTO battle_entries (battle_id, provider, model, response, input_tokens, output_tokens, latency_ms, cost_usd, position)
    VALUES (@battleId, @provider, @model, @response, @inputTokens, @outputTokens, @latencyMs, @costUsd, @position)
  `).run({ battleId, ...entry });
}

export function setBattleWinner(battleId, entryId) {
  const d = getDb();
  const txn = d.transaction(() => {
    d.prepare('UPDATE battle_entries SET is_winner = 0 WHERE battle_id = ?').run(battleId);
    d.prepare('UPDATE battle_entries SET is_winner = 1 WHERE id = ?').run(entryId);
    d.prepare("UPDATE battles SET status = 'voted' WHERE id = ?").run(battleId);
  });
  txn();
}

export function getBattle(battleId) {
  const battle = getDb().prepare('SELECT * FROM battles WHERE id = ?').get(battleId);
  if (!battle) return null;
  battle.entries = getDb().prepare(
    'SELECT * FROM battle_entries WHERE battle_id = ? ORDER BY position'
  ).all(battleId);
  return battle;
}

export function getRecentBattles(limit = 20) {
  const rows = getDb().prepare(`
    SELECT
      b.id AS battle_id, b.timestamp, b.prompt, b.task_type, b.status,
      e.id AS entry_id, e.provider, e.model, e.latency_ms, e.cost_usd,
      e.is_winner, e.position
    FROM battles b
    LEFT JOIN battle_entries e ON e.battle_id = b.id
    WHERE b.id IN (SELECT id FROM battles ORDER BY timestamp DESC LIMIT ?)
    ORDER BY b.timestamp DESC, e.position ASC
  `).all(limit);

  const battleMap = new Map();
  for (const row of rows) {
    if (!battleMap.has(row.battle_id)) {
      battleMap.set(row.battle_id, {
        id: row.battle_id,
        timestamp: row.timestamp,
        prompt: row.prompt,
        task_type: row.task_type,
        status: row.status,
        entries: [],
      });
    }
    if (row.entry_id != null) {
      battleMap.get(row.battle_id).entries.push({
        id: row.entry_id,
        provider: row.provider,
        model: row.model,
        latency_ms: row.latency_ms,
        cost_usd: row.cost_usd,
        is_winner: row.is_winner,
        position: row.position,
      });
    }
  }
  return [...battleMap.values()];
}

// --- ELO Ratings ---

export function getEloRating(model, taskType = 'general') {
  let rating = getDb().prepare(
    'SELECT * FROM elo_ratings WHERE model = ? AND task_type = ?'
  ).get(model, taskType);
  if (!rating) {
    getDb().prepare(
      'INSERT OR IGNORE INTO elo_ratings (model, task_type) VALUES (?, ?)'
    ).run(model, taskType);
    rating = { model, task_type: taskType, rating: 1500, wins: 0, losses: 0, battles: 0 };
  }
  return rating;
}

export function updateEloRating(model, taskType, newRating, won) {
  getDb().prepare(`
    UPDATE elo_ratings
    SET rating = ?, wins = wins + ?, losses = losses + ?, battles = battles + 1, last_updated = datetime('now')
    WHERE model = ? AND task_type = ?
  `).run(newRating, won ? 1 : 0, won ? 0 : 1, model, taskType);
}

export function getAllEloRatings() {
  return getDb().prepare(
    'SELECT * FROM elo_ratings ORDER BY rating DESC'
  ).all();
}

// --- Provider Health ---

export function updateProviderHealth(provider, status, latencyMs = null) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM provider_health WHERE provider = ?').get(provider);

  if (!existing) {
    d.prepare(`
      INSERT INTO provider_health (provider, status, last_check, last_success, consecutive_failures, avg_latency_ms)
      VALUES (?, ?, datetime('now'), datetime('now'), 0, ?)
    `).run(provider, status, latencyMs || 0);
    return;
  }

  if (status === 'healthy') {
    d.prepare(`
      UPDATE provider_health
      SET status = 'healthy', last_check = datetime('now'), last_success = datetime('now'),
          consecutive_failures = 0, avg_latency_ms = ?
      WHERE provider = ?
    `).run(latencyMs || existing.avg_latency_ms, provider);
  } else {
    d.prepare(`
      UPDATE provider_health
      SET status = ?, last_check = datetime('now'), last_failure = datetime('now'),
          consecutive_failures = consecutive_failures + 1
      WHERE provider = ?
    `).run(status, provider);
  }
}

export function getProviderHealth() {
  return getDb().prepare('SELECT * FROM provider_health').all();
}

// --- Model Registry ---

export function upsertModel(model) {
  getDb().prepare(`
    INSERT INTO model_registry (id, provider, provider_model_id, display_name, context_window, price_prompt_1k, price_completion_1k, is_active, updated_at)
    VALUES (@id, @provider, @providerModelId, @displayName, @contextWindow, @pricePrompt1k, @priceCompletion1k, 1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      display_name = @displayName,
      context_window = @contextWindow,
      price_prompt_1k = @pricePrompt1k,
      price_completion_1k = @priceCompletion1k,
      is_active = 1,
      updated_at = datetime('now')
  `).run(model);
}

export function upsertModels(models) {
  const d = getDb();
  const txn = d.transaction(() => {
    for (const model of models) {
      upsertModel(model);
    }
  });
  txn();
}

export function getRegistryModels(provider) {
  if (provider) {
    return getDb().prepare(
      'SELECT * FROM model_registry WHERE provider = ? AND is_active = 1'
    ).all(provider);
  }
  return getDb().prepare(
    'SELECT * FROM model_registry WHERE is_active = 1'
  ).all();
}

export function getRegistryModel(id) {
  return getDb().prepare(
    'SELECT * FROM model_registry WHERE id = ? AND is_active = 1'
  ).get(id);
}

export function deactivateStaleModels(provider, activeIds) {
  if (activeIds.length === 0) return;
  const placeholders = activeIds.map(() => '?').join(',');
  getDb().prepare(`
    UPDATE model_registry SET is_active = 0
    WHERE provider = ? AND id NOT IN (${placeholders})
  `).run(provider, ...activeIds);
}

// --- Evaluations ---

export function createEvaluation(data) {
  return getDb().prepare(`
    INSERT INTO evaluations (battle_id, model_a, model_b, winner_model, judge_model, inferred_domain, reasoning, is_auto)
    VALUES (@battleId, @modelA, @modelB, @winnerModel, @judgeModel, @inferredDomain, @reasoning, @isAuto)
  `).run(data);
}

export function getEvaluation(battleId) {
  return getDb().prepare(
    'SELECT * FROM evaluations WHERE battle_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(battleId);
}

export function getHealthyProviders() {
  return getDb().prepare(
    "SELECT provider FROM provider_health WHERE status = 'healthy' OR consecutive_failures < 3"
  ).all().map(r => r.provider);
}
