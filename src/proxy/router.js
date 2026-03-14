import { randomUUID } from 'crypto';
import {
  logRequest,
  getRequestStats,
  getEloRating,
  getHealthyProviders,
  updateProviderHealth,
} from '../db/store.js';

const CODE_KEYWORDS = [
  'code', 'function', 'class', 'implement', 'debug', 'refactor', 'bug',
  'compile', 'syntax', 'algorithm', 'api', 'endpoint', 'database', 'sql',
  'javascript', 'python', 'typescript', 'rust', 'golang', 'java', 'html',
  'css', 'react', 'node', 'import', 'export', 'module', 'package',
  'variable', 'array', 'object', 'loop', 'regex', 'parse', 'json', 'xml',
  'git', 'docker', 'deploy', 'test', 'unit test', 'lint',
];

const CREATIVE_KEYWORDS = [
  'write', 'story', 'poem', 'essay', 'creative', 'fiction', 'narrative',
  'character', 'dialogue', 'plot', 'scene', 'draft', 'rewrite', 'tone',
  'voice', 'metaphor', 'imagery', 'lyric', 'song', 'script', 'screenplay',
  'blog', 'article', 'copy', 'slogan', 'tagline', 'headline',
];

const ANALYSIS_KEYWORDS = [
  'analyze', 'analyse', 'compare', 'contrast', 'evaluate', 'assess',
  'review', 'summarize', 'summary', 'explain', 'breakdown', 'interpret',
  'research', 'investigate', 'examine', 'study', 'data', 'statistics',
  'trend', 'pattern', 'insight', 'report', 'findings', 'conclusion',
  'pros and cons', 'trade-off', 'tradeoff', 'benchmark', 'metric',
];

function detectTaskType(messages) {
  const text = messages
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .join(' ')
    .toLowerCase();

  let codeScore = 0;
  let creativeScore = 0;
  let analysisScore = 0;

  for (const kw of CODE_KEYWORDS) {
    if (text.includes(kw)) codeScore++;
  }
  for (const kw of CREATIVE_KEYWORDS) {
    if (text.includes(kw)) creativeScore++;
  }
  for (const kw of ANALYSIS_KEYWORDS) {
    if (text.includes(kw)) analysisScore++;
  }

  const max = Math.max(codeScore, creativeScore, analysisScore);
  if (max === 0) return 'general';
  if (codeScore === max) return 'code';
  if (creativeScore === max) return 'creative';
  return 'analysis';
}

function estimatePromptTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : 0;
    chars += (m.role || '').length + 4; // role + structural tokens
  }
  return Math.ceil(chars / 4);
}

export class Router {
  constructor(providers, store) {
    this.providers = providers; // Map<string, providerAdapter>
    this.store = store;
    this._roundRobinIndex = 0;
  }

  getAllModels() {
    const models = [];
    for (const [providerName, provider] of this.providers) {
      for (const model of provider.models) {
        models.push({
          provider: providerName,
          model: model.id,
          name: model.name || model.id,
          costPer1kInput: model.costPer1kInput ?? 0,
          costPer1kOutput: model.costPer1kOutput ?? 0,
        });
      }
    }
    return models;
  }

  findModelByName(modelName) {
    const lower = modelName.toLowerCase();
    for (const [providerName, provider] of this.providers) {
      for (const model of provider.models) {
        if (model.id.toLowerCase() === lower || (model.name && model.name.toLowerCase() === lower)) {
          return { provider: providerName, model: model.id, meta: model };
        }
      }
    }
    // Partial match fallback
    for (const [providerName, provider] of this.providers) {
      for (const model of provider.models) {
        if (model.id.toLowerCase().includes(lower) || lower.includes(model.id.toLowerCase())) {
          return { provider: providerName, model: model.id, meta: model };
        }
      }
    }
    return null;
  }

  selectModel(strategy, taskType = 'general', excludeProviders = []) {
    const healthyProviders = getHealthyProviders();
    const allModels = this.getAllModels();

    const available = allModels.filter(m => {
      if (excludeProviders.includes(m.provider)) return false;
      if (healthyProviders.length > 0 && !healthyProviders.includes(m.provider)) return false;
      return true;
    });

    // If health filtering removed everything, fall back to all non-excluded models
    const candidates = available.length > 0
      ? available
      : allModels.filter(m => !excludeProviders.includes(m.provider));

    if (candidates.length === 0) return null;

    switch (strategy) {
      case 'cheapest':
        return this._selectCheapest(candidates);
      case 'fastest':
        return this._selectFastest(candidates);
      case 'best':
        return this._selectBest(candidates, taskType);
      case 'round-robin':
        return this._selectRoundRobin(candidates);
      default:
        return this._selectBest(candidates, taskType);
    }
  }

