import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-router-')), 'test.db');
delete process.env.PRISM_POOL;
delete process.env.PRISM_VALUE_CONFIDENCE;
delete process.env.DEFAULT_STRATEGY;

const { Router, STRATEGIES, PrismRoutingError, blendedCostPer1k } = await import('../src/proxy/router.js');
const { MockProvider } = await import('../src/proxy/providers/mock.js');
const store = await import('../src/db/store.js');

const msgs = text => [{ role: 'user', content: text }];

function fakeProvider({ name, models, local = false, supportsTools = false, chat, estimateCost }) {
  return {
    name,
    available: true,
    local,
    supportsTools,
    models,
    getModel: id => models.find(m => m.id === id) || null,
    chat,
    estimateCost: estimateCost || ((inTok, outTok, modelId) => {
      const m = models.find(x => x.id === modelId);
      if (!m || m.costPer1kInput == null) return 0;
      return (inTok / 1000) * m.costPer1kInput + (outTok / 1000) * m.costPer1kOutput;
    }),
  };
}

async function okChat(model, { content = 'ok', finishReason = 'stop' } = {}) {
  return { content, model, inputTokens: 10, outputTokens: 5, latencyMs: 5, finishReason };
}

async function drain(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

describe('STRATEGIES', () => {
  it('lists the five selectable strategies, not "specific"', () => {
    assert.deepEqual(STRATEGIES, ['best', 'value', 'cheapest', 'fastest', 'round-robin']);
  });
});

describe('Router.getPool', () => {
  it('includes every model from non-OpenRouter providers', () => {
    const providers = new Map([
      ['openai', fakeProvider({ name: 'openai', models: [{ id: 'gpt-x', name: 'GPT X', costPer1kInput: 1, costPer1kOutput: 2 }] })],
      ['anthropic', fakeProvider({ name: 'anthropic', models: [{ id: 'claude-x', name: 'Claude X', costPer1kInput: 1, costPer1kOutput: 2 }] })],
    ]);
    const pool = new Router(providers).getPool();
    assert.deepEqual(pool.map(p => p.model).sort(), ['claude-x', 'gpt-x']);
  });

  it('excludes OpenRouter models that have never been compared, includes ones that have', () => {
    const providers = new Map([
      ['openrouter', fakeProvider({ name: 'openrouter', models: [{ id: 'or/unused', costPer1kInput: 1, costPer1kOutput: 1 }, { id: 'or/used', costPer1kInput: 1, costPer1kOutput: 1 }] })],
    ]);
    const router = new Router(providers);
    assert.deepEqual(router.getPool(), []);

    store.addComparison({ modelA: 'or/used', modelB: 'somewhere-else', outcome: 'a', taskType: 'general', source: 'human' });
    assert.deepEqual(router.getPool().map(p => p.model), ['or/used']);
  });

  it('routes among curated models, not every model a live catalog lists', () => {
    const providers = new Map([
      ['openai', fakeProvider({
        name: 'openai',
        models: [
          { id: 'flagship', featured: true, costPer1kInput: 0.01, costPer1kOutput: 0.05 },
          { id: 'legacy-2023', featured: false, costPer1kInput: 0.0001, costPer1kOutput: 0.0001 },
          { id: 'snapshot-0613', featured: false },
        ],
        chat: (m, o) => okChat(o.model),
      })],
    ]);
    const router = new Router(providers);
    assert.deepEqual(router.getPool().map(p => p.model), ['flagship']);
    assert.equal(router.rank('cheapest')[0].model, 'flagship', 'a discovered legacy model must not win "cheapest" by default');
    assert.deepEqual(router.getAllModels().map(p => p.model), ['flagship', 'legacy-2023', 'snapshot-0613']);
  });

  it('still lets a request name a model outside the pool, and adds it once it has been compared', async () => {
    const providers = new Map([
      ['openai', fakeProvider({
        name: 'openai',
        models: [{ id: 'curated', featured: true }, { id: 'niche-model', featured: false }],
        chat: (m, o) => okChat(o.model),
      })],
    ]);
    const router = new Router(providers);
    const result = await router.route(msgs('hi'), { model: 'niche-model' });
    assert.equal(result.model, 'niche-model');
    assert.ok(!router.getPool().some(p => p.model === 'niche-model'));

    store.addComparison({ modelA: 'niche-model', modelB: 'curated', outcome: 'a', taskType: 'general', source: 'human' });
    assert.ok(router.getPool().some(p => p.model === 'niche-model'));
  });

  it('PRISM_POOL pins the pool regardless of provider', () => {
    const providers = new Map([
      ['openai', fakeProvider({ name: 'openai', models: [{ id: 'gpt-a' }, { id: 'gpt-b' }] })],
    ]);
    process.env.PRISM_POOL = 'gpt-b';
    try {
      assert.deepEqual(new Router(providers).getPool().map(p => p.model), ['gpt-b']);
    } finally {
      delete process.env.PRISM_POOL;
    }
  });
});

describe('Router.findModelByName', () => {
  const providers = new Map([
    ['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-4o' }, { id: 'gpt-4-turbo' }, { id: 'gpt-4' }] })],
  ]);
  const router = new Router(providers);

  it('matches exactly, case-insensitively', () => {
    assert.equal(router.findModelByName('GPT-4O').model, 'gpt-4o');
  });

  it('never substring-matches: "gpt-4" resolves to the exact model, not gpt-4o via substring', () => {
    // gpt-4 exists exactly, so it must resolve to itself, not to gpt-4o.
    assert.equal(router.findModelByName('gpt-4').model, 'gpt-4');
  });

  it('returns null for an ambiguous prefix', () => {
    const ambiguous = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'foo-1' }, { id: 'foo-2' }] })]]);
    assert.equal(new Router(ambiguous).findModelByName('foo'), null);
  });

  it('resolves a unique prefix', () => {
    const unique = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'mock-careful' }, { id: 'mock-quick' }] })]]);
    assert.equal(new Router(unique).findModelByName('mock-car').model, 'mock-careful');
  });

  it('returns null for a non-string or unknown name', () => {
    assert.equal(router.findModelByName(42), null);
    assert.equal(router.findModelByName('nonexistent-xyz'), null);
    assert.equal(router.findModelByName(''), null);
  });
});

