import { createBattle, addBattleEntry, setBattleWinner, getBattle, addComparison } from '../db/store.js';
import { TASK_TYPES, detectTaskType, normalizeTaskType } from '../tasks.js';

const PROMPT_CAP = 32_000;

// Model-id prefixes used only when a provider's own models list doesn't settle it
// (e.g. an OpenRouter-only deployment being asked for a bare "gpt-..." id).
const PREFIX_PROVIDERS = [
  ['gpt-', 'openai'], ['chatgpt-', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['o4', 'openai'],
  ['claude-', 'anthropic'],
  ['gemini-', 'google'],
  ['llama', 'groq'], ['mixtral', 'groq'], ['qwen', 'groq'],
  ['mock-', 'mock'],
];

// The one place a model id turns into a provider instance. streaming.js imports
// this too — two implementations previously disagreed on the prefix fallback,
// so a model that resolved for /battle silently dropped for /session.
export function resolveProvider(model, providers) {
  if (model.includes('/')) {
    const openrouter = providers.get('openrouter');
    if (openrouter?.ownsModel?.(model)) return { name: 'openrouter', provider: openrouter };
  }
  for (const [name, provider] of providers) {
    if (provider.ownsModel?.(model)) return { name, provider };
  }
  for (const [prefix, providerName] of PREFIX_PROVIDERS) {
    // Prefix only, never substring: "startsWith" anchors the match at
    // position 0 so an id that merely contains "gpt-" somewhere in the
    // middle isn't mistaken for an OpenAI model.
    if (model.startsWith(prefix)) {
      const provider = providers.get(providerName);
      if (provider) return { name: providerName, provider };
    }
  }
  return null;
}

// The contract's own definition of "not a real response": these entries take no
// part in voting, comparisons or the judge. Centralized so every caller agrees —
// auto-judge.js's old filter checked only emptiness and let "[ERROR] ..." text
// through as if it were content to be judged.
export function isErroredEntry(entry) {
  return !entry.response || entry.response.startsWith('[ERROR]');
}

export function dedupeModels(models) {
  return [...new Set(models)];
}

function formatPrompt(prompt) {
  if (typeof prompt === 'string') return [{ role: 'user', content: prompt }];
  if (Array.isArray(prompt)) return prompt;
  throw httpError('prompt must be a string or array of messages', 400);
}

function promptText(prompt, messages) {
  const text = typeof prompt === 'string' ? prompt : messages.map(m => `${m.role}: ${textOf(m)}`).join('\n');
  return text.slice(0, PROMPT_CAP);
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map(p => p?.text || '').join(' ');
  return '';
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function runSingleModel(model, providerInfo, messages, options) {
  const start = performance.now();
  try {
    const result = await providerInfo.provider.chat(messages, {
      model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });
    return {
      model,
      provider: providerInfo.name,
      response: result.content || '',
      latencyMs: Math.round(performance.now() - start),
      cost: providerInfo.provider.estimateCost
        ? providerInfo.provider.estimateCost(result.inputTokens || 0, result.outputTokens || 0, model)
        : 0,
      inputTokens: result.inputTokens || 0,
      outputTokens: result.outputTokens || 0,
      error: false,
    };
  } catch (err) {
    // The failure detail is an operator concern, not a voter or judge concern —
    // it goes to the console, never into a stored response or an HTTP client.
    console.error(`[arena] ${providerInfo.name}/${model} failed:`, err.message);
    return {
      model,
      provider: providerInfo.name,
      response: '',
      latencyMs: Math.round(performance.now() - start),
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      error: true,
    };
  }
}

export async function runBattle(prompt, models, providers, options = {}) {
  const uniqueModels = dedupeModels(models);
  const messages = formatPrompt(prompt);
  // The caller's taskType wins only when it is one of the real taxonomy values;
  // anything else (missing, mistyped, a judge's free-text guess) falls back to detection.
  const taskType = TASK_TYPES.includes(options.taskType) ? options.taskType : detectTaskType(messages);
  const { maxTokens = 1024, temperature = 0.7 } = options;

  const resolved = [];
  for (const model of uniqueModels) {
    const providerInfo = resolveProvider(model, providers);
    if (providerInfo) resolved.push({ model, providerInfo });
  }
  if (resolved.length < 2) {
    throw httpError('At least 2 resolvable models are required for a battle', 400);
  }

  const results = await Promise.all(
    resolved.map(({ model, providerInfo }) => runSingleModel(model, providerInfo, messages, { maxTokens, temperature })),
  );

  if (results.every(r => r.error)) {
    throw httpError('All models failed in the arena battle', 502);
  }

  const shuffled = shuffle(results);
  const battleId = Number(createBattle(promptText(prompt, messages), taskType, options.origin || 'arena'));

  const entries = shuffled.map((entry, i) => {
    const position = i + 1;
    // A failed call is never stored as "[ERROR] <message>" text — the message is
    // an operator detail already logged above. Emptiness is the structural flag.
    const dbEntry = {
      provider: entry.provider,
      model: entry.model,
      response: entry.error ? '' : entry.response,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      latencyMs: entry.latencyMs,
      costUsd: entry.cost,
      position,
    };
    const result = addBattleEntry(battleId, dbEntry);
    return {
      entryId: Number(result.lastInsertRowid),
      model: entry.model,
      provider: entry.provider,
      response: dbEntry.response,
      latencyMs: entry.latencyMs,
      cost: entry.cost,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      position,
      error: entry.error,
    };
  });

  return { battleId, taskType, entries };
}

// entries/winner here are DB rows (battle_entries), not the runBattle shape above.
function recordHumanComparisons(battle, winnerModel, loserEntries) {
  const taskType = normalizeTaskType(battle.task_type);
  for (const loser of loserEntries) {
    if (loser.model === winnerModel) continue;
    addComparison({ battleId: battle.id, modelA: winnerModel, modelB: loser.model, outcome: 'a', taskType, source: 'human' });
  }
}

function recordHumanTie(battle, entries) {
  const taskType = normalizeTaskType(battle.task_type);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].model === entries[j].model) continue;
      addComparison({ battleId: battle.id, modelA: entries[i].model, modelB: entries[j].model, outcome: 'tie', taskType, source: 'human' });
    }
  }
}

// One human vote per battle. The judge never calls this — it only ever writes
// its own 'judge'-sourced comparison rows — so there is no status race between
// a vote and a judge run to guard against here.
export function voteBattle(battleId, { winnerPosition = null, tie = false } = {}) {
  const battle = getBattle(battleId);
  if (!battle) throw httpError(`Battle ${battleId} not found`, 404);
  if (battle.status !== 'pending') throw httpError(`Battle ${battleId} has already been decided`, 409);

  const votable = battle.entries.filter(e => !isErroredEntry(e));
  if (votable.length < 2) throw httpError(`Battle ${battleId} does not have enough valid entries to vote on`, 409);

  if (tie) {
    setBattleWinner(battleId, null);
    recordHumanTie(battle, votable);
    return { tie: true };
  }

  const winner = votable.find(e => e.position === winnerPosition);
  if (!winner) throw httpError(`No valid entry at position ${winnerPosition} in battle ${battleId}`, 400);

  setBattleWinner(battleId, winner.id);
  recordHumanComparisons(battle, winner.model, votable.filter(e => e.id !== winner.id));
  return { tie: false, winnerModel: winner.model, winnerPosition };
}