  _selectCheapest(candidates) {
    let cheapest = candidates[0];
    let cheapestCost = cheapest.costPer1kInput + cheapest.costPer1kOutput;
    for (let i = 1; i < candidates.length; i++) {
      const cost = candidates[i].costPer1kInput + candidates[i].costPer1kOutput;
      if (cost < cheapestCost) {
        cheapest = candidates[i];
        cheapestCost = cost;
      }
    }
    return { provider: cheapest.provider, model: cheapest.model, meta: cheapest };
  }

  _selectFastest(candidates) {
    const stats = getRequestStats(24);
    const latencyMap = new Map();
    for (const s of stats) {
      if (s.total_requests >= 1) {
        latencyMap.set(`${s.provider}:${s.model}`, s.avg_latency);
      }
    }

    let bestCandidate = null;
    let bestLatency = Infinity;

    for (const c of candidates) {
      const key = `${c.provider}:${c.model}`;
      const latency = latencyMap.get(key);
      if (latency !== undefined && latency < bestLatency) {
        bestLatency = latency;
        bestCandidate = c;
      }
    }

    // No latency data — fall back to cheapest
    if (!bestCandidate) return this._selectCheapest(candidates);

    return { provider: bestCandidate.provider, model: bestCandidate.model, meta: bestCandidate };
  }

  _selectBest(candidates, taskType) {
    let bestCandidate = null;
    let bestRating = -Infinity;

    for (const c of candidates) {
      const elo = getEloRating(c.model, taskType);
      // Treat models with fewer than 20 battles as unproven (use default 1500)
      const effectiveRating = elo.battles >= 20 ? elo.rating : 1500;
      if (effectiveRating > bestRating) {
        bestRating = effectiveRating;
        bestCandidate = c;
      }
    }

    if (!bestCandidate) return { provider: candidates[0].provider, model: candidates[0].model, meta: candidates[0] };

    return { provider: bestCandidate.provider, model: bestCandidate.model, meta: bestCandidate };
  }

  _selectRoundRobin(candidates) {
    const idx = this._roundRobinIndex % candidates.length;
    this._roundRobinIndex++;
    const c = candidates[idx];
    return { provider: c.provider, model: c.model, meta: c };
  }

  estimateCost(meta, inputTokens) {
    const inputCost = (inputTokens / 1000) * (meta.costPer1kInput ?? 0);
    // Rough estimate: output is ~1.5x input tokens for cost projection
    const estimatedOutputTokens = Math.ceil(inputTokens * 1.5);
    const outputCost = (estimatedOutputTokens / 1000) * (meta.costPer1kOutput ?? 0);
    return {
      estimatedInputCost: inputCost,
      estimatedOutputCost: outputCost,
      estimatedTotalCost: inputCost + outputCost,
      estimatedOutputTokens,
    };
  }

