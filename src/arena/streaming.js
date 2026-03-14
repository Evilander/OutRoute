import { randomUUID } from 'crypto';
import { createBattle, addBattleEntry } from '../db/store.js';

const sessions = new Map();

// Cleanup sessions older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) {
      sessions.delete(id);
    }
  }
}, 60_000).unref();

function resolveProvider(model, providers) {
  // Check OpenRouter first (models with slashes)
  if (model.includes('/')) {
    const provider = providers.get('openrouter');
    if (provider && provider.ownsModel(model)) {
      return { name: 'openrouter', provider };
    }
  }
  for (const [name, provider] of providers) {
    if (provider.ownsModel && provider.ownsModel(model)) {
      return { name, provider };
    }
  }
  return null;
}

export function initSession(prompt, models, providers, options = {}) {
  const sessionId = randomUUID();
  const taskType = options.taskType || 'general';

  // Shuffle models for blind evaluation
  const shuffled = [...models];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const combatants = shuffled.map((model, idx) => {
    const combatantId = randomUUID();
    const resolved = resolveProvider(model, providers);
    return {
      combatantId,
      model,
      provider: resolved?.name || null,
      providerInstance: resolved?.provider || null,
      position: idx + 1,
      completed: false,
      response: '',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      error: null,
    };
  });

  const promptText = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
  const battleId = createBattle(promptText.slice(0, 500), taskType);

  const session = {
    sessionId,
    battleId: Number(battleId),
    prompt,
    taskType,
    combatants,
    combatantMap: new Map(combatants.map(c => [c.combatantId, c])),
    createdAt: Date.now(),
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens || 1024,
  };

  sessions.set(sessionId, session);

  return {
    sessionId,
    battleId: session.battleId,
    combatants: combatants
      .filter(c => c.providerInstance !== null)
      .map(c => ({
        id: c.combatantId,
        position: c.position,
      })),
  };
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function getCombatant(sessionId, combatantId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return session.combatantMap.get(combatantId) || null;
}

export async function* streamCombatant(sessionId, combatantId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const combatant = session.combatantMap.get(combatantId);
  if (!combatant) throw new Error('Combatant not found');
  if (!combatant.providerInstance) throw new Error('No provider for this model');

  const messages = typeof session.prompt === 'string'
    ? [{ role: 'user', content: session.prompt }]
    : session.prompt;

  const startTime = Date.now();

  try {
    const result = await combatant.providerInstance.chat(messages, {
      model: combatant.model,
      temperature: session.temperature,
      maxTokens: session.maxTokens,
      stream: true,
    });

    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      let fullContent = '';
      for await (const chunk of result) {
        const content = typeof chunk === 'string' ? chunk
          : (chunk.content || chunk.delta?.content || '');
        if (content) {
          fullContent += content;
          yield { type: 'delta', content };
        }
        // Capture token counts from final chunk
        if (chunk.type === 'done' || chunk.inputTokens) {
          combatant.inputTokens = chunk.inputTokens || 0;
          combatant.outputTokens = chunk.outputTokens || 0;
        }
      }
      combatant.response = fullContent;
    } else {
      // Non-streaming response — simulate stream
      const content = result.content || '';
      combatant.response = content;
      combatant.inputTokens = result.inputTokens || 0;
      combatant.outputTokens = result.outputTokens || 0;

      // Yield in word-sized chunks for natural feel
      const words = content.split(/(\s+)/);
      for (const word of words) {
        if (word) yield { type: 'delta', content: word };
      }
    }

    combatant.latencyMs = Date.now() - startTime;
    combatant.completed = true;

    yield { type: 'done', latencyMs: combatant.latencyMs };
  } catch (err) {
    combatant.latencyMs = Date.now() - startTime;
    combatant.error = err.message;
    combatant.completed = true;
    yield { type: 'error', message: err.message };
  }
}

export function finalizeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  for (const combatant of session.combatants) {
    if (!combatant.providerInstance) continue;

    const cost = estimateCost(combatant);
    addBattleEntry(session.battleId, {
      provider: combatant.provider,
      model: combatant.model,
      response: combatant.response || `[ERROR] ${combatant.error}`,
      inputTokens: combatant.inputTokens,
      outputTokens: combatant.outputTokens,
      latencyMs: combatant.latencyMs,
      costUsd: cost,
      position: combatant.position,
    });
  }

  return session.battleId;
}

function estimateCost(combatant) {
  if (!combatant.providerInstance) return 0;
  const model = combatant.providerInstance.getModel(combatant.model);
  if (!model) return 0;
  const inputCost = (combatant.inputTokens / 1000) * (model.costPer1kInput || 0);
  const outputCost = (combatant.outputTokens / 1000) * (model.costPer1kOutput || 0);
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

