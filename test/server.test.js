import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-server-')), 'test.db');

const createProxyRouter = (await import('../src/proxy/server.js')).default;
const { createRateLimiter } = await import('../src/proxy/server.js');
const { Router } = await import('../src/proxy/router.js');
const store = await import('../src/db/store.js');

function fakeProvider({ name, models, local = false, supportsTools = false, chat, estimateCost }) {
  return {
    name, available: true, local, supportsTools, models,
    getModel: id => models.find(m => m.id === id) || null,
    chat,
    estimateCost: estimateCost || ((inTok, outTok, modelId) => {
      const m = models.find(x => x.id === modelId);
      if (!m || m.costPer1kInput == null) return 0;
      return (inTok / 1000) * m.costPer1kInput + (outTok / 1000) * m.costPer1kOutput;
    }),
  };
}

async function okChat(model, extra = {}) {
  return { content: 'hello from provider', model, inputTokens: 10, outputTokens: 5, finishReason: 'stop', ...extra };
}

function fakeShadow() {
  const calls = [];
  return { calls, maybeShadow: (args) => calls.push(args), stats: () => ({ enabled: false, rate: 0, budgetUsd: 0, spentTodayUsd: 0, battlesToday: 0, judgedToday: 0 }) };
}

const INFO = { authRequired: false, demo: true, strategies: ['best', 'value', 'cheapest', 'fastest', 'round-robin'], taskTypes: ['code', 'analysis', 'creative', 'general'], defaultStrategy: 'best', version: '0.2.0-test' };

