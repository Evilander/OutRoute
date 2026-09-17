import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-shadow-')), 'test.db');

const { ShadowEvaluator } = await import('../src/services/shadow.js');
const { Router } = await import('../src/proxy/router.js');
const store = await import('../src/db/store.js');
const { MIN_GAMES } = await import('../src/arena/ratings.js');

const msgs = text => [{ role: 'user', content: text }];

function fakeProvider({ name, models, local = false, chat }) {
  return {
    name, available: true, local, models,
    getModel: id => models.find(m => m.id === id) || null,
    chat,
    estimateCost: (inTok, outTok, modelId) => {
      const m = models.find(x => x.id === modelId);
      if (!m || m.costPer1kInput == null) return 0;
      return (inTok / 1000) * m.costPer1kInput + (outTok / 1000) * m.costPer1kOutput;
    },
  };
}

function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function fixedSequence(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function fakeAutoJudge() {
  const enqueued = [];
  return { enqueued, enqueue: id => enqueued.push(id) };
}

function servedResult(overrides = {}) {
  return {
    provider: 'served-provider', model: 'served-model', content: 'the served answer',
    inputTokens: 20, outputTokens: 10, costUsd: 0.01, latencyMs: 50, ...overrides,
  };
}

async function flush() {
  // maybeShadow is fire-and-forget; give its internal promise chain a tick.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

describe('ShadowEvaluator: enabled / disabled', () => {
  it('is disabled at rate 0 (the default) and never creates a battle', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'challenger', costPer1kInput: 1, costPer1kOutput: 1 }], chat: async () => ({ content: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1 }) })]]);
    const router = new Router(providers);
    const shadow = new ShadowEvaluator({ providers, router, autoJudge: fakeAutoJudge(), rate: 0 });
    assert.equal(shadow.enabled, false);

    const before = store.getShadowStats(new Date(0).toISOString()).battles;
    shadow.maybeShadow({ messages: msgs('hi'), served: servedResult({ model: 'served-model' }), options: {}, headers: {} });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before);
  });

  it('reports its configuration and spend through stats()', () => {
    const shadow = new ShadowEvaluator({ providers: new Map(), router: new Router(new Map()), autoJudge: fakeAutoJudge(), rate: 0.5, budgetUsd: 2.5 });
    const s = shadow.stats();
    assert.equal(s.enabled, true);
    assert.equal(s.rate, 0.5);
    assert.equal(s.budgetUsd, 2.5);
    assert.equal(typeof s.spentTodayUsd, 'number');
    assert.equal(typeof s.battlesToday, 'number');
    assert.equal(typeof s.judgedToday, 'number');
  });
});

describe('ShadowEvaluator: probability gate', () => {
  it('runs when the random draw is under the rate, skips when it is not', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'challenger', costPer1kInput: 0.001, costPer1kOutput: 0.001 }], chat: async () => ({ content: 'challenger reply', inputTokens: 1, outputTokens: 1, latencyMs: 1 }) })]]);
    const router = new Router(providers);
    const judge = fakeAutoJudge();

    const skips = new ShadowEvaluator({ providers, router, autoJudge: judge, rate: 0.5, random: fixedSequence([0.9]) });
    const before = store.getShadowStats(new Date(0).toISOString()).battles;
    skips.maybeShadow({ messages: msgs('hi'), served: servedResult({ model: 'served-model-a' }), options: {}, headers: {} });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before);

    const runs = new ShadowEvaluator({ providers, router, autoJudge: judge, rate: 0.5, random: fixedSequence([0.1, 0.5]) });
    runs.maybeShadow({ messages: msgs('hi'), served: servedResult({ model: 'served-model-b' }), options: {}, headers: {} });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before + 1);
    assert.equal(judge.enqueued.length, 1);
  });
});