describe('rank: cheapest', () => {
  it('orders by blended price ascending and pushes unknown-price models to the end unless local', () => {
    const providers = new Map([
      ['p', fakeProvider({
        name: 'p', models: [
          { id: 'pricey', costPer1kInput: 1, costPer1kOutput: 1 },
          { id: 'cheap', costPer1kInput: 0.01, costPer1kOutput: 0.01 },
          { id: 'unknown-price', costPer1kInput: null, costPer1kOutput: null },
        ],
      })],
      ['mock', fakeProvider({ name: 'mock', local: true, models: [{ id: 'free', costPer1kInput: null, costPer1kOutput: null }] })],
    ]);
    const ranked = new Router(providers).rank('cheapest');
    assert.deepEqual(ranked.map(r => r.model), ['free', 'cheap', 'pricey', 'unknown-price']);
    assert.match(ranked[3].reason, /unknown/i);
  });
});

describe('rank: fastest', () => {
  it('prefers the lower average latency once at least 3 samples exist', () => {
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'slow' }, { id: 'fast' }, { id: 'unmeasured' }] })],
    ]);
    for (let i = 0; i < 3; i++) {
      store.logRequest({ provider: 'p', model: 'slow', strategy: 'fastest', promptPreview: '', inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 900, costUsd: 0, status: 'ok', errorMessage: null, taskType: 'general' });
      store.logRequest({ provider: 'p', model: 'fast', strategy: 'fastest', promptPreview: '', inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 100, costUsd: 0, status: 'ok', errorMessage: null, taskType: 'general' });
    }
    const ranked = new Router(providers).rank('fastest');
    assert.deepEqual(ranked.map(r => r.model), ['fast', 'slow', 'unmeasured']);
  });

  it('does not count a failed call as fast', () => {
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'flaky-but-fast' }] })],
    ]);
    for (let i = 0; i < 3; i++) {
      store.logRequest({ provider: 'p', model: 'flaky-but-fast', strategy: 'fastest', promptPreview: '', inputTokens: 1, outputTokens: 0, totalTokens: 1, latencyMs: 5, costUsd: 0, status: 'error', errorMessage: 'boom', taskType: 'general' });
    }
    const ranked = new Router(providers).rank('fastest');
    assert.equal(ranked[0].reason, 'No latency data yet');
  });
});