async function startServer(providers, router, opts = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(createProxyRouter(providers, router, { shadow: opts.shadow ?? fakeShadow(), info: opts.info ?? INFO }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl, close: () => new Promise(resolve => server.close(resolve)) };
}

async function readSse(response) {
  const text = await response.text();
  return text.split('\n\n').filter(Boolean).map(line => line.replace(/^data: /, ''));
}

describe('POST /v1/chat/completions — non-streaming', () => {
  it('routes, returns an OpenAI-shaped response, and lists unknown params as ignored', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x', costPer1kInput: 0.001, costPer1kOutput: 0.001 }], chat: (m, o) => okChat(o.model) })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-x', someUnknownField: 'x' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.model, 'gpt-x');
      assert.equal(body.choices[0].message.content, 'hello from provider');
      assert.equal(body.choices[0].finish_reason, 'stop');
      assert.equal(body.usage.completion_tokens, 5);
      assert.equal(body.prism.provider, 'p');
      assert.deepEqual(body.prism.ignored_params, ['someUnknownField']);
    } finally {
      await close();
    }
  });

  it('lets temperature 0 and max_tokens 0 survive to the provider', async () => {
    let seen;
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }], chat: (m, o) => { seen = o; return okChat(o.model); } })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-x', temperature: 0, max_tokens: 0 }),
      });
      assert.equal(res.status, 200);
      assert.equal(seen.temperature, 0);
      assert.equal(seen.maxTokens, 0);
    } finally {
      await close();
    }
  });

  it('forwards top_p, stop, seed, frequency_penalty, presence_penalty and response_format to the provider', async () => {
    let seen;
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }], chat: (m, o) => { seen = o; return okChat(o.model); } })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }], model: 'gpt-x',
          top_p: 0.5, stop: ['\n'], seed: 42, frequency_penalty: 0.3, presence_penalty: -0.3,
          response_format: { type: 'json_object' },
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(seen.topP, 0.5);
      assert.deepEqual(seen.stop, ['\n']);
      assert.equal(seen.seed, 42);
      assert.equal(seen.frequencyPenalty, 0.3);
      assert.equal(seen.presencePenalty, -0.3);
      assert.deepEqual(seen.responseFormat, { type: 'json_object' });
    } finally {
      await close();
    }
  });

  it('routes tools only to a supportsTools provider', async () => {
    const providers = new Map([
      ['cheap', fakeProvider({ name: 'cheap', supportsTools: false, models: [{ id: 'cheap-model', costPer1kInput: 0.001, costPer1kOutput: 0.001 }], chat: (m, o) => okChat(o.model) })],
      ['tooled', fakeProvider({ name: 'tooled', supportsTools: true, models: [{ id: 'tooled-model', costPer1kInput: 1, costPer1kOutput: 1 }], chat: (m, o) => okChat(o.model) })],
    ]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], strategy: 'cheapest', tools: [{ type: 'function', function: { name: 'x' } }] }),
      });
      const body = await res.json();
      assert.equal(body.model, 'tooled-model');
    } finally {
      await close();
    }
  });

  it('rejects a model naming a provider without tool support with 400 tools_unsupported', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', supportsTools: false, models: [{ id: 'gpt-x' }], chat: (m, o) => okChat(o.model) })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-x', tools: [{ type: 'function', function: { name: 'x' } }] }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'TOOLS_UNSUPPORTED');
    } finally {
      await close();
    }
  });

  it('400s on missing messages, non-string model, and an out-of-range temperature', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }], chat: (m, o) => okChat(o.model) })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const post = body => fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal((await post({})).status, 400);
      assert.equal((await post({ messages: [{ role: 'user', content: 'hi' }], model: 42 })).status, 400);
      assert.equal((await post({ messages: [{ role: 'user', content: 'hi' }], temperature: 'hot' })).status, 400);
    } finally {
      await close();
    }
  });

  it('maps an unknown model to 404 model_not_found with a sanitized message', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }], chat: (m, o) => okChat(o.model) })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'nonexistent' }),
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, 'MODEL_NOT_FOUND');
    } finally {
      await close();
    }
  });

  it('sanitizes a raw upstream failure into a generic message, keeping raw detail out of the response', async () => {
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    try {
      const providers = new Map([['p', fakeProvider({
        name: 'p', models: [{ id: 'gpt-x' }],
        chat: () => { const err = new Error('super secret upstream stack trace, key=sk-abc123'); err.retryable = true; throw err; },
      })]]);
      const { close, baseUrl } = await startServer(providers, new Router(providers));
      try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-x' }),
        });
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(body.error.code, 'ALL_PROVIDERS_FAILED');
        assert.ok(!JSON.stringify(body).includes('sk-abc123'));
      } finally {
        await close();
      }
      assert.ok(logged.some(l => l.includes('sk-abc123')), 'raw detail should still reach console.error');
    } finally {
      console.error = originalError;
    }
  });

  it('hands the completed request to shadow.maybeShadow without delaying the response', async () => {
    const shadow = fakeShadow();
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }], chat: (m, o) => okChat(o.model) })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers), { shadow });
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-x' }),
      });
      assert.equal(res.status, 200);
      assert.equal(shadow.calls.length, 1);
      assert.equal(shadow.calls[0].served.model, 'gpt-x');
      assert.equal(shadow.calls[0].served.content, 'hello from provider');
    } finally {
      await close();
    }
  });

  it('still hands a completed response to shadow.maybeShadow even if the client disconnected before it was sent', async () => {
    const shadow = fakeShadow();
    const providers = new Map([['p', fakeProvider({
      name: 'p', models: [{ id: 'gpt-x' }],
      chat: async (m, o) => { await new Promise(r => setTimeout(r, 50)); return okChat(o.model); },
    })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers), { shadow });
    try {
      const controller = new AbortController();
      const fetchPromise = fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-x' }),
        signal: controller.signal,
      });
      await new Promise(r => setTimeout(r, 10)); // let the request reach the provider call, still in flight
      controller.abort();
      await assert.rejects(fetchPromise);

      await new Promise(r => setTimeout(r, 80)); // let the 50ms provider call finish on the server side
      assert.equal(shadow.calls.length, 1, 'the provider call completed and was already paid for — it must still be shadow-evaluated');
      assert.equal(shadow.calls[0].served.model, 'gpt-x');
    } finally {
      await close();
    }
  });
});

