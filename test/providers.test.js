import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-providers-')), 'test.db');

const { BaseProvider, ProviderError, isChatModelId, mergeModelCatalog } = await import('../src/proxy/providers/base.js');
const pricing = await import('../src/proxy/providers/pricing.js');
const { OpenAIProvider } = await import('../src/proxy/providers/openai.js');
const { GroqProvider } = await import('../src/proxy/providers/groq.js');
const { XAIProvider } = await import('../src/proxy/providers/xai.js');
const { MistralProvider } = await import('../src/proxy/providers/mistral.js');
const { OllamaProvider } = await import('../src/proxy/providers/ollama.js');
const { OpenRouterProvider } = await import('../src/proxy/providers/openrouter.js');
const { AnthropicProvider } = await import('../src/proxy/providers/anthropic.js');
const { GoogleProvider } = await import('../src/proxy/providers/google.js');
const providersIndex = await import('../src/proxy/providers/index.js');
const { getRegistryModels, getProviderHealth, closeDb } = await import('../src/db/store.js');
const modelSync = await import('../src/services/model-sync.js');
const { HealthMonitor } = await import('../src/health/monitor.js');

after(() => closeDb());

// --- fetch stubbing helpers ---

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(data, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function makeSSEResponse(lines, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return { ok: status >= 200 && status < 300, status, body, json: async () => ({}) };
}

class TestProvider extends BaseProvider {
  get name() { return 'test'; }
  get available() { return true; }
  get models() { return []; }
}

// --- base.js ---

describe('base.js helpers', () => {
  it('isChatModelId filters non-chat model families', () => {
    assert.equal(isChatModelId('gpt-6-astra'), true);
    assert.equal(isChatModelId('claude-sonnet-5'), true);
    assert.equal(isChatModelId('text-embedding-3-large'), false);
    assert.equal(isChatModelId('whisper-1'), false);
    assert.equal(isChatModelId('dall-e-3'), false);
    assert.equal(isChatModelId('omni-moderation-latest'), false);
    assert.equal(isChatModelId('gpt-4o-realtime-preview'), false);
    assert.equal(isChatModelId('tts-1'), false);
    assert.equal(isChatModelId('llama-guard-4-12b'), false);
  });

  it('mergeModelCatalog keeps known metadata and prices an unknown id via priceFor, never a guess', () => {
    const fallback = [{ id: 'known', name: 'Known', contextWindow: 1000, costPer1kInput: 0.1, costPer1kOutput: 0.2 }];
    const result = mergeModelCatalog(['known', 'new-model', 'unpriced'], fallback, {
      defaultContextWindow: 4096,
      priceFor: id => (id === 'new-model' ? { input: 0.01, output: 0.02 } : null),
    });
    assert.deepEqual(result[0], { ...fallback[0], featured: true });
    assert.deepEqual(result[1], { id: 'new-model', name: 'new-model', contextWindow: 4096, costPer1kInput: 0.01, costPer1kOutput: 0.02, featured: false });
    assert.equal(result[2].costPer1kInput, null);
    assert.equal(result[2].costPer1kOutput, null);
  });

  it('mergeModelCatalog lists curated models first, in curated order, whatever order the catalog returns', () => {
    const fallback = [{ id: 'flagship' }, { id: 'small' }];
    const result = mergeModelCatalog(['legacy-a', 'small', 'legacy-b', 'flagship'], fallback);
    assert.deepEqual(result.map(m => m.id), ['flagship', 'small', 'legacy-a', 'legacy-b']);
    assert.deepEqual(result.map(m => m.featured), [true, true, false, false]);
  });

  it('isChatModelId drops completion-only models but keeps open-weight "-instruct" chat models', () => {
    for (const id of ['davinci-002', 'babbage-002', 'gpt-3.5-turbo-instruct', 'text-embedding-3-large', 'whisper-1']) {
      assert.equal(isChatModelId(id), false, id);
    }
    for (const id of ['gpt-6-astra', 'meta-llama/llama-3.3-70b-instruct', 'claude-sonnet-5']) {
      assert.equal(isChatModelId(id), true, id);
    }
  });

  it('estimateCost is null when either price is unknown, never treats it as free', () => {
    class Priced extends TestProvider {
      get models() { return [{ id: 'm', costPer1kInput: null, costPer1kOutput: 0.01 }]; }
    }
    assert.equal(new Priced().estimateCost(1000, 1000, 'm'), null);
  });

  it('fetchWithTimeout aborts the whole exchange once timeoutMs elapses', async () => {
    const provider = new TestProvider();
    const restore = stubFetch((url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    }));
    // The timeout timer is unref'd, so without this nothing holds the event loop open
    // while the test waits for it, and Node 22 ends the file early.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      await assert.rejects(
        () => provider.fetchWithTimeout('http://example.test', {}, 10),
        err => err.name === 'TimeoutError',
      );
    } finally {
      clearInterval(keepAlive);
      restore();
    }
  });

  it('an external signal aborts fetchWithTimeout too, independent of the timeout', async () => {
    const provider = new TestProvider();
    const controller = new AbortController();
    const restore = stubFetch((url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    }));
    try {
      const pending = provider.fetchWithTimeout('http://example.test', {}, 60_000, controller.signal);
      controller.abort(new Error('client disconnected'));
      await assert.rejects(() => pending, /client disconnected/);
    } finally {
      restore();
    }
  });

  it('clear() lets a normal exchange resolve without the timer firing', async () => {
    const provider = new TestProvider();
    const restore = stubFetch(async () => jsonResponse({ ok: true }));
    try {
      const { response, clear } = await provider.fetchWithTimeout('http://example.test', {}, 5_000);
      clear();
      assert.equal(response.ok, true);
    } finally {
      restore();
    }
  });

  it('unrefs the timeout timer so an abandoned exchange cannot keep the process alive', () => {
    const provider = new TestProvider();
    const originalSetTimeout = globalThis.setTimeout;
    let unrefCalled = false;
    globalThis.setTimeout = (fn, ms) => {
      const timer = originalSetTimeout(fn, ms);
      const originalUnref = timer.unref.bind(timer);
      timer.unref = (...args) => { unrefCalled = true; return originalUnref(...args); };
      return timer;
    };
    try {
      const { clear } = provider.createExchangeSignal(5_000);
      clear();
      assert.equal(unrefCalled, true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

// --- pricing.js ---

describe('pricing.js', () => {
  it('normalizeSlug strips org prefix, variant suffix, date snapshot, and treats punctuation as equivalent', () => {
    assert.equal(pricing.normalizeSlug('anthropic/claude-opus-5'), 'claudeopus5');
    assert.equal(pricing.normalizeSlug('openai/gpt-6-astra:batch'), 'gpt6astra');
    assert.equal(pricing.normalizeSlug('anthropic/claude-opus-5-20260723'), 'claudeopus5');
    assert.equal(pricing.normalizeSlug('gpt.6.astra'), 'gpt6astra');
  });

  it('fetches the OpenRouter catalog once and reuses it across repeated lookups', async () => {
    pricing.clearPriceCache();
    let calls = 0;
    const restore = stubFetch(async () => {
      calls++;
      return jsonResponse({ data: [{ id: 'openai/gpt-6-astra', pricing: { prompt: '0.00001', completion: '0.00005' } }] });
    });
    try {
      const first = await pricing.priceFor('gpt-6-astra');
      const second = await pricing.priceFor('gpt-6-astra');
      assert.equal(calls, 1);
      assert.ok(Math.abs(first.input - 0.01) < 1e-9);
      assert.ok(Math.abs(first.output - 0.05) < 1e-9);
      assert.deepEqual(first, second);
    } finally {
      restore();
      pricing.clearPriceCache();
    }
  });

  it('returns null for a model with no confident match, never a guessed price', async () => {
    pricing.clearPriceCache();
    const restore = stubFetch(async () => jsonResponse({ data: [{ id: 'openai/gpt-6-astra', pricing: { prompt: '0.00001', completion: '0.00005' } }] }));
    try {
      assert.equal(await pricing.priceFor('totally-unknown-model-xyz'), null);
    } finally {
      restore();
      pricing.clearPriceCache();
    }
  });

  it('does not strip a context-window suffix as if it were a date, so two differently-priced models never collapse onto one slug', () => {
    // A wider \d{4,8} match (the old regex) stripped "-8192"/"-4096" the same way
    // it strips a real "-20260723" date, silently merging two distinct models.
    assert.notEqual(pricing.normalizeSlug('llama3-70b-8192'), pricing.normalizeSlug('llama3-70b-4096'));
    assert.equal(pricing.normalizeSlug('llama3-70b-8192'), 'llama370b8192');
    // A genuine 8-digit YYYYMMDD snapshot is still stripped.
    assert.equal(pricing.normalizeSlug('some-model-20260723'), pricing.normalizeSlug('some-model'));
  });
});

// --- openai.js ---

describe('OpenAIProvider', () => {
  it('sends max_completion_tokens for reasoning models, max_tokens otherwise', () => {
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const reasoning = provider.buildRequestBody([], { model: 'gpt-6-astra', maxTokens: 500 });
    assert.equal(reasoning.max_completion_tokens, 500);
    assert.equal(reasoning.max_tokens, undefined);

    const plain = provider.buildRequestBody([], { model: 'gpt-4o', maxTokens: 500 });
    assert.equal(plain.max_tokens, 500);
    assert.equal(plain.max_completion_tokens, undefined);
  });

  it('forwards the full accepted option set, including temperature: 0', () => {
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const body = provider.buildRequestBody([{ role: 'user', content: 'hi' }], {
      model: 'gpt-5.6-terra', temperature: 0, topP: 0.9, stop: ['\n'], seed: 7,
      frequencyPenalty: 0.1, presencePenalty: 0.2, responseFormat: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'x' } }], toolChoice: 'auto',
    });
    assert.equal(body.temperature, 0);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.stop, ['\n']);
    assert.equal(body.seed, 7);
    assert.equal(body.frequency_penalty, 0.1);
    assert.equal(body.presence_penalty, 0.2);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.tools.length, 1);
    assert.equal(body.tool_choice, 'auto');
  });

  it('asks for usage on streams via stream_options.include_usage', () => {
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const body = provider.buildRequestBody([], { model: 'gpt-5.6-terra', stream: true });
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  it('retries once without a rejected parameter, then remembers it for that model', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const calls = [];
    const restore = stubFetch(async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (body.temperature !== undefined) {
        return jsonResponse({ error: { message: "Unsupported value: 'temperature' is not supported with this model.", param: 'temperature' } }, { status: 400 });
      }
      return jsonResponse({ model: body.model, choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    try {
      const result = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-6-astra', temperature: 0.5, maxTokens: 10 });
      assert.equal(result.content, 'ok');
      assert.equal(result.finishReason, 'stop');
      assert.equal(calls.length, 2);
      assert.equal(calls[0].temperature, 0.5);
      assert.equal(calls[1].temperature, undefined);

      await provider.chat([{ role: 'user', content: 'again' }], { model: 'gpt-6-astra', temperature: 0.5, maxTokens: 10 });
      assert.equal(calls.length, 3, 'the second call to the same model should skip straight past the rejected param');
    } finally {
      restore();
    }
  });

  it('throws a sanitizable ProviderError when every attempt fails', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const restore = stubFetch(async () => jsonResponse({ error: { message: 'server exploded' } }, { status: 500 }));
    try {
      await assert.rejects(
        () => provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-5.6-terra' }),
        err => err instanceof ProviderError && err.retryable === true && err.status === 500,
      );
    } finally {
      restore();
    }
  });

  it('streams only delta content; the done chunk carries none, plus finishReason and usage', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ];
    const restore = stubFetch(async () => makeSSEResponse(sse));
    try {
      const chunks = [];
      for await (const chunk of await provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-5.6-terra', stream: true, maxTokens: 10 })) {
        chunks.push(chunk);
      }
      const deltas = chunks.filter(c => c.type === 'delta');
      const done = chunks.find(c => c.type === 'done');
      assert.equal(deltas.map(d => d.content).join(''), 'Hello');
      assert.equal(done.content, undefined);
      assert.equal(done.finishReason, 'stop');
      assert.equal(done.outputTokens, 2);
    } finally {
      restore();
    }
  });

  it('forwards tool_calls deltas and flushes a trailing unterminated SSE line', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k' });
    // No trailing "\n\n" after the last line — the reader's final read() must still
    // process what's left in the buffer instead of dropping it.
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ];
    const restore = stubFetch(async () => makeSSEResponse(sse));
    try {
      const chunks = [];
      for await (const chunk of await provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-5.6-terra', stream: true, tools: [{}] })) {
        chunks.push(chunk);
      }
      const toolChunk = chunks.find(c => c.toolCalls);
      assert.equal(toolChunk.toolCalls[0].id, 'call_1');
      assert.equal(chunks.find(c => c.type === 'done').finishReason, 'tool_calls');
    } finally {
      restore();
    }
  });

  it('rejects a tools-bearing request against a provider that does not support them', async () => {
    class NoTools extends OpenAIProvider {
      get supportsTools() { return false; }
    }
    const provider = new NoTools({ apiKey: 'k' });
    await assert.rejects(
      () => provider.chat([{ role: 'user', content: 'hi' }], { model: 'x', tools: [{}] }),
      err => err instanceof ProviderError && err.status === 400,
    );
  });

  it('discoverModels filters non-chat ids and merges prices for models outside the fallback list', async () => {
    pricing.clearPriceCache();
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const restore = stubFetch(async (url) => {
      if (String(url).includes('openrouter.ai')) {
        return jsonResponse({ data: [{ id: 'openai/gpt-7-nova', pricing: { prompt: '0.00002', completion: '0.0001' } }] });
      }
      return jsonResponse({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-7-nova' }, { id: 'whisper-1' }] });
    });
    try {
      await provider.discoverModels();
      const ids = provider.models.map(m => m.id);
      assert.ok(ids.includes('gpt-6-astra'));
      assert.ok(ids.includes('gpt-7-nova'));
      assert.ok(!ids.includes('whisper-1'));
      const known = provider.getModel('gpt-6-astra');
      assert.equal(known.costPer1kInput, 0.01); // kept from the fallback list, not re-derived
      const novel = provider.getModel('gpt-7-nova');
      assert.ok(Math.abs(novel.costPer1kInput - 0.02) < 1e-9); // priced via the OpenRouter cross-reference
    } finally {
      restore();
      pricing.clearPriceCache();
    }
  });

  it('keeps the fallback list when discovery fails', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const before = provider.models;
    const restore = stubFetch(async () => jsonResponse({}, { status: 500 }));
    try {
      await provider.discoverModels();
      assert.deepEqual(provider.models, before);
    } finally {
      restore();
    }
  });
});