  async route(messages, options = {}) {
    const {
      strategy = process.env.DEFAULT_STRATEGY || 'best',
      model: requestedModel,
      stream = false,
      temperature,
      maxTokens,
    } = options;

    const taskType = detectTaskType(messages);
    const inputTokenEstimate = estimatePromptTokens(messages);
    const promptPreview = (messages[messages.length - 1]?.content || '').slice(0, 200);

    let effectiveStrategy = strategy;
    let selection;
    let routingReason;

    if (requestedModel) {
      selection = this.findModelByName(requestedModel);
      if (!selection) {
        throw new PrismRoutingError(`Model "${requestedModel}" not found in any configured provider`, 'MODEL_NOT_FOUND');
      }
      effectiveStrategy = 'specific';
      routingReason = `Specific model requested: ${selection.model}`;
    } else {
      selection = this.selectModel(strategy, taskType);
      if (!selection) {
        throw new PrismRoutingError('No available models to route to', 'NO_MODELS_AVAILABLE');
      }
      routingReason = this._buildRoutingReason(effectiveStrategy, selection, taskType);
    }

    const costEstimate = this.estimateCost(selection.meta || {}, inputTokenEstimate);

    // Build attempt list: selected first, then failover candidates
    const attempts = [selection];
    if (effectiveStrategy !== 'specific') {
      const allModels = this.getAllModels();
      for (const m of allModels) {
        if (m.provider === selection.provider && m.model === selection.model) continue;
        attempts.push({ provider: m.provider, model: m.model, meta: m });
      }
    }

    let lastError;

    for (const attempt of attempts) {
      const provider = this.providers.get(attempt.provider);
      if (!provider) continue;

      const startTime = Date.now();

      try {
        const callOptions = { temperature, maxTokens, stream };

        let result;
        const providerOpts = { ...callOptions, model: attempt.model };
        if (stream) {
          // Streaming: provider.chat returns an async generator when stream=true
          result = await provider.chat(messages, { ...providerOpts, stream: true });
          // Wrap generator as stream property for the proxy server
          if (result && typeof result[Symbol.asyncIterator] === 'function') {
            const gen = result;
            result = { content: '', model: attempt.model, usage: {}, stream: gen };
          }
        } else {
          result = await provider.chat(messages, providerOpts);
        }

        const latencyMs = Date.now() - startTime;

        const inTok = result.inputTokens || result.usage?.prompt_tokens || inputTokenEstimate;
        const outTok = result.outputTokens || result.usage?.completion_tokens || 0;

        const actualCost = this._calculateCost(attempt.meta || {}, inTok, outTok);

        // Log success
        try {
          logRequest({
            provider: attempt.provider,
            model: attempt.model,
            strategy: effectiveStrategy,
            promptPreview,
            inputTokens: inTok,
            outputTokens: outTok,
            totalTokens: inTok + outTok,
            latencyMs,
            costUsd: actualCost,
            status: 'ok',
            errorMessage: null,
            taskType,
            routingReason: attempt !== selection
              ? `Failover from ${selection.model}`
              : routingReason,
          });
        } catch (logErr) {
          console.error('[router] failed to log request:', logErr.message);
        }

        try {
          updateProviderHealth(attempt.provider, 'healthy', latencyMs);
        } catch (e) {
          // non-fatal
        }

        return {
          id: `prism-${randomUUID()}`,
          object: stream ? 'chat.completion.chunk' : 'chat.completion',
          model: attempt.model,
          choices: result.choices || [
            {
              index: 0,
              message: { role: 'assistant', content: result.content || '' },
              finish_reason: result.finish_reason || 'stop',
            },
          ],
          usage: result.usage || {
            prompt_tokens: inTok,
            completion_tokens: outTok,
            total_tokens: inTok + outTok,
          },
          prism: {
            provider: attempt.provider,
            strategy: effectiveStrategy,
            routing_reason: attempt !== selection
              ? `Failover from ${selection.model}: ${lastError?.message?.slice(0, 80) || 'provider error'}`
              : routingReason,
            latency_ms: latencyMs,
            cost_usd: actualCost,
            task_type: taskType,
            cost_estimate: costEstimate,
            failover: attempt !== selection,
            original_model: attempt !== selection ? selection.model : undefined,
          },
          // For streaming, pass through the stream
          ...(stream && result.stream ? { stream: result.stream } : {}),
        };
      } catch (err) {
        lastError = err;
        const latencyMs = Date.now() - startTime;

        console.error(
          `[router] ${attempt.provider}/${attempt.model} failed:`,
          err.message,
        );

        try {
          logRequest({
            provider: attempt.provider,
            model: attempt.model,
            strategy: effectiveStrategy,
            promptPreview,
            inputTokens: inputTokenEstimate,
            outputTokens: 0,
            totalTokens: 0,
            latencyMs,
            costUsd: 0,
            status: 'error',
            errorMessage: err.message?.slice(0, 500),
            taskType,
            routingReason: null,
          });
        } catch (logErr) {
          console.error('[router] failed to log error:', logErr.message);
        }

        try {
          updateProviderHealth(attempt.provider, 'degraded', latencyMs);
        } catch (e) {
          // non-fatal
        }

        // For specific model requests, don't failover
        if (effectiveStrategy === 'specific') break;
      }
    }

    throw new PrismRoutingError(
      `All providers failed. Last error: ${lastError?.message || 'unknown'}`,
      'ALL_PROVIDERS_FAILED',
    );
  }

  _buildRoutingReason(strategy, selection, taskType) {
    switch (strategy) {
      case 'cheapest': {
        const cost = ((selection.meta?.costPer1kInput || 0) + (selection.meta?.costPer1kOutput || 0));
        return `Cheapest available · $${cost.toFixed(4)}/1k tokens`;
      }
      case 'fastest': {
        return `Lowest observed latency · ${selection.provider}/${selection.model}`;
      }
      case 'best': {
        const elo = getEloRating(selection.model, taskType);
        return `Best ELO for ${taskType} tasks · ${Math.round(elo.rating)} rating (${elo.battles} battles)`;
      }
      case 'round-robin':
        return `Round-robin selection · ${selection.provider}/${selection.model}`;
      default:
        return `Strategy: ${strategy} · ${selection.model}`;
    }
  }

  _calculateCost(meta, inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000) * (meta.costPer1kInput ?? 0);
    const outputCost = (outputTokens / 1000) * (meta.costPer1kOutput ?? 0);
    return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
  }
}

export class PrismRoutingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PrismRoutingError';
    this.code = code;
  }
}

export { detectTaskType, estimatePromptTokens };