describe('POST /v1/chat/completions — streaming', () => {
  it('frames SSE correctly: one role chunk, each delta once, finish_reason forwarded, single [DONE]', async () => {
    const providers = new Map([['p', fakeProvider({
      name: 'p', models: [{ id: 'stream-x' }],
      chat: async (m, o) => {
        async function* gen() {
          yield { type: 'delta', content: 'Hello ' };
          yield { type: 'delta', content: 'world' };
          // A misbehaving provider may put the full text on its 'done' chunk.
          // It must never be forwarded as an extra delta.
          yield { type: 'done', model: o.model, content: 'Hello world', inputTokens: 10, outputTokens: 2, finishReason: 'length' };
        }
        return gen();
      },
    })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'stream-x', stream: true }),
      });
      assert.equal(res.status, 200);
      const frames = await readSse(res);
      assert.equal(frames.at(-1), '[DONE]');
      const events = frames.slice(0, -1).map(f => JSON.parse(f));

      assert.equal(events[0].choices[0].delta.role, 'assistant');
      assert.equal(events[0].choices[0].delta.content, '');

      const contentDeltas = events.filter(e => e.choices?.[0]?.delta?.content).map(e => e.choices[0].delta.content);
      assert.deepEqual(contentDeltas, ['Hello ', 'world']);
      assert.equal(contentDeltas.join(''), 'Hello world', 'the full text appears exactly once');

      const final = events.at(-1);
      assert.equal(final.choices[0].finish_reason, 'length');
      assert.ok(final.prism);
      assert.equal(final.prism.cost_usd !== undefined, true);
    } finally {
      await close();
    }
  });

  it('a routing failure before any bytes are written is a normal JSON error, not an SSE frame', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x' }], chat: (m, o) => okChat(o.model) })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'nonexistent', stream: true }),
      });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-type').includes('application/json'), true);
      const body = await res.json();
      assert.equal(body.error.code, 'MODEL_NOT_FOUND');
    } finally {
      await close();
    }
  });

  it('a non-retryable upstream 4xx on a streaming request also surfaces as that status, not 502', async () => {
    const providers = new Map([['p', fakeProvider({
      name: 'p', models: [{ id: 'gpt-x' }],
      chat: async () => { const err = new Error('bad request upstream'); err.status = 400; err.retryable = false; throw err; },
    })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-x', stream: true }),
      });
      assert.equal(res.status, 400);
    } finally {
      await close();
    }
  });

  it('aborts the upstream call when the client disconnects mid-stream', async () => {
    let yieldedCount = 0;
    let sawAborted = false;
    const providers = new Map([['p', fakeProvider({
      name: 'p', models: [{ id: 'slow-stream' }],
      chat: async (m, o) => {
        async function* gen() {
          for (let i = 0; i < 50; i++) {
            if (o.signal?.aborted) { sawAborted = true; return; }
            await new Promise(r => setTimeout(r, 20));
            if (o.signal?.aborted) { sawAborted = true; return; }
            yieldedCount++;
            yield { type: 'delta', content: `chunk${i} ` };
          }
          yield { type: 'done', model: o.model, inputTokens: 1, outputTokens: 50, finishReason: 'stop' };
        }
        return gen();
      },
    })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'slow-stream', stream: true }),
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      await reader.read(); // role chunk
      await reader.read(); // first content chunk
      controller.abort();
      try { await reader.cancel(); } catch { /* expected once aborted */ }

      await new Promise(resolve => setTimeout(resolve, 200));
      const countAfterAbort = yieldedCount;
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(yieldedCount, countAfterAbort, 'generator must stop producing chunks after disconnect');
      assert.ok(sawAborted, 'the provider must observe the abort signal');
    } finally {
      await close();
    }
  });
});

