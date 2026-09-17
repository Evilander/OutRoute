import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-arena-')), 'test.db');

const store = await import('../src/db/store.js');
const { MockProvider } = await import('../src/proxy/providers/mock.js');
const { resolveProvider, isErroredEntry, dedupeModels, runBattle, voteBattle } = await import('../src/arena/arena.js');
const { createArenaRouter, clampTemperature, clampMaxTokens, parseModelList } = await import('../src/arena/routes.js');
const { initSession, getSession, streamCombatant, finalizeSession } = await import('../src/arena/streaming.js');

function mockProviders(mockOptions = {}) {
  const providers = new Map();
  providers.set('mock', new MockProvider({ mock: { enabled: true, latencyScale: 0, ...mockOptions } }));
  return providers;
}

describe('resolveProvider', () => {
  it('resolves through a provider\'s own ownsModel check', () => {
    const providers = mockProviders();
    const resolved = resolveProvider('mock-careful', providers);
    assert.equal(resolved.name, 'mock');
  });

  it('resolves OpenRouter models by their slash id', () => {
    const fakeOpenRouter = { ownsModel: id => id === 'meta-llama/llama-4', models: [] };
    const providers = new Map([['openrouter', fakeOpenRouter]]);
    assert.equal(resolveProvider('meta-llama/llama-4', providers).name, 'openrouter');
    assert.equal(resolveProvider('meta-llama/unknown', providers), null);
  });

  it('falls back to a name prefix when no provider owns the model directly', () => {
    const fakeAnthropic = { ownsModel: () => false, models: [] };
    const providers = new Map([['anthropic', fakeAnthropic]]);
    const resolved = resolveProvider('claude-some-future-model', providers);
    assert.equal(resolved.name, 'anthropic');
  });

  it('returns null when nothing matches', () => {
    assert.equal(resolveProvider('totally-unknown-thing', new Map()), null);
  });

  it('does not resolve a prefix that merely appears mid-string', () => {
    const fakeAnthropic = { ownsModel: () => false, models: [] };
    const providers = new Map([['anthropic', fakeAnthropic]]);
    // Contains "claude-" but does not start with it — must not resolve.
    assert.equal(resolveProvider('totally-not-claude-branded', providers), null);
    // Still resolves the legitimate prefix case.
    assert.equal(resolveProvider('claude-sonnet-5', providers).name, 'anthropic');
  });
});

describe('clampTemperature / clampMaxTokens / parseModelList', () => {
  it('preserves an explicit temperature of 0 instead of falling back to the default', () => {
    assert.equal(clampTemperature(0), 0);
    assert.equal(clampTemperature('0'), 0);
    assert.equal(clampTemperature(undefined), 0.7);
    assert.equal(clampTemperature('not a number'), 0.7);
    assert.equal(clampTemperature(5), 2); // clamped to the max
    assert.equal(clampTemperature(-5), 0); // clamped to the min
  });

  it('preserves an explicit maxTokens of 0 by clamping it to the floor of 1, not the 1024 default', () => {
    assert.equal(clampMaxTokens(0), 1);
    assert.equal(clampMaxTokens('0'), 1);
    assert.equal(clampMaxTokens(undefined), 1024);
    assert.equal(clampMaxTokens('not a number'), 1024);
    assert.equal(clampMaxTokens(999999), 16384); // clamped to the max
  });

  it('deduplicates before truncating to 8, so a distinct model past 8 duplicates is not lost', () => {
    const models = [...Array(8).fill('gpt-1'), 'claude-1'];
    assert.deepEqual(parseModelList(models), ['gpt-1', 'claude-1']);
  });

  it('still truncates a genuinely long distinct list to 8', () => {
    const models = Array.from({ length: 12 }, (_, i) => `model-${i}`);
    assert.equal(parseModelList(models).length, 8);
  });
});