describe('GroqProvider', () => {
  it('uses its own fallback list, not OpenAI\'s, and honors a config override', () => {
    const groq = new GroqProvider({ apiKey: 'k' });
    assert.ok(groq.models.some(m => m.id === 'openai/gpt-oss-120b'));
    assert.ok(!groq.models.some(m => m.id === 'gpt-6-astra'));

    const overridden = new GroqProvider({ apiKey: 'k', models: [{ id: 'custom', name: 'Custom', contextWindow: 1, costPer1kInput: 0, costPer1kOutput: 0 }] });
    assert.deepEqual(overridden.models.map(m => m.id), ['custom']);
  });

  it('an explicit empty apiKey forces unavailable even when the env var is set', () => {
    process.env.GROQ_API_KEY = 'env-key';
    try {
      assert.equal(new GroqProvider({ apiKey: '' }).available, false);
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });
});

describe('XAIProvider / MistralProvider', () => {
  it('are unavailable with no key and available once one is set', () => {
    assert.equal(new XAIProvider({ apiKey: '' }).available, false);
    const xai = new XAIProvider({ apiKey: 'k' });
    assert.equal(xai.available, true);
    assert.ok(xai.models.some(m => m.id === 'grok-4.6'));

    const mistral = new MistralProvider({ apiKey: 'k' });
    assert.ok(mistral.models.some(m => m.id === 'mistral-medium-3-5'));
  });

  it('an explicit empty apiKey forces unavailable even when the matching env var is set (not silently overridden by ||)', () => {
    process.env.XAI_API_KEY = 'env-key';
    process.env.MISTRAL_API_KEY = 'env-key';
    try {
      assert.equal(new XAIProvider({ apiKey: '' }).available, false);
      assert.equal(new MistralProvider({ apiKey: '' }).available, false);
      // omitting apiKey entirely should still pick up the env var
      assert.equal(new XAIProvider({}).available, true);
    } finally {
      delete process.env.XAI_API_KEY;
      delete process.env.MISTRAL_API_KEY;
    }
  });

  it('xAI discovery prefers its own embedded per-token prices over the fallback', async () => {
    const xai = new XAIProvider({ apiKey: 'k' });
    const restore = stubFetch(async () => jsonResponse({
      data: [{ id: 'grok-4.6', prompt_text_token_price: 20000, completion_text_token_price: 60000 }],
    }));
    try {
      await xai.discoverModels();
      const model = xai.getModel('grok-4.6');
      assert.ok(Math.abs(model.costPer1kInput - 0.002) < 1e-9);
      assert.ok(Math.abs(model.costPer1kOutput - 0.006) < 1e-9);
    } finally {
      restore();
    }
  });
});

describe('OllamaProvider', () => {
  it('is unavailable with no OLLAMA_HOST and no successful probe', () => {
    const ollama = new OllamaProvider({});
    assert.equal(ollama.available, false);
    assert.deepEqual(ollama.models, []);
  });

  it('becomes available once a host is configured, before any probe', () => {
    assert.equal(new OllamaProvider({ baseUrl: 'http://localhost:11434' }).available, true);
  });

  it('discovers local models via /api/tags at zero cost', async () => {
    const ollama = new OllamaProvider({});
    const restore = stubFetch(async (url) => {
      assert.ok(String(url).endsWith('/api/tags'));
      return jsonResponse({ models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }] });
    });
    try {
      await ollama.discoverModels();
      assert.equal(ollama.available, true);
      assert.equal(ollama.models[0].id, 'llama3.2:latest');
      assert.equal(ollama.models[0].costPer1kInput, 0);
      assert.equal(ollama.models[0].costPer1kOutput, 0);
    } finally {
      restore();
    }
  });

  it('stays unavailable when the probe fails', async () => {
    const ollama = new OllamaProvider({});
    const restore = stubFetch(async () => jsonResponse({}, { status: 500 }));
    try {
      await ollama.discoverModels();
      assert.equal(ollama.available, false);
    } finally {
      restore();
    }
  });
});