describe('rank: best and value (Bradley-Terry semantics via real comparisons)', () => {
  const providers = new Map([
    ['p', fakeProvider({
      name: 'p', models: [
        { id: 'alpha', costPer1kInput: 1, costPer1kOutput: 1 },
        { id: 'beta', costPer1kInput: 0.01, costPer1kOutput: 0.01 },
        { id: 'gamma', costPer1kInput: 0.02, costPer1kOutput: 0.02 },
      ],
    })],
  ]);
  const router = new Router(providers);

  // alpha vs beta is close (3-2): the data cannot confidently call beta worse.
  // alpha vs gamma is one-sided (5-0): gamma is clearly worse, despite gamma
  // also being cheap — "value" must not pick on price alone.
  before(() => {
    for (let i = 0; i < 3; i++) store.addComparison({ modelA: 'alpha', modelB: 'beta', outcome: 'a', taskType: 'general', source: 'human' });
    for (let i = 0; i < 2; i++) store.addComparison({ modelA: 'alpha', modelB: 'beta', outcome: 'b', taskType: 'general', source: 'human' });
    for (let i = 0; i < 5; i++) store.addComparison({ modelA: 'alpha', modelB: 'gamma', outcome: 'a', taskType: 'general', source: 'human' });
  });

  it('"best" picks the highest-rated model', () => {
    const ranked = router.rank('best', 'general');
    assert.equal(ranked[0].model, 'alpha');
    assert.ok(ranked[0].reason.includes('highest rated'));
    assert.ok(ranked.every(r => r.model === 'alpha' || !r.reason.includes('highest rated')));
  });

  it('every candidate has enough games to be rated', () => {
    const ranked = router.rank('best', 'general');
    assert.ok(ranked.every(r => /Rated \d+ for/.test(r.reason)));
  });

  it('"value" picks the cheap model that is not shown worse than the leader, not the clearly-worse cheap one', () => {
    const ranked = router.rank('value', 'general');
    assert.equal(ranked[0].model, 'beta');
    assert.ok(ranked[0].reason.includes('leader alpha'));
    const gammaEntry = ranked.find(r => r.model === 'gamma');
    assert.ok(gammaEntry, 'gamma must still appear, for failover');
    assert.notEqual(ranked[0].model, 'gamma');
  });

  it('PRISM_VALUE_CONFIDENCE tightens or loosens the "not worse" bar', () => {
    process.env.PRISM_VALUE_CONFIDENCE = '0.001';
    try {
      const strict = router.rank('value', 'general');
      // At near-certainty required, beta's 3-2 split no longer clears the bar,
      // so only the leader itself remains a safe, self-evidently-not-worse pick.
      assert.equal(strict[0].model, 'alpha');
    } finally {
      delete process.env.PRISM_VALUE_CONFIDENCE;
    }
  });

  it('falls back to pooled ratings when fewer than two models are rated for the requested task type', () => {
    const ranked = router.rank('best', 'code'); // no comparisons recorded under 'code'
    assert.equal(ranked[0].model, 'alpha');
  });

  it('"value" with no rated models anywhere falls back to cheapest', () => {
    const freshProviders = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'delta', costPer1kInput: 5, costPer1kOutput: 5 }, { id: 'epsilon', costPer1kInput: 0.1, costPer1kOutput: 0.1 }] })],
    ]);
    const ranked = new Router(freshProviders).rank('value', 'never-used-task-type');
    assert.equal(ranked[0].model, 'epsilon');
    assert.match(ranked[0].reason, /falling back to cheapest/);
  });

  it('"best" with no rated models anywhere uses the first pool model and says so', () => {
    const freshProviders = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'first-model' }, { id: 'second-model' }] })],
    ]);
    const ranked = new Router(freshProviders).rank('best', 'another-unused-task-type');
    assert.equal(ranked[0].model, 'first-model');
    assert.match(ranked[0].reason, /No rated comparisons yet/);
  });
});

