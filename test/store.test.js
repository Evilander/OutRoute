import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'prism-store-'));
process.env.DB_PATH = join(dir, 'legacy.db');

// A database as version 0.1 would have left it: Elo totals, no comparison log,
// judge verdicts filed under the judge's own domain names.
function writeLegacyDatabase(path) {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      provider TEXT NOT NULL, model TEXT NOT NULL, strategy TEXT NOT NULL, prompt_preview TEXT, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, latency_ms INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
      status TEXT DEFAULT 'ok', error_message TEXT, task_type TEXT DEFAULT 'general');
    CREATE TABLE battles (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      prompt TEXT NOT NULL, task_type TEXT DEFAULT 'general', status TEXT DEFAULT 'pending');
    CREATE TABLE battle_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, battle_id INTEGER NOT NULL REFERENCES battles(id),
      provider TEXT NOT NULL, model TEXT NOT NULL, response TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      latency_ms INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, is_winner INTEGER DEFAULT 0, position INTEGER NOT NULL);
    CREATE TABLE elo_ratings (model TEXT NOT NULL, task_type TEXT NOT NULL DEFAULT 'general', rating REAL NOT NULL DEFAULT 1500,
      wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, battles INTEGER DEFAULT 0, last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (model, task_type));
    CREATE TABLE model_registry (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_model_id TEXT NOT NULL, display_name TEXT NOT NULL,
      context_window INTEGER NOT NULL DEFAULT 4096, price_prompt_1k REAL NOT NULL DEFAULT 0, price_completion_1k REAL NOT NULL DEFAULT 0,
      is_active INTEGER DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE evaluations (id INTEGER PRIMARY KEY AUTOINCREMENT, battle_id INTEGER NOT NULL REFERENCES battles(id), model_a TEXT NOT NULL,
      model_b TEXT NOT NULL, winner_model TEXT, judge_model TEXT NOT NULL, inferred_domain TEXT, reasoning TEXT, is_auto INTEGER DEFAULT 1,
      linked_manual_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));

    INSERT INTO battles (id, prompt, task_type, status) VALUES
      (1, 'human voted, three way', 'code', 'voted'),
      (2, 'judge decided', 'general', 'voted'),
      (3, 'never decided', 'general', 'pending'),
      (4, 'winner beat an errored entry', 'creative', 'voted');
    INSERT INTO battle_entries (battle_id, provider, model, response, is_winner, position) VALUES
      (1, 'p', 'alpha', 'ok', 1, 1), (1, 'p', 'beta', 'ok', 0, 2), (1, 'p', 'gamma', 'ok', 0, 3),
      (2, 'p', 'alpha', 'ok', 0, 1), (2, 'p', 'beta', 'ok', 1, 2),
      (3, 'p', 'alpha', 'ok', 0, 1), (3, 'p', 'beta', 'ok', 0, 2),
      (4, 'p', 'alpha', 'ok', 1, 1), (4, 'p', 'beta', '[ERROR] upstream timeout', 0, 2);
    INSERT INTO evaluations (battle_id, model_a, model_b, winner_model, judge_model, inferred_domain)
      VALUES (2, 'alpha', 'beta', 'beta', 'judge-1', 'coding');
  `);
  legacy.close();
}

describe('store migrations', () => {
  let store;

  before(async () => {
    writeLegacyDatabase(process.env.DB_PATH);
    store = await import('../src/db/store.js');
    store.getDb();
  });

  after(() => store.closeDb());

  it('rebuilds the comparison log from decided battles', () => {
    const human = store.getBattleComparisons(1);
    assert.equal(human.length, 2);
    assert.ok(human.every(c => c.model_a === 'alpha' && c.outcome === 'a' && c.source === 'human' && c.task_type === 'code'));
    assert.deepEqual(human.map(c => c.model_b).sort(), ['beta', 'gamma']);
  });

  it('files judge verdicts under the shared taxonomy, not the judge\'s own names', () => {
    const [judged] = store.getBattleComparisons(2);
    assert.equal(judged.source, 'judge');
    assert.equal(judged.judge_model, 'judge-1');
    assert.equal(judged.task_type, 'code');
    assert.equal(judged.model_a, 'beta');
  });

  it('skips undecided battles and entries that errored', () => {
    assert.equal(store.getBattleComparisons(3).length, 0);
    assert.equal(store.getBattleComparisons(4).length, 0);
  });

  it('adds the new columns and lets unknown prices be null', () => {
    const db = store.getDb();
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.equal(db.prepare('SELECT origin FROM battles WHERE id = 1').get().origin, 'arena');
    store.upsertModel({
      id: 'x/unknown', provider: 'x', providerModelId: 'unknown', displayName: 'Unknown',
      contextWindow: 8192, pricePrompt1k: null, priceCompletion1k: null,
    });
    assert.equal(store.getRegistryModel('x/unknown').price_prompt_1k, null);
  });

  it('does not backfill twice', () => {
    const before = store.getComparisonVersion();
    store.closeDb();
    store.getDb();
    assert.equal(store.getComparisonVersion(), before);
  });
});

describe('comparison log', () => {
  let store;
  before(async () => {
    store = await import('../src/db/store.js');
  });

  it('lets a human verdict override the judge on the same battle', () => {
    const battleId = Number(store.createBattle('override test', 'analysis'));
    store.addComparison({ battleId, modelA: 'alpha', modelB: 'beta', outcome: 'a', taskType: 'analysis', source: 'judge', judgeModel: 'judge-1', consistent: 1 });
    assert.equal(store.getEffectiveComparisons({ taskType: 'analysis' }).length, 1);

    store.addComparison({ battleId, modelA: 'beta', modelB: 'alpha', outcome: 'a', taskType: 'analysis', source: 'human' });
    const effective = store.getEffectiveComparisons({ taskType: 'analysis' });
    assert.equal(effective.length, 1);
    assert.equal(effective[0].source, 'human');
    assert.equal(effective[0].a, 'beta');

    assert.equal(store.getEffectiveComparisons({ taskType: 'analysis', sources: ['judge'] }).length, 0);
    assert.equal(store.getJudgeHumanPairs().filter(p => p.battleId === battleId).length, 1);
  });

  it('rejects outcomes and sources outside the allowed values', () => {
    assert.throws(() => store.addComparison({ modelA: 'a', modelB: 'b', outcome: 'win', source: 'human' }));
    assert.throws(() => store.addComparison({ modelA: 'a', modelB: 'b', outcome: 'a', source: 'robot' }));
  });

  it('changes the version fingerprint when the log grows', () => {
    const before = store.getComparisonVersion();
    store.addComparison({ modelA: 'a', modelB: 'b', outcome: 'tie', source: 'human' });
    assert.notEqual(store.getComparisonVersion(), before);
  });
});

describe('shadow spend', () => {
  it('counts challengers and judge calls but not the response the caller already paid for', async () => {
    const store = await import('../src/db/store.js');
    const battleId = Number(store.createBattle('shadow', 'general', 'shadow'));
    const entry = { provider: 'p', response: 'ok', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
    store.addBattleEntry(battleId, { ...entry, model: 'served', costUsd: 0.5, position: 1 });
    store.addBattleEntry(battleId, { ...entry, model: 'challenger', costUsd: 0.02, position: 2 });
    store.createEvaluation({ battleId, modelA: 'served', modelB: 'challenger', judgeModel: 'judge-1', inferredDomain: 'general', reasoning: '', costUsd: 0.003 });

    const since = new Date(Date.now() - 3600000).toISOString();
    assert.ok(Math.abs(store.getShadowSpendSince(since) - 0.023) < 1e-9);
    assert.equal(store.getShadowStats(since).battles, 1);
  });
});

describe('judge length bias', () => {
  it('counts decided judge pairs and how many went to the longer response', async () => {
    const store = await import('../src/db/store.js');
    const before = store.getJudgeLengthBias();
    const entry = { provider: 'p', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0 };

    const longWins = Number(store.createBattle('length 1', 'general'));
    store.addBattleEntry(longWins, { ...entry, model: 'wordy', response: 'x'.repeat(400), position: 1 });
    store.addBattleEntry(longWins, { ...entry, model: 'terse', response: 'x'.repeat(40), position: 2 });
    store.addComparison({ battleId: longWins, modelA: 'wordy', modelB: 'terse', outcome: 'a', source: 'judge', judgeModel: 'j', consistent: 1 });

    const shortWins = Number(store.createBattle('length 2', 'general'));
    store.addBattleEntry(shortWins, { ...entry, model: 'wordy', response: 'x'.repeat(400), position: 1 });
    store.addBattleEntry(shortWins, { ...entry, model: 'terse', response: 'x'.repeat(40), position: 2 });
    store.addComparison({ battleId: shortWins, modelA: 'wordy', modelB: 'terse', outcome: 'b', source: 'judge', judgeModel: 'j', consistent: 1 });

    const tied = Number(store.createBattle('length 3', 'general'));
    store.addBattleEntry(tied, { ...entry, model: 'wordy', response: 'x'.repeat(400), position: 1 });
    store.addBattleEntry(tied, { ...entry, model: 'terse', response: 'x'.repeat(40), position: 2 });
    store.addComparison({ battleId: tied, modelA: 'wordy', modelB: 'terse', outcome: 'tie', source: 'judge', judgeModel: 'j', consistent: 0 });

    const after = store.getJudgeLengthBias();
    assert.equal(after.pairs - before.pairs, 2, 'ties carry no length signal');
    assert.equal(after.longerWins - before.longerWins, 1);
  });
});

describe('request log', () => {
  it('returns the row id, and a streamed request can fill in its usage afterwards', async () => {
    const store = await import('../src/db/store.js');
    const id = store.logRequest({
      provider: 'p', model: 'm', strategy: 'best', promptPreview: 'hi', inputTokens: 10, outputTokens: 0,
      totalTokens: 10, latencyMs: 0, costUsd: 0, status: 'ok', errorMessage: null, taskType: 'general',
    });
    assert.equal(typeof id, 'number');

    store.updateRequestUsage(id, { outputTokens: 42, totalTokens: 52, costUsd: 0.0031, latencyMs: 870 });
    const row = store.getRecentRequests(1)[0];
    assert.equal(row.id, id);
    assert.equal(row.output_tokens, 42);
    assert.equal(row.cost_usd, 0.0031);
    assert.equal(row.latency_ms, 870);
  });

  it('measures latency over successful calls only', async () => {
    const store = await import('../src/db/store.js');
    const base = { provider: 'lat', model: 'fast-fail', strategy: 'best', promptPreview: '', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0, errorMessage: null, taskType: 'general' };
    store.logRequest({ ...base, latencyMs: 40, status: 'error' });
    store.logRequest({ ...base, latencyMs: 900, status: 'ok' });
    const stat = store.getLatencyStats(1).find(s => s.model === 'fast-fail');
    assert.equal(stat.samples, 1);
    assert.equal(stat.avg_latency, 900);
  });
});

describe('provider health', () => {
  it('routes around a provider only after three consecutive failures', async () => {
    const store = await import('../src/db/store.js');
    store.updateProviderHealth('flaky', 'degraded');
    store.updateProviderHealth('flaky', 'degraded');
    assert.ok(!store.getUnhealthyProviders().includes('flaky'));
    store.updateProviderHealth('flaky', 'degraded');
    assert.ok(store.getUnhealthyProviders().includes('flaky'));
    store.updateProviderHealth('flaky', 'healthy', 120);
    assert.ok(!store.getUnhealthyProviders().includes('flaky'));
  });
});
