import { Router as ExpressRouter } from 'express';
import {
  getRequestStats,
  getRecentRequests,
  getProviderHealth,
} from '../db/store.js';
import { getRatings } from '../arena/ratings.js';
import { TASK_TYPES } from '../tasks.js';
import { STRATEGIES, blendedCostPer1k } from './router.js';

const KNOWN_PARAMS = new Set([
  'messages', 'model', 'stream', 'strategy', 'temperature', 'max_tokens', 'max_completion_tokens',
  'top_p', 'stop', 'seed', 'frequency_penalty', 'presence_penalty', 'response_format', 'tools', 'tool_choice',
]);

const CODE_STATUS = {
  MODEL_NOT_FOUND: 404,
  INVALID_MODEL: 400,
  NO_MODELS_AVAILABLE: 503,
  TOOLS_UNSUPPORTED: 400,
  ALL_PROVIDERS_FAILED: 502,
  UPSTREAM_CLIENT_ERROR: 400,
};

const SAFE_MESSAGES = {
  MODEL_NOT_FOUND: 'The requested model was not found in any configured provider.',
  INVALID_MODEL: '"model" must be a string.',
  NO_MODELS_AVAILABLE: 'No models are currently available to handle this request.',
  TOOLS_UNSUPPORTED: 'The selected model does not support tools.',
  ALL_PROVIDERS_FAILED: 'All providers failed to process this request.',
  UPSTREAM_CLIENT_ERROR: 'The model provider rejected this request.',
};

// Keyed on the connection's address and nothing the caller controls. A key taken
// from a request header can be rotated per request, which turns the limit off.
// The limits exist to bound spend on a single-user server, so one bucket per
// address is the right grain (behind a reverse proxy that is one bucket in total).
function rateLimitKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function createRateLimiter(windowMs = 60_000, maxRequests = 60) {
  const hits = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of hits) {
      if (now - data.start > windowMs) hits.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return (req, res, next) => {
    const key = rateLimitKey(req);
    const now = Date.now();
    let data = hits.get(key);
    if (!data || now - data.start > windowMs) {
      data = { start: now, count: 0 };
      hits.set(key, data);
    }
    data.count++;
    if (data.count > maxRequests) {
      return res.status(429).json({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } });
    }
    next();
  };
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function validateMessages(messages) {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return 'messages is required and must be a non-empty array';
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') return 'Each message must be an object';
    if (!msg.role || typeof msg.role !== 'string') return 'Each message must have a string "role" field';
    if (msg.content !== undefined && typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      return 'Message "content" must be a string or array';
    }
  }
  return null;
}

// Returns { value } on success or { error: message } on a bad input, so 0 and
// other falsy-but-valid values survive instead of being coerced to a default.
function parseFiniteNumber(raw, { min, max } = {}) {
  if (raw === undefined) return { value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: 'must be a finite number' };
  const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  return { value: clamped };
}

function badRequest(res, message, code = 'invalid_request_error') {
  return res.status(400).json({ error: { message, type: 'invalid_request_error', code } });
}