describe('rank: round-robin', () => {
  it('rotates on every call and wraps around', () => {
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })],
    ]);
    const router = new Router(providers);
    const picks = [router.rank('round-robin')[0].model, router.rank('round-robin')[0].model, router.rank('round-robin')[0].model, router.rank('round-robin')[0].model];
    assert.deepEqual(picks, ['a', 'b', 'c', 'a']);
  });
});

describe('Router.route: model resolution and parameters', () => {
  it('routes to a specifically requested model and returns requestId + content', async () => {
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x', costPer1kInput: 1, costPer1kOutput: 1 }], chat: (m, o) => okChat(o.model) })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { model: 'gpt-x' });
    assert.equal(result.model, 'gpt-x');
    assert.equal(result.content, 'ok');
    assert.ok(result.requestId);
    assert.equal(result.prism.strategy, 'specific');
    assert.equal(result.prism.failover, false);
  });

  it('rejects an unknown model with MODEL_NOT_FOUND', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }] })]]);
    await assert.rejects(
      () => new Router(providers).route(msgs('hi'), { model: 'nonexistent' }),
      err => err instanceof PrismRoutingError && err.code === 'MODEL_NOT_FOUND' && err.status === 404,
    );
  });

  it('rejects a non-string model with INVALID_MODEL 400', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }] })]]);
    await assert.rejects(
      () => new Router(providers).route(msgs('hi'), { model: { not: 'a string' } }),
      err => err instanceof PrismRoutingError && err.code === 'INVALID_MODEL' && err.status === 400,
    );
  });

  it('forwards temperature 0 to the provider unchanged', async () => {
    let seenTemperature;
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }], chat: (m, o) => { seenTemperature = o.temperature; return okChat(o.model); } })],
    ]);
    await new Router(providers).route(msgs('hi'), { model: 'gpt-x', temperature: 0 });
    assert.equal(seenTemperature, 0);
  });

  it('rejects with NO_MODELS_AVAILABLE when the pool is empty', async () => {
    await assert.rejects(
      () => new Router(new Map()).route(msgs('hi'), {}),
      err => err instanceof PrismRoutingError && err.code === 'NO_MODELS_AVAILABLE' && err.status === 503,
    );
  });
});

describe('Router.route: cost accounting', () => {
  it('reports cost_usd as null, not 0, for a served model with an unknown price', async () => {
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'mystery', costPer1kInput: null, costPer1kOutput: null }], chat: (m, o) => okChat(o.model) })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { model: 'mystery' });
    assert.equal(result.prism.cost_usd, null);

    const row = store.getRecentRequests(1)[0];
    assert.equal(row.model, 'mystery');
    assert.equal(row.cost_usd, null);
  });

  it('still computes a real cost_usd when both prices are known', async () => {
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', models: [{ id: 'priced', costPer1kInput: 1, costPer1kOutput: 2 }], chat: (m, o) => okChat(o.model) })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { model: 'priced' });
    // okChat() reports inputTokens: 10, outputTokens: 5 -> 10/1000*1 + 5/1000*2 = 0.02
    assert.equal(result.prism.cost_usd, 0.02);
  });
});

describe('Router.route: tools routing', () => {
  it('only routes tool calls to a supportsTools provider, even if a non-supporting one is cheaper', async () => {
    const providers = new Map([
      ['cheap-no-tools', fakeProvider({ name: 'cheap-no-tools', supportsTools: false, models: [{ id: 'cheap-model', costPer1kInput: 0.001, costPer1kOutput: 0.001 }], chat: (m, o) => okChat(o.model) })],
      ['tooled', fakeProvider({ name: 'tooled', supportsTools: true, models: [{ id: 'tooled-model', costPer1kInput: 1, costPer1kOutput: 1 }], chat: (m, o) => okChat(o.model) })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { strategy: 'cheapest', tools: [{ type: 'function', function: { name: 'x' } }] });
    assert.equal(result.model, 'tooled-model');
  });

  it('rejects a specific model that does not support tools with TOOLS_UNSUPPORTED 400', async () => {
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', supportsTools: false, models: [{ id: 'gpt-x' }] })],
    ]);
    await assert.rejects(
      () => new Router(providers).route(msgs('hi'), { model: 'gpt-x', tools: [{ type: 'function', function: { name: 'x' } }] }),
      err => err instanceof PrismRoutingError && err.code === 'TOOLS_UNSUPPORTED' && err.status === 400,
    );
  });

  it('rejects with TOOLS_UNSUPPORTED when no pool model supports tools', async () => {
    const providers = new Map([
      ['p', fakeProvider({ name: 'p', supportsTools: false, models: [{ id: 'gpt-x' }] })],
    ]);
    await assert.rejects(
      () => new Router(providers).route(msgs('hi'), { strategy: 'best', tools: [{ type: 'function', function: { name: 'x' } }] }),
      err => err instanceof PrismRoutingError && err.code === 'TOOLS_UNSUPPORTED',
    );
  });
});

