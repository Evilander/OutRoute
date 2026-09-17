import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizeTaskType } from '../tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function getDb() {
  if (!db) {
    const dbPath = process.env.DB_PATH || join(__dirname, '../../prism.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(readSchema());
    migrate(db);
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

function readSchema() {
  return readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
}

function sqliteTime(iso) {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '');
}

function hoursAgo(hours) {
  return sqliteTime(new Date(Date.now() - hours * 3600000).toISOString());
}

// PRAGMA takes no bound parameters, so the table name is interpolated. Callers
// pass literals; the check keeps it that way.
function hasColumn(d, table, column) {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`unexpected table name: ${table}`);
  return d.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// schema.sql only creates what is missing, so databases written by older
// versions are brought forward here, guarded by PRAGMA user_version.
function migrate(d) {
  if (d.pragma('user_version', { simple: true }) >= 1) return;

  d.transaction(() => {
    const additions = [
      ['requests', 'routing_reason', 'TEXT'],
      ['battles', 'origin', "TEXT DEFAULT 'arena'"],
      ['evaluations', 'judge_consistency_score', 'REAL'],
      ['evaluations', 'cost_usd', 'REAL DEFAULT 0'],
    ];
    for (const [table, column, type] of additions) {
      if (!hasColumn(d, table, column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }

    // model_registry is a cache of upstream catalogs. It used to declare prices
    // NOT NULL DEFAULT 0, which made an unknown price look like a free model.
    const price = d.prepare('PRAGMA table_info(model_registry)').all().find(c => c.name === 'price_prompt_1k');
    if (price?.notnull) {
      d.exec('DROP TABLE model_registry');
      d.exec(readSchema());
    }

    backfillComparisons(d);
    d.pragma('user_version = 1');
  })();
}

// Older versions kept only a running Elo number per model. The battles table
// still records who won each battle, so the comparison log is rebuilt from it.
function backfillComparisons(d) {
  if (d.prepare('SELECT COUNT(*) AS c FROM comparisons').get().c > 0) return;

  const decided = d.prepare(`
    SELECT b.id, b.task_type, b.timestamp,
      (SELECT judge_model FROM evaluations WHERE battle_id = b.id AND is_auto = 1 ORDER BY id DESC LIMIT 1) AS judge_model,
      (SELECT inferred_domain FROM evaluations WHERE battle_id = b.id AND is_auto = 1 ORDER BY id DESC LIMIT 1) AS judge_domain
    FROM battles b WHERE b.status = 'voted'
  `).all();
  const entriesFor = d.prepare('SELECT model, response, is_winner FROM battle_entries WHERE battle_id = ? ORDER BY position');
  const insert = d.prepare(`
    INSERT INTO comparisons (battle_id, model_a, model_b, outcome, task_type, source, judge_model, created_at)
    VALUES (?, ?, ?, 'a', ?, ?, ?, ?)
  `);

  for (const battle of decided) {
    const entries = entriesFor.all(battle.id).filter(e => e.response && !e.response.startsWith('[ERROR]'));
    const winner = entries.find(e => e.is_winner);
    if (!winner) continue;
    const source = battle.judge_model ? 'judge' : 'human';
    const taskType = normalizeTaskType(battle.judge_model ? battle.judge_domain : battle.task_type);
    for (const loser of entries) {
      if (loser === winner || loser.model === winner.model) continue;
      insert.run(battle.id, winner.model, loser.model, taskType, source, battle.judge_model, battle.timestamp);
    }
  }
}

// --- Requests ---

// Returns the new row's id, which a streamed request needs for updateRequestUsage.
export function logRequest(data) {
  const result = getDb().prepare(`
    INSERT INTO requests (provider, model, strategy, prompt_preview, input_tokens, output_tokens, total_tokens, latency_ms, cost_usd, status, error_message, task_type, routing_reason)
    VALUES (@provider, @model, @strategy, @promptPreview, @inputTokens, @outputTokens, @totalTokens, @latencyMs, @costUsd, @status, @errorMessage, @taskType, @routingReason)
  `).run({
    routingReason: null,
    ...data,
    promptPreview: (data.promptPreview || '').slice(0, 500),
  });
  return Number(result.lastInsertRowid);
}

// Streamed responses are logged before the body exists; usage is filled in once the stream ends.
export function updateRequestUsage(requestId, { outputTokens, totalTokens, costUsd, latencyMs }) {
  getDb().prepare(`
    UPDATE requests SET output_tokens = ?, total_tokens = ?, cost_usd = ?, latency_ms = ? WHERE id = ?
  `).run(outputTokens, totalTokens, costUsd, latencyMs, requestId);
}

export function getRequestStats(hours = 24) {
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
  `).all(hoursAgo(hours));
}

// Latency of successful calls only. A provider that fails in 40ms is not fast.
export function getLatencyStats(hours = 24) {
  return getDb().prepare(`
    SELECT provider, model, COUNT(*) AS samples, AVG(latency_ms) AS avg_latency
    FROM requests
    WHERE timestamp > ? AND status = 'ok'
    GROUP BY provider, model
  `).all(hoursAgo(hours));
}

export function getRecentRequests(limit = 50) {
  return getDb().prepare(
    'SELECT * FROM requests ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

// --- Battles ---

export function createBattle(prompt, taskType = 'general', origin = 'arena') {
  const result = getDb().prepare(
    'INSERT INTO battles (prompt, task_type, origin) VALUES (?, ?, ?)'
  ).run(prompt, taskType, origin);
  return result.lastInsertRowid;
}

export function addBattleEntry(battleId, entry) {
  return getDb().prepare(`
    INSERT INTO battle_entries (battle_id, provider, model, response, input_tokens, output_tokens, latency_ms, cost_usd, position)
    VALUES (@battleId, @provider, @model, @response, @inputTokens, @outputTokens, @latencyMs, @costUsd, @position)
  `).run({ battleId, ...entry });
}

// entryId null closes the battle as a tie: no entry is flagged as the winner.
export function setBattleWinner(battleId, entryId) {
  const d = getDb();
  const txn = d.transaction(() => {
    d.prepare('UPDATE battle_entries SET is_winner = 0 WHERE battle_id = ?').run(battleId);
    if (entryId != null) {
      d.prepare('UPDATE battle_entries SET is_winner = 1 WHERE id = ? AND battle_id = ?').run(entryId, battleId);
    }
    d.prepare("UPDATE battles SET status = 'voted' WHERE id = ?").run(battleId);
  });
  txn();
}

export function setBattleStatus(battleId, status) {
  getDb().prepare('UPDATE battles SET status = ? WHERE id = ?').run(status, battleId);
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
      b.id AS battle_id, b.timestamp, b.prompt, b.task_type, b.status, b.origin,
      e.id AS entry_id, e.provider, e.model, e.latency_ms, e.cost_usd,
      e.is_winner, e.position
    FROM battles b
    LEFT JOIN battle_entries e ON e.battle_id = b.id
    WHERE b.id IN (SELECT id FROM battles ORDER BY id DESC LIMIT ?)
    ORDER BY b.id DESC, e.position ASC
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
        origin: row.origin || 'arena',
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

// --- Comparisons ---

export function addComparison(data) {
  return getDb().prepare(`
    INSERT INTO comparisons (battle_id, model_a, model_b, outcome, task_type, source, judge_model, consistent)
    VALUES (@battleId, @modelA, @modelB, @outcome, @taskType, @source, @judgeModel, @consistent)
  `).run({ battleId: null, judgeModel: null, consistent: null, taskType: 'general', ...data });
}

// The comparisons ratings are fitted on. Where a person and the judge both ruled
// on a battle, the person's verdict stands and the judge's rows are left out.
export function getEffectiveComparisons({ taskType = null, sources = ['human', 'judge'] } = {}) {
  const wanted = sources.filter(s => s === 'human' || s === 'judge');
  if (wanted.length === 0) return [];

  const clauses = [`c.source IN (${wanted.map(() => '?').join(',')})`];
  const params = [...wanted];
  if (taskType) {
    clauses.push('c.task_type = ?');
    params.push(taskType);
  }
  clauses.push(`(c.source = 'human' OR c.battle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM comparisons h WHERE h.battle_id = c.battle_id AND h.source = 'human'
  ))`);

  return getDb().prepare(`
    SELECT c.model_a AS a, c.model_b AS b, c.outcome, c.task_type AS taskType, c.source
    FROM comparisons c WHERE ${clauses.join(' AND ')} ORDER BY c.id
  `).all(...params);
}

// Cheap fingerprint of the log, used to invalidate cached rating fits.
export function getComparisonVersion() {
  const row = getDb().prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS last FROM comparisons').get();
  return `${row.n}:${row.last}`;
}

export function getBattleComparisons(battleId) {
  return getDb().prepare('SELECT * FROM comparisons WHERE battle_id = ? ORDER BY id').all(battleId);
}

// Pairs that both a person and the judge ruled on, for measuring how often the
// judge agrees with the person it stands in for.
export function getJudgeHumanPairs() {
  return getDb().prepare(`
    SELECT h.battle_id AS battleId,
      h.model_a AS humanA, h.model_b AS humanB, h.outcome AS humanOutcome,
      j.model_a AS judgeA, j.model_b AS judgeB, j.outcome AS judgeOutcome, j.judge_model AS judgeModel
    FROM comparisons h
    JOIN comparisons j ON j.battle_id = h.battle_id AND j.source = 'judge'
      AND ((j.model_a = h.model_a AND j.model_b = h.model_b) OR (j.model_a = h.model_b AND j.model_b = h.model_a))
    WHERE h.source = 'human'
  `).all();
}

export function getJudgeConsistency() {
  return getDb().prepare(`
    SELECT judge_model AS judgeModel, COUNT(*) AS pairs, SUM(consistent) AS consistent
    FROM comparisons WHERE source = 'judge' AND consistent IS NOT NULL GROUP BY judge_model
  `).all();
}

// Of the pairs the judge decided, how often the longer response won. An unbiased
// judge lands near half; well above it suggests length is being rewarded.
export function getJudgeLengthBias() {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS pairs,
      COALESCE(SUM(LENGTH(w.response) > LENGTH(l.response)), 0) AS longerWins
    FROM comparisons c
    JOIN battle_entries w ON w.battle_id = c.battle_id
      AND w.model = CASE c.outcome WHEN 'a' THEN c.model_a ELSE c.model_b END
    JOIN battle_entries l ON l.battle_id = c.battle_id
      AND l.model = CASE c.outcome WHEN 'a' THEN c.model_b ELSE c.model_a END
    WHERE c.source = 'judge' AND c.outcome IN ('a', 'b')
      AND LENGTH(w.response) != LENGTH(l.response)
  `).get();
  return { pairs: row.pairs, longerWins: row.longerWins };
}

// --- Provider Health ---

export function updateProviderHealth(provider, status, latencyMs = null) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM provider_health WHERE provider = ?').get(provider);

  if (!existing) {
    const healthy = status === 'healthy';
    d.prepare(`
      INSERT INTO provider_health (provider, status, last_check, last_success, last_failure, consecutive_failures, avg_latency_ms)
      VALUES (?, ?, datetime('now'), ?, ?, ?, ?)
    `).run(
      provider,
      status,
      healthy ? sqliteTime(new Date().toISOString()) : null,
      healthy ? null : sqliteTime(new Date().toISOString()),
      healthy ? 0 : 1,
      latencyMs || 0,
    );
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

// Providers with three or more consecutive failures are routed around.
export function getUnhealthyProviders() {
  return getDb().prepare(
    'SELECT provider FROM provider_health WHERE consecutive_failures >= 3'
  ).all().map(r => r.provider);
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
  const d = getDb();
  // Marked through a temp table: a large catalog would overflow SQLite's bound-parameter limit.
  d.transaction(() => {
    d.exec('CREATE TEMP TABLE IF NOT EXISTS active_ids (id TEXT PRIMARY KEY)');
    d.exec('DELETE FROM active_ids');
    const insert = d.prepare('INSERT OR IGNORE INTO active_ids (id) VALUES (?)');
    for (const id of activeIds) insert.run(id);
    d.prepare(`
      UPDATE model_registry SET is_active = 0
      WHERE provider = ? AND id NOT IN (SELECT id FROM active_ids)
    `).run(provider);
  })();
}

// --- Evaluations ---

export function createEvaluation(data) {
  return getDb().prepare(`
    INSERT INTO evaluations (battle_id, model_a, model_b, winner_model, judge_model, inferred_domain, reasoning, is_auto, judge_consistency_score, cost_usd)
    VALUES (@battleId, @modelA, @modelB, @winnerModel, @judgeModel, @inferredDomain, @reasoning, @isAuto, @consistencyScore, @costUsd)
  `).run({ winnerModel: null, isAuto: 1, consistencyScore: null, costUsd: 0, ...data });
}

export function getEvaluation(battleId) {
  return getDb().prepare(
    'SELECT * FROM evaluations WHERE battle_id = ? ORDER BY id DESC LIMIT 1'
  ).get(battleId);
}

// --- Shadow evaluation ---

// What shadow evaluation has cost since a UTC ISO timestamp. The entry at
// position 1 is the response the caller already paid for; only challengers and
// judge calls are extra spend.
export function getShadowSpendSince(sinceIso) {
  const since = sqliteTime(sinceIso);
  const d = getDb();
  const challengers = d.prepare(`
    SELECT COALESCE(SUM(e.cost_usd), 0) AS cost FROM battle_entries e
    JOIN battles b ON b.id = e.battle_id
    WHERE b.origin = 'shadow' AND b.timestamp >= ? AND e.position > 1
  `).get(since).cost;
  const judging = d.prepare(`
    SELECT COALESCE(SUM(v.cost_usd), 0) AS cost FROM evaluations v
    JOIN battles b ON b.id = v.battle_id
    WHERE b.origin = 'shadow' AND b.timestamp >= ?
  `).get(since).cost;
  return challengers + judging;
}

export function getShadowStats(sinceIso) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS battles,
      COALESCE(SUM(EXISTS (SELECT 1 FROM comparisons c WHERE c.battle_id = b.id)), 0) AS judged
    FROM battles b WHERE b.origin = 'shadow' AND b.timestamp >= ?
  `).get(sqliteTime(sinceIso));
  return { battles: row.battles, judged: row.judged, spendUsd: getShadowSpendSince(sinceIso) };
}