describe('OpenRouterProvider', () => {
  it('always sets a model field on the request body', () => {
    const or = new OpenRouterProvider({ apiKey: 'k' });
    const body = or.buildRequestBody([{ role: 'user', content: 'hi' }], { model: 'anthropic/claude-opus-5' });
    assert.equal(body.model, 'anthropic/claude-opus-5');
  });

  it('rejects chat() with no model instead of silently sending a body with no model field', async () => {
    const or = new OpenRouterProvider({ apiKey: 'k' });
    let fetchCalled = false;
    const restore = stubFetch(async () => { fetchCalled = true; return jsonResponse({}); });
    try {
      await assert.rejects(
        () => or.chat([{ role: 'user', content: 'hi' }], {}),
        err => err instanceof ProviderError && err.status === 400,
      );
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  it('retries once without a rejected param, same as OpenAIProvider (buildRequestBody must forward the 3rd {omit} arg to super)', async () => {
    const or = new OpenRouterProvider({ apiKey: 'k' });
    const calls = [];
    const restore = stubFetch(async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (body.temperature !== undefined) {
        return jsonResponse({ error: { message: "Unsupported value: 'temperature' is not supported with this model.", param: 'temperature' } }, { status: 400 });
      }
      return jsonResponse({ model: body.model, choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    try {
      const result = await or.chat([{ role: 'user', content: 'hi' }], { model: 'openai/gpt-6-astra', temperature: 0.5 });
      assert.equal(result.content, 'ok');
      assert.equal(calls.length, 2);
      assert.equal(calls[0].temperature, 0.5);
      assert.equal(calls[1].temperature, undefined, 'the retry must actually drop the rejected param, not resend the identical body');
      assert.equal(calls[1].model, 'openai/gpt-6-astra', 'the retry body must still carry the model field');
    } finally {
      restore();
    }
  });

  it('an explicit empty apiKey forces unavailable even when OPENROUTER_API_KEY is set', () => {
    process.env.OPENROUTER_API_KEY = 'env-key';
    try {
      assert.equal(new OpenRouterProvider({ apiKey: '' }).available, false);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('reads its catalog from the registry and does not re-fetch OpenRouter itself', async () => {
    const or = new OpenRouterProvider({ apiKey: 'k' });
    let called = false;
    const restore = stubFetch(async () => { called = true; return jsonResponse({ data: [] }); });
    try {
      await or.discoverModels();
      assert.equal(called, false);
      assert.deepEqual(or.models, getRegistryModels('openrouter').map(r => ({
        id: r.id, name: r.display_name, contextWindow: r.context_window,
        costPer1kInput: r.price_prompt_1k, costPer1kOutput: r.price_completion_1k,
      })));
    } finally {
      restore();
    }
  });
});

// --- anthropic.js ---

describe('AnthropicProvider', () => {
  function stubChatCapture(responseData) {
    let capturedBody;
    const restore = stubFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return jsonResponse(responseData);
    });
    return { restore, getBody: () => capturedBody };
  }

  it('defaults a missing content field instead of crashing', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    const { restore, getBody } = stubChatCapture({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' });
    try {
      const result = await provider.chat([{ role: 'user' }, { role: 'assistant', content: 'hi' }], { model: 'claude-sonnet-5' });
      assert.equal(result.content, 'ok');
      assert.equal(getBody().messages[0].content, '');
    } finally {
      restore();
    }
  });

  it('merges consecutive same-role turns and fixes a leading assistant turn', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    const { restore, getBody } = stubChatCapture({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' });
    try {
      await provider.chat([
        { role: 'assistant', content: 'leading' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ], { model: 'claude-sonnet-5' });
      const body = getBody();
      assert.equal(body.messages[0].role, 'user');
      assert.equal(body.messages[0].content, '.');
      assert.equal(body.messages[1].role, 'assistant');
      assert.equal(body.messages[1].content, 'leading');
      assert.equal(body.messages[2].role, 'user');
      assert.deepEqual(body.messages[2].content, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
    } finally {
      restore();
    }
  });

  it('translates OpenAI-style image_url blocks into Anthropic image blocks', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    const { restore, getBody } = stubChatCapture({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' });
    try {
      await provider.chat([{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }], { model: 'claude-sonnet-5' });
      const blocks = getBody().messages[0].content;
      assert.deepEqual(blocks[0], { type: 'text', text: 'what is this' });
      assert.deepEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    } finally {
      restore();
    }
  });

  it('maps stop_reason to finishReason', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    const restore = stubFetch(async () => jsonResponse({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'max_tokens' }));
    try {
      const result = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-5' });
      assert.equal(result.finishReason, 'length');
    } finally {
      restore();
    }
  });

  it('health-checks via GET /v1/models and never bills a real message', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    let seenMethod, seenUrl;
    const restore = stubFetch(async (url, opts) => {
      seenUrl = String(url);
      seenMethod = opts.method;
      return jsonResponse({ data: [] });
    });
    try {
      const result = await provider.healthCheck();
      assert.equal(seenMethod, 'GET');
      assert.ok(seenUrl.endsWith('/v1/models'));
      assert.equal(result.healthy, true);
    } finally {
      restore();
    }
  });

  it('streams text deltas and flushes stop_reason from a trailing unterminated buffer', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    const sse = [
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    ];
    const restore = stubFetch(async () => makeSSEResponse(sse));
    try {
      const chunks = [];
      for await (const chunk of await provider.chat([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-5', stream: true })) {
        chunks.push(chunk);
      }
      assert.equal(chunks.filter(c => c.type === 'delta').map(c => c.content).join(''), 'Hi');
      const done = chunks.find(c => c.type === 'done');
      assert.equal(done.content, undefined);
      assert.equal(done.finishReason, 'stop');
      assert.equal(done.outputTokens, 2);
    } finally {
      restore();
    }
  });
});

// --- google.js ---

describe('GoogleProvider', () => {
  it('sends the API key as a header, never a query parameter', async () => {
    const provider = new GoogleProvider({ apiKey: 'secret' });
    let seenUrl, seenHeaders;
    const restore = stubFetch(async (url, opts) => {
      seenUrl = String(url);
      seenHeaders = opts.headers;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    });
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], { model: 'gemini-3.8-flash' });
      assert.ok(!seenUrl.includes('key='));
      assert.equal(seenHeaders['x-goog-api-key'], 'secret');
    } finally {
      restore();
    }
  });

  it('throws instead of silently returning a blocked/filtered response', async () => {
    const provider = new GoogleProvider({ apiKey: 'k' });
    const restore = stubFetch(async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
    try {
      await assert.rejects(
        () => provider.chat([{ role: 'user', content: 'hi' }], { model: 'gemini-3.8-flash' }),
        ProviderError,
      );
    } finally {
      restore();
    }
  });

  it('maps finishReason and forces a maxOutputTokens default', async () => {
    const provider = new GoogleProvider({ apiKey: 'k' });
    let capturedBody;
    const restore = stubFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    });
    try {
      const result = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'gemini-3.8-flash' });
      assert.equal(result.finishReason, 'length');
      assert.equal(capturedBody.generationConfig.maxOutputTokens, 4096);
    } finally {
      restore();
    }
  });

  it('converts image_url blocks into inlineData parts and does not crash on missing content', async () => {
    const provider = new GoogleProvider({ apiKey: 'k' });
    let capturedBody;
    const restore = stubFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }], usageMetadata: {} });
    });
    try {
      await provider.chat([
        { role: 'user' },
        { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] },
      ], { model: 'gemini-3.8-flash' });
      const parts = capturedBody.contents[0].parts;
      assert.ok(parts.some(p => p.inlineData?.data === 'BBBB'));
    } finally {
      restore();
    }
  });

  it('drops tool/function-role history messages instead of mislabeling them as the user (mirrors anthropic.js)', async () => {
    const provider = new GoogleProvider({ apiKey: 'k' });
    let capturedBody;
    const restore = stubFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }], usageMetadata: {} });
    });
    try {
      await provider.chat([
        { role: 'user', content: 'what is 2+2' },
        { role: 'assistant', content: 'let me check' },
        { role: 'tool', content: '4' },
        { role: 'user', content: 'thanks, now what is 3+3' },
      ], { model: 'gemini-3.8-flash' });
      const contents = capturedBody.contents;
      // The tool result must never appear merged into a user turn's parts.
      for (const turn of contents) {
        assert.ok(!turn.parts.some(p => p.text === '4'), 'tool-role content leaked into a translated turn');
      }
      assert.deepEqual(contents.map(c => c.role), ['user', 'model', 'user']);
    } finally {
      restore();
    }
  });

  it('throws when a mid-stream response is blocked, instead of ending the stream silently', async () => {
    const provider = new GoogleProvider({ apiKey: 'k' });
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"SAFETY"}]}\n\n',
    ];
    const restore = stubFetch(async () => makeSSEResponse(sse));
    try {
      const stream = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'gemini-3.8-flash', stream: true });
      await assert.rejects(async () => {
        for await (const _chunk of stream) { /* drain */ }
      }, ProviderError);
    } finally {
      restore();
    }
  });
});