describe('Router.route: failover', () => {
  it('fails over to another model on the same provider when it is the only provider (retryable)', async () => {
    const provider = new MockProvider({ mock: { enabled: true, latencyScale: 0, fail: ['mock-quick'] } });
    const providers = new Map([['mock', provider]]);
    const result = await new Router(providers).route(msgs('hello there'), { strategy: 'cheapest' });
    assert.notEqual(result.model, 'mock-quick');
    assert.equal(result.prism.failover, true);
    assert.equal(result.prism.original_model, 'mock-quick');

    const rows = store.getRecentRequests(5);
    assert.ok(rows.some(r => r.model === 'mock-quick' && r.status === 'error'));
    assert.ok(rows.some(r => r.model === result.model && r.status === 'ok'));
  });

  it('does not answer a request for a named model with a different model', async () => {
    let otherCalls = 0;
    const providers = new Map([
      ['down', fakeProvider({
        name: 'down', models: [{ id: 'wanted' }],
        chat: () => { const err = new Error('upstream 503'); err.status = 503; err.retryable = true; throw err; },
      })],
      ['up', fakeProvider({ name: 'up', models: [{ id: 'other' }], chat: (m, o) => { otherCalls++; return okChat(o.model); } })],
    ]);
    await assert.rejects(
      () => new Router(providers).route(msgs('hi'), { model: 'wanted' }),
      err => err instanceof PrismRoutingError && err.code === 'ALL_PROVIDERS_FAILED',
    );
    assert.equal(otherCalls, 0, 'the caller asked for "wanted"; nothing else may answer');
  });

  it('hands a named model’s own 4xx back to the caller', async () => {
    for (const status of [404, 422, 429]) {
      const providers = new Map([
        ['gone', fakeProvider({
          name: 'gone', models: [{ id: 'retired-model' }],
          chat: () => { const err = new Error(`upstream said ${status}`); err.status = status; err.retryable = status === 429; throw err; },
        })],
      ]);
      await assert.rejects(
        () => new Router(providers).route(msgs('hi'), { model: 'retired-model' }),
        err => err instanceof PrismRoutingError && err.code === 'UPSTREAM_CLIENT_ERROR' && err.status === status,
        `a ${status} from the provider should reach the caller as a ${status}`,
      );
    }
  });

  it('leaves the failing provider before trying its other models', async () => {
    const tried = [];
    const failing = (m, o) => { tried.push(o.model); const err = new Error('upstream 503'); err.status = 503; err.retryable = true; throw err; };
    const providers = new Map([
      ['alpha', fakeProvider({ name: 'alpha', models: [{ id: 'a1', costPer1kInput: 0.001, costPer1kOutput: 0.001 }, { id: 'a2', costPer1kInput: 0.002, costPer1kOutput: 0.002 }], chat: failing })],
      ['beta', fakeProvider({ name: 'beta', models: [{ id: 'b1', costPer1kInput: 0.003, costPer1kOutput: 0.003 }], chat: (m, o) => { tried.push(o.model); return okChat(o.model); } })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { strategy: 'cheapest' });
    assert.equal(result.model, 'b1');
    assert.deepEqual(tried, ['a1', 'b1'], 'a2 is cheaper than b1, but alpha just failed');
  });

  it('tries providers with a run of failures last, not first', async () => {
    const tried = [];
    const providers = new Map([
      ['shaky', fakeProvider({ name: 'shaky', models: [{ id: 's1', costPer1kInput: 0.001, costPer1kOutput: 0.001 }], chat: (m, o) => { tried.push(o.model); return okChat(o.model); } })],
      ['steady', fakeProvider({ name: 'steady', models: [{ id: 't1', costPer1kInput: 0.002, costPer1kOutput: 0.002 }], chat: (m, o) => { tried.push(o.model); return okChat(o.model); } })],
    ]);
    for (let i = 0; i < 3; i++) store.updateProviderHealth('shaky', 'degraded');
    const result = await new Router(providers).route(msgs('hi'), { strategy: 'cheapest' });
    assert.equal(result.model, 't1', 'the cheapest model sits on a provider that keeps failing');
    assert.deepEqual(tried, ['t1']);
    store.updateProviderHealth('shaky', 'healthy', 10);
  });

  it('skips a provider that failed with a non-retryable client error (400/401/403) and fails over to a healthy one', async () => {
    let badAttempts = 0;
    const providers = new Map([
      ['bad', fakeProvider({
        name: 'bad', models: [{ id: 'x' }],
        chat: () => { badAttempts++; const err = new Error('bad api key'); err.status = 401; err.retryable = false; throw err; },
      })],
      ['good', fakeProvider({ name: 'good', models: [{ id: 'y' }], chat: (m, o) => okChat(o.model) })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { strategy: 'cheapest' });
    assert.equal(result.model, 'y');
    assert.equal(badAttempts, 1, 'the bad provider is tried once, then skipped, not retried');

    const rows = store.getRecentRequests(5);
    assert.ok(rows.some(r => r.model === 'x' && r.status === 'error'));
    assert.ok(rows.some(r => r.model === 'y' && r.status === 'ok'));
  });

  it('surfaces the last provider\'s own status/message when every candidate fails non-retryably', async () => {
    const providers = new Map([
      ['bad-one', fakeProvider({
        name: 'bad-one', models: [{ id: 'x' }],
        chat: () => { const err = new Error('bad api key'); err.status = 401; err.retryable = false; throw err; },
      })],
      ['bad-two', fakeProvider({
        name: 'bad-two', models: [{ id: 'y' }],
        chat: () => { const err = new Error('also bad'); err.status = 403; err.retryable = false; throw err; },
      })],
    ]);
    await assert.rejects(
      () => new Router(providers).route(msgs('hi'), { strategy: 'cheapest' }),
      err => err instanceof PrismRoutingError && err.code === 'UPSTREAM_CLIENT_ERROR' && err.status === 403,
    );
  });

  it('a client-side abort mid-flight is not recorded as a provider health failure', async () => {
    let chatStarted = false;
    const providers = new Map([
      ['flaky-on-abort', fakeProvider({
        name: 'flaky-on-abort', models: [{ id: 'm' }],
        chat: (m, o) => new Promise((resolve, reject) => {
          chatStarted = true;
          o.signal?.addEventListener('abort', () => {
            const err = new Error('upstream fetch aborted');
            err.retryable = true;
            reject(err);
          });
        }),
      })],
    ]);
    const controller = new AbortController();
    const routePromise = new Router(providers).route(msgs('hi'), { model: 'm', signal: controller.signal });
    assert.ok(chatStarted, 'the provider call must already be in flight before we abort');
    controller.abort();

    await assert.rejects(routePromise, err => err instanceof PrismRoutingError && err.code === 'ABORTED');
    const health = store.getProviderHealth().find(h => h.provider === 'flaky-on-abort');
    assert.ok(!health, 'a client abort must never touch that provider\'s health record');
  });

  it('skips a provider in getUnhealthyProviders() in the failover order, but still tries the primary pick regardless of health', async () => {
    store.updateProviderHealth('unhealthy-provider', 'degraded');
    store.updateProviderHealth('unhealthy-provider', 'degraded');
    store.updateProviderHealth('unhealthy-provider', 'degraded');
    assert.ok(store.getUnhealthyProviders().includes('unhealthy-provider'));

    const providers = new Map([
      ['primary-fails', fakeProvider({
        name: 'primary-fails', models: [{ id: 'a', costPer1kInput: 0.001, costPer1kOutput: 0.001 }],
        chat: () => { const err = new Error('flaky'); err.status = 503; err.retryable = true; throw err; },
      })],
      ['unhealthy-provider', fakeProvider({ name: 'unhealthy-provider', models: [{ id: 'b', costPer1kInput: 0.002, costPer1kOutput: 0.002 }], chat: (m, o) => okChat(o.model) })],
      ['healthy-fallback', fakeProvider({ name: 'healthy-fallback', models: [{ id: 'c', costPer1kInput: 0.003, costPer1kOutput: 0.003 }], chat: (m, o) => okChat(o.model) })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { strategy: 'cheapest' });
    assert.equal(result.model, 'c');
    assert.equal(result.prism.provider, 'healthy-fallback');
  });

  it('respects an already-aborted signal instead of attempting any provider', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'x' }], chat: (m, o) => okChat(o.model) })]]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => new Router(providers).route(msgs('hi'), { model: 'x', signal: controller.signal }),
      err => err instanceof PrismRoutingError && err.code === 'ABORTED',
    );
  });
});