describe('isErroredEntry / dedupeModels', () => {
  it('treats empty and "[ERROR]"-prefixed responses as errored', () => {
    assert.equal(isErroredEntry({ response: '' }), true);
    assert.equal(isErroredEntry({ response: null }), true);
    assert.equal(isErroredEntry({ response: '[ERROR] upstream timeout' }), true);
    assert.equal(isErroredEntry({ response: 'a real answer' }), false);
  });

  it('deduplicates while preserving first-seen order', () => {
    assert.deepEqual(dedupeModels(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
  });
});

describe('runBattle', () => {
  it('creates one entry per distinct model and stores the full prompt up to 32k chars', async () => {
    const providers = mockProviders();
    const longPrompt = 'x'.repeat(40_000);
    const result = await runBattle(longPrompt, ['mock-careful', 'mock-quick'], providers, {});
    assert.equal(result.entries.length, 2);
    const stored = store.getBattle(result.battleId);
    assert.equal(stored.prompt.length, 32_000);
  });

  it('collapses duplicate model ids before running', async () => {
    const providers = mockProviders();
    const result = await runBattle('hello', ['mock-careful', 'mock-careful', 'mock-quick'], providers, {});
    assert.equal(result.entries.length, 2);
  });

  it('detects task type from the prompt when none is given', async () => {
    const providers = mockProviders();
    const result = await runBattle(
      'Please debug this JavaScript function:\n```js\nfunction f(x) { return x.map(y => y) }\n```',
      ['mock-careful', 'mock-quick'], providers, {},
    );
    assert.equal(result.taskType, 'code');
    assert.equal(store.getBattle(result.battleId).task_type, 'code');
  });

  it('flags a failed combatant structurally and never stores "[ERROR]" text', async () => {
    const providers = mockProviders({ fail: ['mock-quick'] });
    const result = await runBattle('hi', ['mock-careful', 'mock-quick'], providers, {});
    const failed = result.entries.find(e => e.error);
    assert.ok(failed);
    assert.equal(failed.response, '');
    const stored = store.getBattle(result.battleId).entries.find(e => e.id === failed.entryId);
    assert.equal(stored.response, '');
    assert.ok(!stored.response.includes('[ERROR]'));
  });

  it('rejects a prompt with fewer than 2 resolvable models', async () => {
    const providers = mockProviders();
    await assert.rejects(
      () => runBattle('hi', ['mock-careful', 'totally-unresolvable'], providers, {}),
      err => err.status === 400,
    );
  });
});

describe('voteBattle', () => {
  it('records winner-vs-each-loser comparisons and marks the battle voted', async () => {
    const providers = mockProviders();
    const result = await runBattle('vote me', ['mock-careful', 'mock-balanced', 'mock-quick'], providers, {});
    const winner = result.entries[0];

    const outcome = voteBattle(result.battleId, { winnerPosition: winner.position });
    assert.equal(outcome.tie, false);
    assert.equal(outcome.winnerModel, winner.model);

    const battle = store.getBattle(result.battleId);
    assert.equal(battle.status, 'voted');
    assert.equal(battle.entries.find(e => e.id === winner.entryId).is_winner, 1);

    const comparisons = store.getBattleComparisons(result.battleId);
    assert.equal(comparisons.length, 2);
    assert.ok(comparisons.every(c => c.source === 'human' && c.model_a === winner.model && c.outcome === 'a'));
  });

  it('rejects a second vote on the same battle', async () => {
    const providers = mockProviders();
    const result = await runBattle('vote twice', ['mock-careful', 'mock-quick'], providers, {});
    voteBattle(result.battleId, { winnerPosition: result.entries[0].position });
    assert.throws(
      () => voteBattle(result.battleId, { winnerPosition: result.entries[1].position }),
      err => err.status === 409,
    );
  });

  it('records a tie as a pairwise tie comparison for every valid pair', async () => {
    const providers = mockProviders();
    const result = await runBattle('tie me', ['mock-careful', 'mock-balanced', 'mock-quick'], providers, {});
    const outcome = voteBattle(result.battleId, { tie: true });
    assert.equal(outcome.tie, true);

    const comparisons = store.getBattleComparisons(result.battleId);
    assert.equal(comparisons.length, 3); // 3 choose 2
    assert.ok(comparisons.every(c => c.outcome === 'tie' && c.source === 'human'));

    const battle = store.getBattle(result.battleId);
    assert.ok(battle.entries.every(e => e.is_winner === 0));
  });

  it('never offers an errored entry for voting', async () => {
    const providers = mockProviders({ fail: ['mock-quick'] });
    const result = await runBattle('one bad apple', ['mock-careful', 'mock-balanced', 'mock-quick'], providers, {});
    const failedEntry = result.entries.find(e => e.error);

    assert.throws(
      () => voteBattle(result.battleId, { winnerPosition: failedEntry.position }),
      err => err.status === 400,
    );

    const outcome = voteBattle(result.battleId, { tie: true });
    assert.equal(outcome.tie, true);
    // Only the 2 valid entries are compared, never the errored third.
    assert.equal(store.getBattleComparisons(result.battleId).length, 1);
  });

  it('refuses to vote when fewer than 2 entries are valid', async () => {
    const providers = mockProviders({ fail: ['mock-balanced', 'mock-quick'] });
    const result = await runBattle('mostly broken', ['mock-careful', 'mock-balanced', 'mock-quick'], providers, {});
    assert.throws(() => voteBattle(result.battleId, { tie: true }), err => err.status === 409);
  });
});

describe('streaming sessions', () => {
  it('refuses to finalize until every combatant has streamed, then is idempotent', async () => {
    const providers = mockProviders();
    const session = initSession('stream me', ['mock-careful', 'mock-quick'], providers, {});
    assert.equal(session.combatants.length, 2);

    assert.throws(() => finalizeSession(session.sessionId), err => err.status === 409);

    for (const combatant of session.combatants) {
      let delivered = '';
      let sawDoneWithoutContent = true;
      for await (const chunk of streamCombatant(session.sessionId, combatant.id)) {
        if (chunk.type === 'delta') delivered += chunk.content;
        if (chunk.type === 'done' && 'content' in chunk) sawDoneWithoutContent = false;
      }
      assert.ok(sawDoneWithoutContent);
      assert.ok(delivered.length > 0);
    }

    const battleId = finalizeSession(session.sessionId);
    assert.equal(typeof battleId, 'number');
    const entryCount = store.getBattle(battleId).entries.length;
    assert.equal(entryCount, 2);

    // Repeat finalize: idempotent, same battleId, no duplicate rows, and the
    // live session is gone (finalize deletes it).
    assert.equal(finalizeSession(session.sessionId), battleId);
    assert.equal(store.getBattle(battleId).entries.length, 2);
    assert.equal(getSession(session.sessionId), null);
  });

  it('re-validates the resolved combatant count after provider resolution', () => {
    const providers = mockProviders();
    assert.throws(
      () => initSession('bad models', ['mock-careful', 'nonexistent-model-xyz'], providers, {}),
      err => err.status === 400,
    );
  });

  it('rejects a concurrent second stream of the same combatant instead of double-billing the provider', async () => {
    const providers = mockProviders();
    const mock = providers.get('mock');
    let chatCalls = 0;
    const originalChat = mock.chat.bind(mock);
    mock.chat = async (...args) => {
      chatCalls++;
      return originalChat(...args);
    };

    const session = initSession('concurrent stream', ['mock-careful', 'mock-quick'], providers, {});
    const [combatant] = session.combatants;

    const drain = async () => {
      let deltas = 0;
      try {
        for await (const chunk of streamCombatant(session.sessionId, combatant.id)) {
          if (chunk.type === 'delta') deltas++;
        }
        return { ok: true, deltas };
      } catch (err) {
        return { ok: false, status: err.status };
      }
    };

    // Both calls are constructed before either is awaited: the first one's
    // synchronous prefix (through the streaming-lock check) runs to
    // completion before the second one's begins.
    const [first, second] = await Promise.all([drain(), drain()]);

    assert.equal(chatCalls, 1, 'the provider must be called exactly once for one combatant');
    const results = [first, second];
    assert.equal(results.filter(r => r.ok).length, 1);
    const failed = results.find(r => !r.ok);
    assert.equal(failed.status, 409);
    const succeeded = results.find(r => r.ok);
    assert.ok(succeeded.deltas > 0);
  });

  it('lets a retry stream the same combatant again after an earlier stream never completed', async () => {
    const providers = mockProviders();
    const initResult = initSession('retry after abandon', ['mock-careful', 'mock-quick'], providers, {});
    const [{ id: combatantId }] = initResult.combatants;
    // initSession's return value carries only {id, position}; the live
    // combatant record (with .completed/.streaming) lives on the internal
    // session, reached through getSession.
    const combatant = getSession(initResult.sessionId).combatantMap.get(combatantId);

    // Simulate a client that disconnected mid-stream: break out of the
    // for-await loop early, which calls .return() on the generator without
    // ever setting combatant.completed.
    for await (const chunk of streamCombatant(initResult.sessionId, combatantId)) {
      if (chunk.type === 'delta') break;
    }
    assert.equal(combatant.completed, false);
    assert.equal(combatant.streaming, false);

    // A second attempt must not be permanently locked out by the abandoned first one.
    let deltas = 0;
    for await (const chunk of streamCombatant(initResult.sessionId, combatantId)) {
      if (chunk.type === 'delta') deltas++;
    }
    assert.ok(deltas > 0);
    assert.equal(combatant.completed, true);
  });
});

describe('HTTP routes', () => {
  let server;
  let baseUrl;

  before(() => {
    const providers = mockProviders();
    const app = express();
    app.use(express.json());
    app.use('/arena', createArenaRouter(providers, { autoJudge: null }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}/arena`;
  });

  after(() => new Promise(resolve => server.close(resolve)));

  it('POST /battle returns blind entries with no model/provider/cost, but latency is fine', async () => {
    const res = await fetch(`${baseUrl}/battle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello there', models: ['mock-careful', 'mock-quick'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entries.length, 2);
    for (const entry of body.entries) {
      assert.equal(entry.model, undefined);
      assert.equal(entry.provider, undefined);
      assert.equal(entry.costUsd, undefined);
      assert.equal(typeof entry.latencyMs, 'number');
      assert.equal(typeof entry.error, 'boolean');
    }
  });

  it('POST /battle 400s on a single named model', async () => {
    const res = await fetch(`${baseUrl}/battle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', models: ['mock-careful'] }),
    });
    assert.equal(res.status, 400);
  });

  it('vote then reveal round-trip, and a second vote 409s', async () => {
    const battleRes = await fetch(`${baseUrl}/battle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'round trip', models: ['mock-careful', 'mock-quick'] }),
    });
    const battle = await battleRes.json();

    const revealBeforeVote = await fetch(`${baseUrl}/reveal/${battle.battleId}`);
    assert.equal(revealBeforeVote.status, 403);

    const voteRes = await fetch(`${baseUrl}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ battleId: battle.battleId, winnerPosition: battle.entries[0].position }),
    });
    assert.equal(voteRes.status, 200);

    const revealRes = await fetch(`${baseUrl}/reveal/${battle.battleId}`);
    assert.equal(revealRes.status, 200);
    const revealed = await revealRes.json();
    assert.equal(revealed.entries.length, 2);
    assert.ok(revealed.entries[0].model);

    const secondVote = await fetch(`${baseUrl}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ battleId: battle.battleId, winnerPosition: battle.entries[1].position }),
    });
    assert.equal(secondVote.status, 409);
  });

  it('forfeit reveal marks the battle revealed and blocks a later vote', async () => {
    const battleRes = await fetch(`${baseUrl}/battle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'forfeit me', models: ['mock-careful', 'mock-quick'] }),
    });
    const battle = await battleRes.json();

    const forfeitRes = await fetch(`${baseUrl}/reveal/${battle.battleId}?forfeit=1`);
    assert.equal(forfeitRes.status, 200);
    assert.equal((await forfeitRes.json()).status, 'revealed');

    const voteRes = await fetch(`${baseUrl}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ battleId: battle.battleId, winnerPosition: battle.entries[0].position }),
    });
    assert.equal(voteRes.status, 409);
  });

  it('GET /battles strips identity, provider and cost for pending battles but reveals them once decided', async () => {
    // Seeded directly through runBattle/voteBattle rather than HTTP: this
    // suite's POST /battle, /vote and /reveal all share arenaLimiter (max 10
    // requests/window), which the other tests in this describe block already
    // spend close to the limit — routing setup through the module functions
    // instead keeps this test independent of that budget while still
    // exercising the real GET /battles route under test.
    const providers = mockProviders();
    const pending = await runBattle('battles list blind check', ['mock-careful', 'mock-quick'], providers, {});
    const voted = await runBattle('battles list revealed check', ['mock-careful', 'mock-quick'], providers, {});
    voteBattle(voted.battleId, { winnerPosition: voted.entries[0].position });

    const listRes = await fetch(`${baseUrl}/battles?limit=50`);
    assert.equal(listRes.status, 200);
    const { battles } = await listRes.json();

    const pendingListed = battles.find(b => b.id === pending.battleId);
    assert.ok(pendingListed);
    assert.equal(pendingListed.status, 'pending');
    for (const entry of pendingListed.entries) {
      assert.equal(entry.model, undefined);
      assert.equal(entry.provider, undefined);
      assert.equal(entry.costUsd, undefined);
      assert.equal(typeof entry.latencyMs, 'number');
    }

    const votedListed = battles.find(b => b.id === voted.battleId);
    assert.ok(votedListed);
    assert.equal(votedListed.status, 'voted');
    for (const entry of votedListed.entries) {
      assert.ok(entry.model);
      assert.ok(entry.provider);
      assert.equal(typeof entry.costUsd, 'number');
    }
  });

  it('GET /leaderboard and /judge return the documented shape', async () => {
    const leaderboardRes = await fetch(`${baseUrl}/leaderboard`);
    assert.equal(leaderboardRes.status, 200);
    const leaderboard = await leaderboardRes.json();
    assert.ok(Array.isArray(leaderboard.leaderboard));
    assert.equal(leaderboard.taskType, 'overall');
    assert.equal(typeof leaderboard.minGames, 'number');

    const judgeRes = await fetch(`${baseUrl}/judge`);
    assert.equal(judgeRes.status, 200);
    const judge = await judgeRes.json();
    assert.ok('judge' in judge);
    assert.ok('agreement' in judge);
    assert.ok('consistency' in judge);
    assert.ok('lengthBias' in judge);
  });

  it('lets a person vote in bursts, but limits how fast comparisons can be started', async () => {
    const vote = () => fetch(`${baseUrl}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ battleId: 999999, winnerPosition: 1 }),
    });
    const votes = await Promise.all(Array.from({ length: 30 }, vote));
    assert.ok(votes.every(r => r.status !== 429), 'voting costs nothing and must not be throttled at arena pace');

    const start = () => fetch(`${baseUrl}/battle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'rate limit probe', models: ['mock-quick'] }),
    });
    const starts = await Promise.all(Array.from({ length: 12 }, start));
    assert.ok(starts.some(r => r.status === 429), 'starting comparisons spends money and is limited');
  });
});