describe('ShadowEvaluator: skip rules', () => {
  function evaluator({ providers, router, autoJudge = fakeAutoJudge(), budgetUsd = 100 } = {}) {
    return new ShadowEvaluator({ providers, router, autoJudge, rate: 1, budgetUsd, random: () => 0 });
  }

  it('skips a request that used tools', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'c' }], chat: async () => ({ content: 'x' }) })]]);
    const shadow = evaluator({ providers, router: new Router(providers) });
    const before = store.getShadowStats(new Date(0).toISOString()).battles;
    shadow.maybeShadow({ messages: msgs('hi'), served: servedResult(), options: { tools: [{ type: 'function' }] }, headers: {} });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before);
  });

  it('skips non-text message content', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'c' }], chat: async () => ({ content: 'x' }) })]]);
    const shadow = evaluator({ providers, router: new Router(providers) });
    const before = store.getShadowStats(new Date(0).toISOString()).battles;
    shadow.maybeShadow({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }], served: servedResult(), options: {}, headers: {} });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before);
  });

  it('skips a prompt estimated over 8000 tokens', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'c' }], chat: async () => ({ content: 'x' }) })]]);
    const shadow = evaluator({ providers, router: new Router(providers) });
    const before = store.getShadowStats(new Date(0).toISOString()).battles;
    shadow.maybeShadow({ messages: msgs('a'.repeat(40_000)), served: servedResult(), options: {}, headers: {} });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before);
  });

  it('skips when the x-prism-no-shadow header is set', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'c' }], chat: async () => ({ content: 'x' }) })]]);
    const shadow = evaluator({ providers, router: new Router(providers) });
    const before = store.getShadowStats(new Date(0).toISOString()).battles;
    shadow.maybeShadow({ messages: msgs('hi'), served: servedResult(), options: {}, headers: { 'x-prism-no-shadow': '1' } });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before);
  });

  it('skips when the served response is empty', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'c' }], chat: async () => ({ content: 'x' }) })]]);
    const shadow = evaluator({ providers, router: new Router(providers) });
    const before = store.getShadowStats(new Date(0).toISOString()).battles;
    shadow.maybeShadow({ messages: msgs('hi'), served: servedResult({ content: '' }), options: {}, headers: {} });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before);
  });

  it('skips once today\'s shadow spend has reached the daily budget', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'c', costPer1kInput: 1, costPer1kOutput: 1 }], chat: async () => ({ content: 'x', inputTokens: 1, outputTokens: 1 }) })]]);
    const battleId = store.createBattle('spend seed', 'general', 'shadow');
    store.addBattleEntry(battleId, { provider: 'served-provider', model: 'served-model', response: 'ok', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, position: 1 });
    store.addBattleEntry(battleId, { provider: 'p', model: 'c', response: 'ok', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 5, position: 2 });

    const shadow = evaluator({ providers, router: new Router(providers), budgetUsd: 1 });
    const before = store.getShadowStats(new Date(0).toISOString()).battles;
    shadow.maybeShadow({ messages: msgs('hi'), served: servedResult(), options: {}, headers: {} });
    await flush();
    assert.equal(store.getShadowStats(new Date(0).toISOString()).battles, before);
  });

  it('never throws synchronously even with malformed input', () => {
    const shadow = evaluator({ providers: new Map(), router: new Router(new Map()) });
    assert.doesNotThrow(() => shadow.maybeShadow({}));
    assert.doesNotThrow(() => shadow.maybeShadow(undefined));
  });
});

