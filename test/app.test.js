import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-app-')), 'test.db');
delete process.env.PRISM_SECRET;
delete process.env.CORS_ORIGIN;
delete process.env.ALLOWED_HOSTS;
delete process.env.PRISM_POOL;

const { createApp } = await import('../src/index.js');
const { MockProvider } = await import('../src/proxy/providers/mock.js');
const { closeDb } = await import('../src/db/store.js');

const mockProviders = () => new Map([['mock', new MockProvider({ mock: { enabled: true, latencyScale: 0 } })]]);

async function serve(config) {
  const built = await createApp({ providers: mockProviders(), host: 'localhost', ...config });
  const server = await new Promise(resolve => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return { ...built, server, port, url: `http://127.0.0.1:${port}` };
}

// fetch() will not let a caller set Host, so the rebinding check needs a raw request.
function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('server hardening', () => {
  let ctx;
  before(async () => { ctx = await serve({}); });
  after(() => ctx.server.close());

  it('answers health checks and serves the dashboard', async () => {
    const health = await fetch(`${ctx.url}/health`).then(r => r.json());
    assert.equal(health.status, 'ok');
    const page = await fetch(`${ctx.url}/dashboard/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /style-src 'self'/);
  });

  it('rejects a Host header that is not a loopback name', async () => {
    assert.equal(await rawGet(ctx.port, '/health', { Host: 'attacker.example' }), 421);
    assert.equal(await rawGet(ctx.port, '/health', { Host: `localhost:${ctx.port}` }), 200);
    assert.equal(await rawGet(ctx.port, '/health', { Host: '[::1]:3080' }), 200);
  });

  it('sends no CORS headers unless an origin is configured', async () => {
    const response = await fetch(`${ctx.url}/health`, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('reports malformed JSON as a 400, not a 500', async () => {
    const response = await post(`${ctx.url}/v1/chat/completions`, '{not json');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_json');
  });

  it('describes itself at /api/config without leaking anything', async () => {
    const config = await fetch(`${ctx.url}/api/config`).then(r => r.json());
    assert.equal(config.demo, true);
    assert.equal(config.authRequired, false);
    assert.ok(config.strategies.includes('value'));
    assert.deepEqual(config.taskTypes, ['code', 'analysis', 'creative', 'general']);
    assert.ok(!JSON.stringify(config).toLowerCase().includes('secret'));
  });
});

describe('configured CORS origin', () => {
  it('is echoed exactly, never as a wildcard', async () => {
    const ctx = await serve({ corsOrigin: 'https://app.example' });
    try {
      const response = await fetch(`${ctx.url}/health`);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example');
    } finally {
      ctx.server.close();
    }
  });
});

describe('bearer token auth', () => {
  let ctx;
  const secret = 'pässword-with-ünicode';
  before(async () => { ctx = await serve({ secret }); });
  after(() => ctx.server.close());

  it('guards the API and leaves the dashboard, health and config open', async () => {
    assert.equal((await fetch(`${ctx.url}/api/stats`)).status, 401);
    assert.equal((await fetch(`${ctx.url}/arena/leaderboard`)).status, 401);
    assert.equal((await fetch(`${ctx.url}/health`)).status, 200);
    assert.equal((await fetch(`${ctx.url}/dashboard/`)).status, 200);
    const config = await fetch(`${ctx.url}/api/config`).then(r => r.json());
    assert.equal(config.authRequired, true);
  });

  it('accepts the right token and rejects wrong ones of any length', async () => {
    const auth = token => fetch(`${ctx.url}/api/stats`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.status);
    assert.equal(await auth(secret), 200, 'secret sent as latin1, as a browser would');
    assert.equal(await auth(Buffer.from(secret, 'utf8').toString('latin1')), 200, 'secret sent as UTF-8 bytes, as curl would');
    assert.equal(await auth('x'), 401);
    assert.equal(await auth('x'.repeat(500)), 401);
    assert.equal(await auth(''), 401);
  });

  it('does not treat a path that merely starts with "/dashboard" as open', async () => {
    assert.equal((await fetch(`${ctx.url}/dashboardx/../api/stats`)).status, 401);
  });
});

describe('guessing the token', () => {
  it('locks an address out after twenty wrong tokens, even for the right one', async () => {
    const ctx = await serve({ secret: 'correct-horse' });
    try {
      const attempt = token => fetch(`${ctx.url}/api/stats`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.status);
      for (let i = 0; i < 20; i++) assert.equal(await attempt(`guess-${i}`), 401);
      assert.equal(await attempt('guess-21'), 429);
      assert.equal(await attempt('correct-horse'), 429, 'the lockout is on the address, so a lucky guess during it gets nowhere');
      assert.equal((await fetch(`${ctx.url}/health`)).status, 200, 'open paths stay open');
    } finally {
      ctx.server.close();
    }
  });
});

describe('wildcard CORS', () => {
  it('is refused rather than honoured', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    const ctx = await serve({ corsOrigin: '*' });
    console.warn = originalWarn;
    try {
      const response = await fetch(`${ctx.url}/health`, { headers: { Origin: 'https://attacker.example' } });
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    } finally {
      ctx.server.close();
    }
  });
});

describe('end to end on mock models', () => {
  let ctx;
  before(async () => { ctx = await serve({}); });
  after(() => { ctx.server.close(); });

  it('proxies a chat completion and says why it chose the model', async () => {
    const response = await post(`${ctx.url}/v1/chat/completions`, {
      messages: [{ role: 'user', content: 'Write a Python function that merges two sorted lists' }],
      strategy: 'cheapest',
      temperature: 0,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, 'mock-quick');
    assert.ok(body.choices[0].message.content.length > 0);
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.prism.task_type, 'code');
    assert.match(body.prism.routing_reason, /cheap/i);
  });

  it('treats model "auto" as "let Prism choose"', async () => {
    const response = await post(`${ctx.url}/v1/chat/completions`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
      strategy: 'cheapest',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, 'mock-quick');
  });

  it('streams each token exactly once', async () => {
    const plain = await post(`${ctx.url}/v1/chat/completions`, {
      model: 'mock-balanced', messages: [{ role: 'user', content: 'Explain the tradeoffs of caching' }],
    }).then(r => r.json());

    const response = await post(`${ctx.url}/v1/chat/completions`, {
      model: 'mock-balanced', stream: true, messages: [{ role: 'user', content: 'Explain the tradeoffs of caching' }],
    });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    const frames = text.split('\n\n').filter(f => f.startsWith('data: ')).map(f => f.slice(6));
    assert.equal(frames.at(-1), '[DONE]');
    const chunks = frames.slice(0, -1).map(f => JSON.parse(f));
    const streamed = chunks.map(c => c.choices?.[0]?.delta?.content || '').join('');
    assert.equal(streamed, plain.choices[0].message.content);
    assert.equal(chunks.filter(c => c.choices?.[0]?.finish_reason).length, 1);
  });

  it('runs a blind comparison, takes a vote, reveals, and rates', async () => {
    const battle = await post(`${ctx.url}/arena/battle`, {
      prompt: 'Compare the pros and cons of SQLite and Postgres for a single-user app',
      models: ['mock-careful', 'mock-quick'],
      autoJudge: false,
    }).then(r => r.json());

    assert.equal(battle.entries.length, 2);
    for (const entry of battle.entries) {
      assert.deepEqual(Object.keys(entry).filter(k => /model|provider|cost|token/i.test(k)), [], 'blind entries must not identify the model');
      assert.ok(entry.response.length > 0);
    }

    const early = await fetch(`${ctx.url}/arena/reveal/${battle.battleId}`);
    assert.equal(early.status, 403);

    const vote = await post(`${ctx.url}/arena/vote`, { battleId: battle.battleId, winnerPosition: battle.entries[0].position });
    assert.equal(vote.status, 200);
    assert.equal((await post(`${ctx.url}/arena/vote`, { battleId: battle.battleId, winnerPosition: 1 })).status, 409);

    const revealed = await fetch(`${ctx.url}/arena/reveal/${battle.battleId}`).then(r => r.json());
    assert.deepEqual(revealed.entries.map(e => e.model).sort(), ['mock-careful', 'mock-quick']);
    assert.equal(revealed.entries.filter(e => e.isWinner).length, 1);

    const board = await fetch(`${ctx.url}/arena/leaderboard?taskType=analysis&source=human`).then(r => r.json());
    assert.equal(board.comparisons, 1);
    assert.equal(board.leaderboard[0].model, revealed.entries.find(e => e.isWinner).model);
    assert.ok(board.leaderboard[0].lo <= board.leaderboard[0].rating && board.leaderboard[0].rating <= board.leaderboard[0].hi);
  });

  it('lets the judge and a person rule on the same battle, and the person wins', async () => {
    const battle = await post(`${ctx.url}/arena/battle`, {
      prompt: 'Write a function to debounce another function in JavaScript',
      models: ['mock-careful', 'mock-quick'],
      autoJudge: false,
    }).then(r => r.json());

    await ctx.autoJudge.evaluate(battle.battleId);
    const judged = await fetch(`${ctx.url}/arena/leaderboard?taskType=code&source=judge`).then(r => r.json());
    assert.ok(judged.comparisons >= 1, 'the judge should have recorded a comparison');

    // The judge has ruled; the person must still be able to vote, and reveal stays locked until they do.
    assert.equal((await fetch(`${ctx.url}/arena/reveal/${battle.battleId}`)).status, 403);
    assert.equal((await post(`${ctx.url}/arena/vote`, { battleId: battle.battleId, tie: true })).status, 200);

    const all = await fetch(`${ctx.url}/arena/leaderboard?taskType=code&source=all`).then(r => r.json());
    assert.equal(all.comparisons, 1, 'the human tie replaces the judge verdict for this battle');
    assert.equal(all.leaderboard[0].ties, 1);

    const judge = await fetch(`${ctx.url}/arena/judge`).then(r => r.json());
    assert.equal(judge.agreement.pairs, 1);
  });

  it('shows the cost and quality picture', async () => {
    const data = await fetch(`${ctx.url}/api/frontier`).then(r => r.json());
    const models = data.models;
    assert.ok(models.some(m => m.model === 'mock-careful'));
    for (const m of models) {
      assert.ok('onFrontier' in m && 'blendedCostPer1k' in m && 'rated' in m);
    }
  });

  it('reports shadow evaluation as off by default', async () => {
    const shadow = await fetch(`${ctx.url}/api/shadow`).then(r => r.json());
    assert.equal(shadow.enabled, false);
  });

  after(() => closeDb());
});