// --- providers/index.js ---

describe('createProviders / discoverModels', () => {
  const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST', 'PRISM_DEMO'];
  let savedEnv;

  before(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('falls back to mock when nothing else is available, and always registers (unprobed) ollama', () => {
    const providers = providersIndex.createProviders({});
    assert.ok(providers.has('mock'));
    assert.ok(providers.has('ollama'));
    assert.equal(providers.get('ollama').available, false);
  });

  it('skips the auto-mock once a real keyed provider is available', () => {
    const providers = providersIndex.createProviders({ apiKey: 'sk-test' });
    assert.ok(providers.has('openai'));
    assert.ok(!providers.has('mock'));
  });

  it('turns mock on with PRISM_DEMO=1 even when a key is configured', () => {
    process.env.PRISM_DEMO = '1';
    try {
      const providers = providersIndex.createProviders({ apiKey: 'sk-test' });
      assert.ok(providers.has('mock'));
    } finally {
      delete process.env.PRISM_DEMO;
    }
  });

  it('discoverModels never throws even when a provider\'s own discovery does', async () => {
    const providers = new Map([
      ['broken', { name: 'broken', discoverModels: async () => { throw new Error('boom'); } }],
      ['fine', { name: 'fine', discoverModels: async () => {} }],
    ]);
    const restore = stubFetch(async () => jsonResponse({ data: [] }));
    try {
      await assert.doesNotReject(() => providersIndex.discoverModels(providers));
    } finally {
      restore();
    }
  });
});

// --- model-sync.js ---

describe('model-sync.js', () => {
  it('syncOpenRouterModels reuses pricing.js\'s fetch (one network call) and filters non-chat models', async () => {
    pricing.clearPriceCache();
    let calls = 0;
    const restore = stubFetch(async () => {
      calls++;
      return jsonResponse({
        data: [
          { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', context_length: 200000, pricing: { prompt: '0.00001', completion: '0.00005' } },
          { id: 'openai/whisper-1', name: 'Whisper', context_length: 4096, pricing: { prompt: '0.000001', completion: '0' } },
          { id: 'openai/gpt-6-astra:batch', name: 'GPT-6 Astra (batch)', context_length: 200000, pricing: { prompt: '0.000005', completion: '0.000025' } },
        ],
      });
    });
    try {
      const count = await modelSync.syncOpenRouterModels();
      assert.equal(calls, 1);
      assert.equal(count, 1);
      const rows = getRegistryModels('openrouter');
      assert.ok(rows.find(r => r.id === 'openai/gpt-6-astra'));
      assert.ok(!rows.find(r => r.id === 'openai/whisper-1'));
      assert.ok(!rows.find(r => r.id === 'openai/gpt-6-astra:batch'));
    } finally {
      restore();
      pricing.clearPriceCache();
    }
  });

  it('stores a missing/malformed price as null, never a fabricated 0 (model_registry prices are nullable)', async () => {
    pricing.clearPriceCache();
    const restore = stubFetch(async () => jsonResponse({
      data: [
        // Only `completion` is present — no `prompt` field at all.
        { id: 'openai/partial-price-model', name: 'Partial', context_length: 128000, pricing: { completion: '0.00005' } },
      ],
    }));
    try {
      const count = await modelSync.syncOpenRouterModels();
      assert.equal(count, 1);
      const row = getRegistryModels('openrouter').find(r => r.id === 'openai/partial-price-model');
      assert.ok(row);
      assert.equal(row.price_prompt_1k, null, 'a missing price field must sync as null, not 0');
      assert.ok(Math.abs(row.price_completion_1k - 0.05) < 1e-9);
    } finally {
      restore();
      pricing.clearPriceCache();
    }
  });

  it('retries with backoff after a zero-model sync, instead of waiting for the full interval', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    pricing.clearPriceCache();
    let calls = 0;
    const restore = stubFetch(async () => {
      calls++;
      if (calls < 3) return jsonResponse({ data: [] });
      return jsonResponse({ data: [{ id: 'openai/gpt-6-astra', pricing: { prompt: '0.00001', completion: '0.00005' } }] });
    });
    const service = new modelSync.ModelSyncService({ retryDelaysMs: [5, 5, 5], intervalMs: 5_000 });
    try {
      await service.start();
      // Far below the 5s interval, far above what a slow CI runner needs for two 5ms retries.
      const deadline = Date.now() + 2_000;
      while (calls < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(calls >= 3, `expected at least 3 sync attempts, got ${calls}`);
    } finally {
      service.stop();
      restore();
      delete process.env.OPENROUTER_API_KEY;
      pricing.clearPriceCache();
    }
  });

  it('stop() prevents any further scheduled sync', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    pricing.clearPriceCache();
    let calls = 0;
    const restore = stubFetch(async () => {
      calls++;
      return jsonResponse({ data: [] });
    });
    const service = new modelSync.ModelSyncService({ retryDelaysMs: [5], intervalMs: 5_000 });
    try {
      await service.start();
      service.stop();
      const callsAfterStop = calls;
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls, callsAfterStop);
    } finally {
      restore();
      delete process.env.OPENROUTER_API_KEY;
      pricing.clearPriceCache();
    }
  });

  it('does nothing without an API key', async () => {
    delete process.env.OPENROUTER_API_KEY;
    let called = false;
    const restore = stubFetch(async () => { called = true; return jsonResponse({ data: [] }); });
    const service = new modelSync.ModelSyncService({ retryDelaysMs: [5], intervalMs: 5_000 });
    try {
      await service.start();
      assert.equal(called, false);
    } finally {
      service.stop();
      restore();
    }
  });
});