describe('ShadowEvaluator: challenger selection', () => {
  it('prefers a model with fewer than MIN_GAMES games over a fully-rated one', async () => {
    const providers = new Map([
      ['p', fakeProvider({
        name: 'p',
        models: [
          { id: 'served-model', costPer1kInput: 1, costPer1kOutput: 1 },
          { id: 'well-rated', costPer1kInput: 1, costPer1kOutput: 1 },
          { id: 'under-sampled', costPer1kInput: 1, costPer1kOutput: 1 },
        ],
        chat: async (m, o) => ({ content: `reply from ${o.model}`, inputTokens: 1, outputTokens: 1, latencyMs: 1 }),
      })],
    ]);
    for (let i = 0; i < MIN_GAMES; i++) {
      store.addComparison({ modelA: 'served-model', modelB: 'well-rated', outcome: i % 2 === 0 ? 'a' : 'b', taskType: 'general', source: 'human' });
    }
    // under-sampled has zero games — it must be picked over well-rated.
    const router = new Router(providers);
    const judge = fakeAutoJudge();
    const shadow = new ShadowEvaluator({ providers, router, autoJudge: judge, rate: 1, budgetUsd: 1000, random: () => 0 });

    shadow.maybeShadow({ messages: msgs('pick the under-sampled one'), served: servedResult({ provider: 'p', model: 'served-model' }), options: {}, headers: {} });
    await flush();

    assert.equal(judge.enqueued.length, 1);
    const battle = store.getBattle(judge.enqueued[0]);
    const challengerEntry = battle.entries.find(e => e.position === 2);
    assert.equal(challengerEntry.model, 'under-sampled');
  });

  it('never picks the served model or an unknown-price non-local model as the challenger', async () => {
    const providers = new Map([
      ['p', fakeProvider({
        name: 'p',
        models: [
          { id: 'served-model', costPer1kInput: 1, costPer1kOutput: 1 },
          { id: 'unknown-price', costPer1kInput: null, costPer1kOutput: null },
          { id: 'known-price', costPer1kInput: 1, costPer1kOutput: 1 },
        ],
        chat: async (m, o) => ({ content: `reply from ${o.model}`, inputTokens: 1, outputTokens: 1, latencyMs: 1 }),
      })],
    ]);
    const router = new Router(providers);
    const judge = fakeAutoJudge();
    const shadow = new ShadowEvaluator({ providers, router, autoJudge: judge, rate: 1, budgetUsd: 1000, random: () => 0 });

    shadow.maybeShadow({ messages: msgs('avoid unknown price'), served: servedResult({ provider: 'p', model: 'served-model' }), options: {}, headers: {} });
    await flush();

    assert.equal(judge.enqueued.length, 1);
    const battle = store.getBattle(judge.enqueued[0]);
    const challengerEntry = battle.entries.find(e => e.position === 2);
    assert.equal(challengerEntry.model, 'known-price');
  });

  it('uses Thompson sampling once every candidate has enough games', async () => {
    const providers = new Map([
      ['p', fakeProvider({
        name: 'p',
        models: [
          { id: 'served-model', costPer1kInput: 1, costPer1kOutput: 1 },
          { id: 'strong', costPer1kInput: 1, costPer1kOutput: 1 },
          { id: 'weak', costPer1kInput: 1, costPer1kOutput: 1 },
        ],
        chat: async (m, o) => ({ content: `reply from ${o.model}`, inputTokens: 1, outputTokens: 1, latencyMs: 1 }),
      })],
    ]);
    for (let i = 0; i < MIN_GAMES + 5; i++) store.addComparison({ modelA: 'strong', modelB: 'weak', outcome: 'a', taskType: 'thompson-task', source: 'human' });
    for (let i = 0; i < MIN_GAMES; i++) store.addComparison({ modelA: 'served-model', modelB: 'weak', outcome: 'a', taskType: 'thompson-task', source: 'human' });

    const router = new Router(providers);
    const judge = fakeAutoJudge();
    // The probability draw and the Thompson draw share the injected random
    // source; the first call selects a sample, so a low value should favour
    // the model with the higher sampled strength most of the time.
    const shadow = new ShadowEvaluator({ providers, router, autoJudge: judge, rate: 1, budgetUsd: 1000, random: lcg(1234) });

    shadow.maybeShadow({ messages: msgs('rate the response to: write code that does not exist'), served: servedResult({ provider: 'p', model: 'served-model' }), options: {}, headers: {} });
    await flush();

    assert.equal(judge.enqueued.length, 1);
    const battle = store.getBattle(judge.enqueued[0]);
    const challengerEntry = battle.entries.find(e => e.position === 2);
    assert.ok(['strong', 'weak'].includes(challengerEntry.model));
  });
});

describe('ShadowEvaluator: end-to-end battle creation', () => {
  it('creates a shadow battle with the served response at position 1 and enqueues the judge', async () => {
    const providers = new Map([
      ['challenger-provider', fakeProvider({
        name: 'challenger-provider', models: [{ id: 'challenger-model', costPer1kInput: 0.5, costPer1kOutput: 0.5 }],
        chat: async (m, o) => ({ content: 'challenger answer', model: o.model, inputTokens: 12, outputTokens: 6, latencyMs: 30 }),
      })],
    ]);
    const router = new Router(providers);
    const judge = fakeAutoJudge();
    const shadow = new ShadowEvaluator({ providers, router, autoJudge: judge, rate: 1, budgetUsd: 1000, random: () => 0 });

    shadow.maybeShadow({
      messages: msgs('compare these two'),
      served: servedResult({ provider: 'served-provider', model: 'served-model', content: 'served answer' }),
      options: { temperature: 0.4, maxTokens: 256 },
      headers: {},
    });
    await flush();

    assert.equal(judge.enqueued.length, 1);
    const battle = store.getBattle(judge.enqueued[0]);
    assert.equal(battle.origin, 'shadow');
    assert.equal(battle.entries.length, 2);
    const [served, challenger] = battle.entries;
    assert.equal(served.position, 1);
    assert.equal(served.model, 'served-model');
    assert.equal(served.response, 'served answer');
    assert.equal(challenger.position, 2);
    assert.equal(challenger.model, 'challenger-model');
    assert.equal(challenger.response, 'challenger answer');
  });

  it('does not enqueue the judge when the challenger call fails', async () => {
    const providers = new Map([
      ['flaky', fakeProvider({ name: 'flaky', models: [{ id: 'flaky-model', costPer1kInput: 0.1, costPer1kOutput: 0.1 }], chat: async () => { throw new Error('down'); } })],
    ]);
    const router = new Router(providers);
    const judge = fakeAutoJudge();
    const shadow = new ShadowEvaluator({ providers, router, autoJudge: judge, rate: 1, budgetUsd: 1000, random: () => 0 });

    shadow.maybeShadow({ messages: msgs('will fail'), served: servedResult({ provider: 'served-provider', model: 'served-model' }), options: {}, headers: {} });
    await flush();
    assert.equal(judge.enqueued.length, 0);
  });
});
