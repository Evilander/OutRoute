import { randomUUID } from 'crypto';
import { createBattle, addBattleEntry } from '../db/store.js';
import { TASK_TYPES, detectTaskType } from '../tasks.js';
import { resolveProvider, dedupeModels } from './arena.js';

const PROMPT_CAP = 32_000;
const SESSION_TTL_MS = 30 * 60 * 1000;
// How long a finalized session's battleId stays reachable for a retried finalize
// call. Longer than the session TTL so a slow duplicate request still resolves
// idempotently instead of hitting a 404.
const FINALIZED_TTL_MS = 60 * 60 * 1000;

const sessions = new Map();
const finalizedSessions = new Map(); // sessionId -> { battleId, at }

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
  for (const [id, record] of finalizedSessions) {
    if (now - record.at > FINALIZED_TTL_MS) finalizedSessions.delete(id);
  }
}, 60_000).unref();

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map(p => p?.text || '').join(' ');
  return '';
}

export function initSession(prompt, models, providers, options = {}) {
  const uniqueModels = dedupeModels(models);
  const messages = typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
  const taskType = TASK_TYPES.includes(options.taskType) ? options.taskType : detectTaskType(messages);

  const shuffled = [...uniqueModels];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const combatants = shuffled.map((model, idx) => {
    const resolved = resolveProvider(model, providers);
    return {
      combatantId: randomUUID(),
      model,
      provider: resolved?.name || null,
      providerInstance: resolved?.provider || null,
      position: idx + 1,
      completed: false,
      streaming: false,
      response: '',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      error: null,
    };
  });

  const resolvedCount = combatants.filter(c => c.providerInstance !== null).length;
  if (resolvedCount < 2) {
    throw httpError('At least 2 resolvable models are required for a session', 400);
  }

  const promptText = (typeof prompt === 'string' ? prompt : messages.map(m => `${m.role}: ${textOf(m)}`).join('\n')).slice(0, PROMPT_CAP);
  const battleId = Number(createBattle(promptText, taskType, options.origin || 'arena'));

  const session = {
    sessionId: randomUUID(),
    battleId,
    prompt,
    taskType,
    combatants,
    combatantMap: new Map(combatants.map(c => [c.combatantId, c])),
    createdAt: Date.now(),
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens || 1024,
  };
  sessions.set(session.sessionId, session);

  return {
    sessionId: session.sessionId,
    battleId,
    combatants: combatants
      .filter(c => c.providerInstance !== null)
      .map(c => ({ id: c.combatantId, position: c.position })),
  };
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

// Streams one combatant's reply. `signal` lets the route cancel the upstream
// provider call the moment the client disconnects, instead of only stopping
// local writes while the outbound request keeps running to completion.
export async function* streamCombatant(sessionId, combatantId, signal) {
  const session = sessions.get(sessionId);
  if (!session) throw httpError('Session not found', 404);

  const combatant = session.combatantMap.get(combatantId);
  if (!combatant) throw httpError('Combatant not found', 404);
  if (!combatant.providerInstance) throw httpError('No provider for this model', 400);
  if (combatant.completed) throw httpError('This combatant has already streamed', 409);
  // Claims the combatant synchronously, before any await: two concurrent
  // requests for the same sessionId+combatantId both reach this point only
  // if neither has run yet, and whichever's synchronous prefix executes
  // first sets the flag before the other's check can observe it — Node
  // never interleaves two synchronous stretches of code. Without this, both
  // callers pass the `completed` check and both invoke the real (billable)
  // provider, with one response silently clobbering the other.
  if (combatant.streaming) throw httpError('This combatant is already streaming', 409);
  combatant.streaming = true;

  const messages = typeof session.prompt === 'string' ? [{ role: 'user', content: session.prompt }] : session.prompt;
  const startTime = Date.now();

  try {
    const stream = await combatant.providerInstance.chat(messages, {
      model: combatant.model,
      temperature: session.temperature,
      maxTokens: session.maxTokens,
      stream: true,
      signal,
    });

    let fullContent = '';
    for await (const chunk of stream) {
      // The done chunk never carries content — only delta chunks are appended,
      // so a provider that (incorrectly) put text on done can't double the reply.
      if (chunk?.type === 'delta') {
        const content = chunk.content || '';
        if (content) {
          fullContent += content;
          yield { type: 'delta', content };
        }
      } else if (chunk?.type === 'done') {
        combatant.inputTokens = chunk.inputTokens || 0;
        combatant.outputTokens = chunk.outputTokens || 0;
      }
    }

    combatant.response = fullContent;
    combatant.latencyMs = Date.now() - startTime;
    combatant.completed = true;
    yield { type: 'done', latencyMs: combatant.latencyMs };
  } catch (err) {
    combatant.latencyMs = Date.now() - startTime;
    combatant.error = err.name === 'AbortError' ? 'client disconnected' : (err.message || String(err));
    // Marked completed even on abort/failure: an unfinished combatant would
    // otherwise block finalize forever if the client never reconnects to it.
    combatant.completed = true;
    yield { type: 'error', message: err.name === 'AbortError' ? 'stream cancelled' : combatant.error };
  } finally {
    // Cleared even when this generator is cancelled early (the route breaks
    // its for-await loop on client disconnect, which calls .return() here
    // without going through the catch above) so a retry of a never-completed
    // combatant isn't locked out forever.
    combatant.streaming = false;
  }
}

export function finalizeSession(sessionId) {
  const already = finalizedSessions.get(sessionId);
  if (already) return already.battleId;

  const session = sessions.get(sessionId);
  if (!session) throw httpError('Session not found', 404);

  const pending = session.combatants.filter(c => c.providerInstance && !c.completed);
  if (pending.length > 0) {
    throw httpError('Not every combatant has finished streaming yet', 409);
  }

  for (const combatant of session.combatants) {
    if (!combatant.providerInstance) continue;
    addBattleEntry(session.battleId, {
      provider: combatant.provider,
      model: combatant.model,
      // A combatant that errored or was cancelled stores an empty response —
      // never "[ERROR] ...", which is the structural signal isErroredEntry relies on.
      response: combatant.error ? '' : combatant.response,
      inputTokens: combatant.inputTokens,
      outputTokens: combatant.outputTokens,
      latencyMs: combatant.latencyMs,
      costUsd: estimateCost(combatant),
      position: combatant.position,
    });
  }

  sessions.delete(sessionId);
  finalizedSessions.set(sessionId, { battleId: session.battleId, at: Date.now() });
  return session.battleId;
}

function estimateCost(combatant) {
  if (!combatant.providerInstance || combatant.error) return 0;
  return combatant.providerInstance.estimateCost
    ? combatant.providerInstance.estimateCost(combatant.inputTokens, combatant.outputTokens, combatant.model)
    : 0;
}