describe('Router.route: streaming', () => {
  it('pulls the first chunk before returning, so a dead first-chunk read fails over instead of surfacing mid-stream', async () => {
    async function* deadStream() {
      const err = new Error('connection refused');
      err.retryable = true;
      throw err;
    }
    const providers = new Map([
      ['dead', fakeProvider({ name: 'dead', models: [{ id: 'dead-model' }], chat: async (m, o) => (o.stream ? deadStream() : okChat(o.model)) })],
      ['ok', fakeProvider({
        name: 'ok', models: [{ id: 'ok-model' }],
        chat: async (m, o) => {
          if (!o.stream) return okChat(o.model);
          async function* gen() {
            yield { type: 'delta', content: 'hi ' };
            yield { type: 'delta', content: 'there' };
            yield { type: 'done', model: o.model, inputTokens: 10, outputTokens: 2, latencyMs: 5, finishReason: 'stop' };
          }
          return gen();
        },
      })],
    ]);
    process.env.PRISM_POOL = 'dead-model,ok-model';
    try {
      const result = await new Router(providers).route(msgs('hi'), { strategy: 'cheapest', stream: true });
      assert.equal(result.model, 'ok-model');
      assert.equal(result.prism.failover, true);
      const chunks = await drain(result.stream);
      assert.equal(chunks.filter(c => c.type === 'delta').map(c => c.content).join(''), 'hi there');
    } finally {
      delete process.env.PRISM_POOL;
    }
  });

  it('never yields the done chunk\'s data as an extra delta, and updateRequestUsage runs once the stream ends', async () => {
    const providers = new Map([
      ['p', fakeProvider({
        name: 'p', models: [{ id: 'stream-model', costPer1kInput: 1, costPer1kOutput: 1 }],
        chat: async (m, o) => {
          async function* gen() {
            yield { type: 'delta', content: 'a' };
            yield { type: 'delta', content: 'b' };
            yield { type: 'done', model: o.model, inputTokens: 7, outputTokens: 3, latencyMs: 9, finishReason: 'stop' };
          }
          return gen();
        },
      })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { model: 'stream-model', stream: true });
    const chunks = await drain(result.stream);
    const deltas = chunks.filter(c => c.type === 'delta');
    assert.deepEqual(deltas.map(c => c.content), ['a', 'b']);
    const done = chunks.find(c => c.type === 'done');
    assert.equal(done.content, undefined, 'the done chunk must carry no content');

    const row = store.getRecentRequests(1)[0];
    assert.equal(row.output_tokens, 3);
    assert.ok(row.cost_usd > 0);
  });

  it('treats a stream that ends without ever emitting a done chunk as an error, not a silent stop', async () => {
    const providers = new Map([
      ['p', fakeProvider({
        name: 'p', models: [{ id: 'truncated-model' }],
        chat: async (m, o) => {
          async function* gen() {
            yield { type: 'delta', content: 'partial' };
            // Ends with no 'done' chunk — simulates an upstream connection
            // drop after the last delta but before the provider's own code
            // could construct and yield its synthetic 'done' event.
          }
          return gen();
        },
      })],
    ]);
    const result = await new Router(providers).route(msgs('hi'), { model: 'truncated-model', stream: true });
    const seen = [];
    await assert.rejects(
      async () => { for await (const c of result.stream) seen.push(c); },
      /done event/i,
    );
    assert.deepEqual(seen.map(c => c.content), ['partial'], 'chunks already produced must still reach the consumer before the error');
  });
});
