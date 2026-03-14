import { Router as ExpressRouter } from 'express';
import {
  getRequestStats,
  getCostTimeline,
  getRecentRequests,
  getProviderHealth,
} from '../db/store.js';

// Simple in-memory rate limiter per IP
function createRateLimiter(windowMs = 60_000, maxRequests = 60) {
  const hits = new Map();
  // Cleanup old entries every minute
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of hits) {
      if (now - data.start > windowMs) hits.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let data = hits.get(ip);
    if (!data || now - data.start > windowMs) {
      data = { start: now, count: 0 };
      hits.set(ip, data);
    }
    data.count++;
    if (data.count > maxRequests) {
      return res.status(429).json({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
      });
    }
    next();
  };
}

export default function createProxyRouter(providers, router) {
  const app = ExpressRouter();

  app.use('/v1/chat/completions', createRateLimiter(60_000, 60));

  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const { messages, model, stream, temperature, max_tokens, strategy } = req.body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: 'messages is required and must be a non-empty array',
            type: 'invalid_request_error',
            code: 'missing_messages',
          },
        });
      }

      // Validate message shape
      for (const msg of messages) {
        if (!msg || typeof msg !== 'object') {
          return res.status(400).json({
            error: { message: 'Each message must be an object', type: 'invalid_request_error', code: 'invalid_message' },
          });
        }
        if (!msg.role || typeof msg.role !== 'string') {
          return res.status(400).json({
            error: { message: 'Each message must have a string "role" field', type: 'invalid_request_error', code: 'invalid_message' },
          });
        }
        if (msg.content !== undefined && typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
          return res.status(400).json({
            error: { message: 'Message "content" must be a string or array', type: 'invalid_request_error', code: 'invalid_message' },
          });
        }
      }

      const VALID_STRATEGIES = new Set(['cheapest', 'fastest', 'best', 'round-robin']);
      const effectiveStrategy = VALID_STRATEGIES.has(strategy)
        ? strategy
        : (process.env.DEFAULT_STRATEGY || 'best');

      // Validate and clamp parameters
      const safeTemperature = temperature !== undefined
        ? Math.max(0, Math.min(2, Number(temperature) || 0.7))
        : undefined;
      const safeMaxTokens = max_tokens !== undefined
        ? Math.min(Math.max(1, parseInt(max_tokens) || 1024), 16384)
        : undefined;

      const options = {
        strategy: model ? 'specific' : effectiveStrategy,
        model: model || undefined,
        stream: !!stream,
        temperature: safeTemperature,
        maxTokens: safeMaxTokens,
      };

      if (!stream) {
        const result = await router.route(messages, options);

        return res.json({
          id: result.id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: result.model,
          choices: result.choices,
          usage: result.usage,
          prism: result.prism,
        });
      }

      // Streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const result = await router.route(messages, options);

      // If the provider returned a readable stream
      if (result.stream) {
        const streamId = result.id;

        const firstChunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: result.model,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);

        try {
          for await (const chunk of result.stream) {
            const content = typeof chunk === 'string' ? chunk : (chunk.content || chunk.delta?.content || '');
            if (!content) continue;

            const sseChunk = {
              id: streamId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: result.model,
              choices: [{
                index: 0,
                delta: { content },
                finish_reason: null,
              }],
            };
            res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
          }
        } catch (streamErr) {
          console.error('[server] stream error:', streamErr.message);
        }

        const finalChunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: result.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
          }],
          prism: result.prism,
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // Provider didn't return a stream — simulate SSE from the full response
      const content = result.choices?.[0]?.message?.content || '';
      const streamId = result.id;

      // Role chunk
      res.write(`data: ${JSON.stringify({
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })}\n\n`);

      // Split content into word-level chunks for a natural streaming feel
      const words = content.split(/(\s+)/);
      for (const word of words) {
        if (!word) continue;
        res.write(`data: ${JSON.stringify({
          id: streamId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: result.model,
          choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
        })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        prism: result.prism,
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();

    } catch (err) {
      console.error('[server] /v1/chat/completions error:', err.message);

      // Don't try to send JSON if we've already started streaming
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const status = err.code === 'MODEL_NOT_FOUND' ? 404
        : err.code === 'NO_MODELS_AVAILABLE' ? 503
        : err.code === 'ALL_PROVIDERS_FAILED' ? 502
        : 500;

      // Sanitize error messages — don't leak raw provider details
      const safeMessages = {
        MODEL_NOT_FOUND: err.message,
        NO_MODELS_AVAILABLE: 'No models are currently available to handle this request',
        ALL_PROVIDERS_FAILED: 'All providers failed to process this request',
      };
      const safeMessage = safeMessages[err.code] || 'An internal error occurred while processing your request';

      return res.status(status).json({
        error: {
          message: safeMessage,
          type: 'server_error',
          code: err.code || 'internal_error',
        },
      });
    }
  });

  app.get('/api/stats', (req, res) => {
    try {
      const hours = Math.min(Math.max(1, parseInt(req.query.hours, 10) || 24), 720);
      const stats = getRequestStats(hours);
      const totals = stats.reduce(
        (acc, s) => ({
          total_requests: acc.total_requests + s.total_requests,
          total_cost: acc.total_cost + (s.total_cost || 0),
          total_input_tokens: acc.total_input_tokens + (s.total_input_tokens || 0),
          total_output_tokens: acc.total_output_tokens + (s.total_output_tokens || 0),
          successes: acc.successes + (s.successes || 0),
          errors: acc.errors + (s.errors || 0),
        }),
        { total_requests: 0, total_cost: 0, total_input_tokens: 0, total_output_tokens: 0, successes: 0, errors: 0 },
      );

      res.json({
        hours,
        totals,
        by_model: stats,
      });
    } catch (err) {
      console.error('[server] /api/stats error:', err.message);
      res.status(500).json({ error: { message: err.message } });
    }
  });

  app.get('/api/stats/timeline', (req, res) => {
    try {
      const hours = Math.min(Math.max(1, parseInt(req.query.hours, 10) || 24), 720);
      const timeline = getCostTimeline(hours);
      res.json({ hours, timeline });
    } catch (err) {
      console.error('[server] /api/stats/timeline error:', err.message);
      res.status(500).json({ error: { message: err.message } });
    }
  });

  app.get('/api/requests', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);
      const requests = getRecentRequests(limit);
      res.json({ requests });
    } catch (err) {
      console.error('[server] /api/requests error:', err.message);
      res.status(500).json({ error: { message: err.message } });
    }
  });

  app.get('/api/providers', (req, res) => {
    try {
      const health = getProviderHealth();
      const healthMap = new Map(health.map(h => [h.provider, h]));

      const providerList = [];
      for (const [name, provider] of providers) {
        const h = healthMap.get(name);
        providerList.push({
          name,
          models: provider.models.map(m => ({
            id: m.id,
            name: m.name || m.id,
            costPer1kInput: m.costPer1kInput ?? 0,
            costPer1kOutput: m.costPer1kOutput ?? 0,
          })),
          health: h ? {
            status: h.status,
            last_check: h.last_check,
            last_success: h.last_success,
            last_failure: h.last_failure,
            consecutive_failures: h.consecutive_failures,
            avg_latency_ms: h.avg_latency_ms,
          } : {
            status: 'unknown',
            consecutive_failures: 0,
          },
        });
      }

      res.json({ providers: providerList });
    } catch (err) {
      console.error('[server] /api/providers error:', err.message);
      res.status(500).json({ error: { message: err.message } });
    }
  });

  app.get('/api/models', (req, res) => {
    try {
      const models = router.getAllModels();
      res.json({
        object: 'list',
        data: models.map(m => ({
          id: m.model,
          object: 'model',
          owned_by: m.provider,
          name: m.name,
          pricing: {
            per_1k_input: m.costPer1kInput,
            per_1k_output: m.costPer1kOutput,
          },
        })),
      });
    } catch (err) {
      console.error('[server] /api/models error:', err.message);
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // OpenAI-compatible /v1/models endpoint
  app.get('/v1/models', (req, res) => {
    try {
      const models = router.getAllModels();
      res.json({
        object: 'list',
        data: models.map(m => ({
          id: m.model,
          object: 'model',
          created: 0,
          owned_by: m.provider,
        })),
      });
    } catch (err) {
      console.error('[server] /v1/models error:', err.message);
      res.status(500).json({ error: { message: err.message } });
    }
  });

  return app;
}