export default function createProxyRouter(providers, router, { shadow, info } = {}) {
  const app = ExpressRouter();
  const apiLimiter = createRateLimiter(60_000, 120);

  app.post('/v1/chat/completions', createRateLimiter(60_000, 60), async (req, res) => {
    const body = req.body || {};
    const controller = new AbortController();
    let aborted = false;
    // req's own 'close' fires once the request body has been fully read —
    // true for every normal request, not just a disconnect — so it cannot
    // tell a genuine abort from business as usual. res's 'close' only fires
    // when the connection actually tears down; writableEnded distinguishes
    // "we already finished responding" from "the client left before we did".
    res.on('close', () => {
      if (!res.writableEnded) { aborted = true; controller.abort(); }
    });

    try {
      const { messages, model, stream, strategy, temperature, max_tokens, max_completion_tokens,
        top_p, stop, seed, frequency_penalty, presence_penalty, response_format, tools, tool_choice } = body;

      const messageError = validateMessages(messages);
      if (messageError) return badRequest(res, messageError, 'invalid_message');

      if (model !== undefined && typeof model !== 'string') return badRequest(res, '"model" must be a string', 'invalid_model');
      if (tools !== undefined && !Array.isArray(tools)) return badRequest(res, '"tools" must be an array', 'invalid_tools');
      if (stop !== undefined && typeof stop !== 'string' && !Array.isArray(stop)) return badRequest(res, '"stop" must be a string or array', 'invalid_stop');
      if (response_format !== undefined && (typeof response_format !== 'object' || response_format === null || Array.isArray(response_format))) {
        return badRequest(res, '"response_format" must be an object', 'invalid_response_format');
      }

      // temperature 0 and max_tokens 0 are valid, explicit values — only an
      // undefined field gets the proxy's own default, never a falsy one.
      const temp = parseFiniteNumber(temperature, { min: 0, max: 2 });
      if (temp.error) return badRequest(res, `"temperature" ${temp.error}`, 'invalid_temperature');
      const safeTemperature = temp.value !== undefined ? temp.value : 0.7;

      const rawMaxTokens = max_tokens !== undefined ? max_tokens : max_completion_tokens;
      const maxTok = parseFiniteNumber(rawMaxTokens, { min: 0, max: 16384 });
      if (maxTok.error) return badRequest(res, `"max_tokens" ${maxTok.error}`, 'invalid_max_tokens');
      const safeMaxTokens = maxTok.value !== undefined ? maxTok.value : 1024;

      const topP = parseFiniteNumber(top_p, { min: 0, max: 1 });
      if (topP.error) return badRequest(res, `"top_p" ${topP.error}`, 'invalid_top_p');

      const seedVal = parseFiniteNumber(seed);
      if (seedVal.error) return badRequest(res, `"seed" ${seedVal.error}`, 'invalid_seed');

      const freqPenalty = parseFiniteNumber(frequency_penalty, { min: -2, max: 2 });
      if (freqPenalty.error) return badRequest(res, `"frequency_penalty" ${freqPenalty.error}`, 'invalid_frequency_penalty');

      const presPenalty = parseFiniteNumber(presence_penalty, { min: -2, max: 2 });
      if (presPenalty.error) return badRequest(res, `"presence_penalty" ${presPenalty.error}`, 'invalid_presence_penalty');

      const ignoredParams = Object.keys(body).filter(k => !KNOWN_PARAMS.has(k));

      const options = {
        strategy: STRATEGIES.includes(strategy) ? strategy : undefined,
        // OpenAI SDKs refuse to send a request without a model, so "auto" is how a
        // client says "you choose".
        model: model && model.toLowerCase() !== 'auto' ? model : undefined,
        stream: Boolean(stream),
        temperature: safeTemperature,
        maxTokens: safeMaxTokens,
        topP: topP.value,
        stop,
        seed: seedVal.value,
        frequencyPenalty: freqPenalty.value,
        presencePenalty: presPenalty.value,
        responseFormat: response_format,
        tools,
        toolChoice: tool_choice,
        signal: controller.signal,
      };

      if (!options.stream) {
        const result = await router.route(messages, options);

        // The provider call already ran and was already paid for even if the
        // client left before it finished — only sending the response is
        // pointless now, not shadow-evaluating a response that did complete.
        if (!aborted) {
          res.json({
            id: result.id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: result.model,
            choices: [{ index: 0, message: result.message, finish_reason: result.finishReason }],
            usage: result.usage,
            prism: { ...result.prism, ignored_params: ignoredParams },
          });
        }

        shadow?.maybeShadow?.({
          messages,
          served: {
            provider: result.prism.provider,
            model: result.model,
            content: result.content,
            inputTokens: result.usage.prompt_tokens,
            outputTokens: result.usage.completion_tokens,
            costUsd: result.prism.cost_usd,
            latencyMs: result.prism.latency_ms,
          },
          options: { temperature: options.temperature, maxTokens: options.maxTokens, tools: options.tools, toolChoice: options.toolChoice },
          headers: req.headers,
        });
        return;
      }

      // Streaming: route() is called before any header is written, so a routing
      // failure (model not found, no models, tools unsupported, ...) still gets
      // a normal JSON error response instead of an SSE error frame.
      const result = await router.route(messages, options);
      if (aborted) {
        result.stream?.return?.();
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const streamId = result.id;
      const created = Math.floor(Date.now() / 1000);
      res.write(sse({
        id: streamId, object: 'chat.completion.chunk', created, model: result.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }));

      let fullContent = '';
      let finishReason = 'stop';
      let finalUsage = null;
      let streamErrored = false;

      try {
        for await (const chunk of result.stream) {
          if (aborted) break;
          if (chunk.type === 'delta') {
            const delta = {};
            if (chunk.content) { fullContent += chunk.content; delta.content = chunk.content; }
            if (chunk.toolCalls) delta.tool_calls = chunk.toolCalls;
            if (Object.keys(delta).length === 0) continue;
            res.write(sse({
              id: streamId, object: 'chat.completion.chunk', created, model: result.model,
              choices: [{ index: 0, delta, finish_reason: null }],
            }));
          } else if (chunk.type === 'done') {
            finishReason = chunk.finishReason || finishReason;
            finalUsage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens, costUsd: chunk.costUsd, latencyMs: chunk.latencyMs };
          }
        }
      } catch (err) {
        streamErrored = true;
        if (!aborted) {
          console.error('[server] stream error:', err.message);
          res.write(sse({ error: { message: 'An error occurred while streaming the response.', type: 'server_error', code: 'stream_error' } }));
        }
      }

      if (!aborted) {
        res.write(sse({
          id: streamId, object: 'chat.completion.chunk', created, model: result.model,
          choices: [{ index: 0, delta: {}, finish_reason: streamErrored ? null : finishReason }],
          prism: {
            ...result.prism,
            cost_usd: finalUsage?.costUsd ?? null,
            latency_ms: finalUsage?.latencyMs ?? null,
            ignored_params: ignoredParams,
          },
        }));
        res.write('data: [DONE]\n\n');
      }
      res.end();

      if (!streamErrored && !aborted) {
        shadow?.maybeShadow?.({
          messages,
          served: {
            provider: result.prism.provider,
            model: result.model,
            content: fullContent,
            inputTokens: finalUsage?.inputTokens ?? 0,
            outputTokens: finalUsage?.outputTokens ?? 0,
            costUsd: finalUsage?.costUsd ?? 0,
            latencyMs: finalUsage?.latencyMs ?? 0,
          },
          options: { temperature: options.temperature, maxTokens: options.maxTokens, tools: options.tools, toolChoice: options.toolChoice },
          headers: req.headers,
        });
      }
    } catch (err) {
      if (aborted) return; // client is gone; nothing to send and nothing worth logging as an error

      if (res.headersSent) {
        // A routing failure that happened after we'd already started an SSE
        // response (shouldn't happen given the ordering above, but stay safe).
        res.write(sse({ error: { message: 'An internal error occurred.', type: 'server_error', code: 'internal_error' } }));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      console.error('[server] /v1/chat/completions error:', err.message);
      const status = err.status || CODE_STATUS[err.code] || 500;
      const message = SAFE_MESSAGES[err.code] || (status < 500
        ? 'The request could not be processed.'
        : 'An internal error occurred while processing your request.');
      res.status(status).json({ error: { message, type: status < 500 ? 'invalid_request_error' : 'server_error', code: err.code || 'internal_error' } });
    }
  });

  app.get('/api/config', apiLimiter, (req, res) => {
    res.json(info || {});
  });

  app.get('/api/shadow', apiLimiter, (req, res) => {
    try {
      res.json(shadow ? shadow.stats() : { enabled: false, rate: 0, budgetUsd: 0, spentTodayUsd: 0, battlesToday: 0, judgedToday: 0 });
    } catch (err) {
      console.error('[server] /api/shadow error:', err.message);
      res.status(500).json({ error: { message: 'Internal server error' } });
    }
  });

  app.get('/api/frontier', apiLimiter, (req, res) => {
    try {
      // An unrecognised task type means the pooled ratings, as it does on the leaderboard.
      const taskType = TASK_TYPES.includes(req.query.taskType) ? req.query.taskType : null;
      const pool = router.getPool();
      const ratings = getRatings(taskType, { sources: ['human', 'judge'] });
      const byModel = new Map(ratings.models.map(r => [r.model, r]));

      const rows = pool.map(p => {
        const r = byModel.get(p.model);
        return {
          model: p.model,
          provider: p.provider,
          rating: r ? r.rating : 1500,
          lo: r ? r.lo : 1500,
          hi: r ? r.hi : 1500,
          rated: Boolean(r?.rated),
          games: r ? r.games : 0,
          pBest: r ? r.pBest : 0,
          costPer1kInput: p.costPer1kInput,
          costPer1kOutput: p.costPer1kOutput,
          blendedCostPer1k: blendedCostPer1k(p),
        };
      });

      // The frontier is drawn among models with evidence on both axes: a known
      // price and enough games to be rated. An unrated model's 1500 is a
      // placeholder, and must not be able to push a rated model off the frontier.
      const placed = rows.filter(row => row.rated && row.blendedCostPer1k != null);
      const models = rows.map(row => ({
        ...row,
        onFrontier: placed.includes(row) && !placed.some(other => other !== row
          && other.blendedCostPer1k <= row.blendedCostPer1k
          && other.rating > row.rating),
      }));

      res.json({ models, taskType: taskType || 'overall' });
    } catch (err) {
      console.error('[server] /api/frontier error:', err.message);
      res.status(500).json({ error: { message: 'Internal server error' } });
    }
  });

  app.get('/api/stats', apiLimiter, (req, res) => {
    try {
      const hours = Math.min(Math.max(1, parseInt(req.query.hours, 10) || 24), 720);
      const stats = getRequestStats(hours);
      const totals = stats.reduce((acc, s) => ({
        total_requests: acc.total_requests + s.total_requests,
        total_cost: acc.total_cost + (s.total_cost || 0),
        total_input_tokens: acc.total_input_tokens + (s.total_input_tokens || 0),
        total_output_tokens: acc.total_output_tokens + (s.total_output_tokens || 0),
        successes: acc.successes + (s.successes || 0),
        errors: acc.errors + (s.errors || 0),
      }), { total_requests: 0, total_cost: 0, total_input_tokens: 0, total_output_tokens: 0, successes: 0, errors: 0 });

      res.json({ hours, totals, by_model: stats });
    } catch (err) {
      console.error('[server] /api/stats error:', err.message);
      res.status(500).json({ error: { message: 'Internal server error' } });
    }
  });

  app.get('/api/requests', apiLimiter, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
      res.json({ requests: getRecentRequests(limit) });
    } catch (err) {
      console.error('[server] /api/requests error:', err.message);
      res.status(500).json({ error: { message: 'Internal server error' } });
    }
  });

  app.get('/api/providers', apiLimiter, (req, res) => {
    try {
      const health = getProviderHealth();
      const healthMap = new Map(health.map(h => [h.provider, h]));
      const providerList = [];
      for (const [name, provider] of providers) {
        const h = healthMap.get(name);
        providerList.push({
          name,
          models: provider.models.map(m => ({
            id: m.id, name: m.name || m.id,
            costPer1kInput: m.costPer1kInput ?? null,
            costPer1kOutput: m.costPer1kOutput ?? null,
          })),
          health: h ? {
            status: h.status, last_check: h.last_check, last_success: h.last_success,
            last_failure: h.last_failure, consecutive_failures: h.consecutive_failures, avg_latency_ms: h.avg_latency_ms,
          } : { status: 'unknown', consecutive_failures: 0 },
        });
      }
      res.json({ providers: providerList });
    } catch (err) {
      console.error('[server] /api/providers error:', err.message);
      res.status(500).json({ error: { message: 'Internal server error' } });
    }
  });

  app.get(['/api/models', '/v1/models'], apiLimiter, (req, res) => {
    try {
      // Every model that can be named, with `routable` marking the ones the
      // router will pick from unprompted.
      const pool = new Set(router.getPool().map(m => `${m.provider}/${m.model}`));
      res.json({
        object: 'list',
        data: router.getAllModels().map(m => ({
          id: m.model, object: 'model', owned_by: m.provider, created: 0,
          routable: pool.has(`${m.provider}/${m.model}`),
          pricing: { per_1k_input: m.costPer1kInput, per_1k_output: m.costPer1kOutput },
        })),
      });
    } catch (err) {
      console.error('[server] models list error:', err.message);
      res.status(500).json({ error: { message: 'Internal server error' } });
    }
  });

  return app;
}