describe('createRateLimiter', () => {
  it('allows up to max requests per window, then 429s, keyed off the bearer token when present', () => {
    const limiter = createRateLimiter(60_000, 2);
    const res = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
    const req = { headers: { authorization: 'Bearer abc' }, ip: '1.1.1.1', socket: {} };

    let blocked = 0;
    for (let i = 0; i < 3; i++) {
      const r = res();
      limiter(req, r, () => {});
      if (r.statusCode === 429) blocked++;
    }
    assert.equal(blocked, 1);
  });

  it('cannot be reset by sending a different Authorization header each time', () => {
    const limiter = createRateLimiter(60_000, 3);
    const res = () => ({ statusCode: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const r = res();
      limiter({ headers: { authorization: `Bearer rotated-${i}` }, ip: '9.9.9.9', socket: {} }, r, () => {});
      statuses.push(r.statusCode);
    }
    assert.equal(statuses.filter(s => s === 429).length, 7, 'ten requests from one address against a limit of three');
  });
});

describe('Dashboard API endpoints', () => {
  it('GET /api/config returns the info payload as-is', async () => {
    const providers = new Map();
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      assert.deepEqual(await res.json(), INFO);
    } finally {
      await close();
    }
  });

  it('GET /api/shadow returns shadow.stats()', async () => {
    const shadow = { calls: [], maybeShadow() {}, stats: () => ({ enabled: true, rate: 0.2, budgetUsd: 1, spentTodayUsd: 0.1, battlesToday: 2, judgedToday: 1 }) };
    const providers = new Map();
    const { close, baseUrl } = await startServer(providers, new Router(providers), { shadow });
    try {
      const res = await fetch(`${baseUrl}/api/shadow`);
      assert.deepEqual(await res.json(), { enabled: true, rate: 0.2, budgetUsd: 1, spentTodayUsd: 0.1, battlesToday: 2, judgedToday: 1 });
    } finally {
      await close();
    }
  });

  it('GET /api/frontier reports blendedCostPer1k and onFrontier correctly', async () => {
    const providers = new Map([['p', fakeProvider({
      name: 'p', models: [
        { id: 'good-value', costPer1kInput: 0.01, costPer1kOutput: 0.01 },
        { id: 'dominated', costPer1kInput: 1, costPer1kOutput: 1 },
        { id: 'unpriced-unrated', costPer1kInput: null, costPer1kOutput: null },
      ],
    })]]);
    for (let i = 0; i < 5; i++) store.addComparison({ modelA: 'good-value', modelB: 'dominated', outcome: 'a', taskType: 'general', source: 'human' });
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const res = await fetch(`${baseUrl}/api/frontier`);
      const body = await res.json();
      const good = body.models.find(m => m.model === 'good-value');
      const dominated = body.models.find(m => m.model === 'dominated');
      const unpriced = body.models.find(m => m.model === 'unpriced-unrated');
      assert.equal(good.blendedCostPer1k, 0.01);
      assert.equal(good.onFrontier, true);
      assert.equal(dominated.onFrontier, false, 'a model that is both pricier and rated lower must not be on the frontier');
      assert.equal(unpriced.blendedCostPer1k, null);
      assert.equal(unpriced.onFrontier, false, 'a model with no price evidence must not be vacuously on the frontier');
    } finally {
      await close();
    }
  });

  it('GET /api/providers, /api/stats, /api/requests, /v1/models return 200 with the expected shape', async () => {
    const providers = new Map([['p', fakeProvider({ name: 'p', models: [{ id: 'gpt-x', costPer1kInput: 1, costPer1kOutput: 1 }] })]]);
    const { close, baseUrl } = await startServer(providers, new Router(providers));
    try {
      const providersRes = await (await fetch(`${baseUrl}/api/providers`)).json();
      assert.equal(providersRes.providers[0].name, 'p');

      const statsRes = await (await fetch(`${baseUrl}/api/stats`)).json();
      assert.equal(typeof statsRes.totals.total_requests, 'number');

      const requestsRes = await (await fetch(`${baseUrl}/api/requests`)).json();
      assert.ok(Array.isArray(requestsRes.requests));

      const modelsRes = await (await fetch(`${baseUrl}/v1/models`)).json();
      assert.ok(modelsRes.data.some(m => m.id === 'gpt-x'));
    } finally {
      await close();
    }
  });
});