// --- health/monitor.js ---

describe('HealthMonitor', () => {
  it('records unhealthy when healthCheck resolves with healthy: false, not just when it throws', async () => {
    const monitor = new HealthMonitor(new Map());
    await monitor.checkProvider('fake-down', { healthCheck: async () => ({ healthy: false, reason: 'bad key' }) });
    assert.equal(getProviderHealth().find(r => r.provider === 'fake-down').status, 'unhealthy');
  });

  it('still records unhealthy when healthCheck throws', async () => {
    const monitor = new HealthMonitor(new Map());
    await monitor.checkProvider('fake-throw', { healthCheck: async () => { throw new Error('boom'); } });
    assert.equal(getProviderHealth().find(r => r.provider === 'fake-throw').status, 'unhealthy');
  });

  it('records healthy only when the result actually says so', async () => {
    const monitor = new HealthMonitor(new Map());
    await monitor.checkProvider('fake-up', { healthCheck: async () => ({ healthy: true, latencyMs: 5 }) });
    assert.equal(getProviderHealth().find(r => r.provider === 'fake-up').status, 'healthy');
  });

  it('checkAll never lets one provider\'s rejection stop the others from being recorded', async () => {
    const providers = new Map([
      ['ok', { healthCheck: async () => ({ healthy: true }) }],
      ['bad', { healthCheck: async () => { throw new Error('down'); } }],
    ]);
    const monitor = new HealthMonitor(providers, 60_000);
    await monitor.checkAll();
    assert.equal(getProviderHealth().find(r => r.provider === 'ok').status, 'healthy');
    assert.equal(getProviderHealth().find(r => r.provider === 'bad').status, 'unhealthy');
  });
});
