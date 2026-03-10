import { createBattle, addBattleEntry, setBattleWinner, getBattle } from '../db/store.js';
import { recordVote, getLeaderboard } from './scorer.js';

function calculateCost(model, provider, inputTokens, outputTokens) {
  const modelInfo = provider.models?.find(m => m.id === model);
  if (!modelInfo) return 0;
  const inputCost = (inputTokens / 1000) * (modelInfo.costPer1kInput || 0);
  const outputCost = (outputTokens / 1000) * (modelInfo.costPer1kOutput || 0);
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

function resolveProvider(model, providers) {
  for (const [name, provider] of providers) {
    if (provider.ownsModel && provider.ownsModel(model)) {
      return { name, provider };
    }
    // Fallback: check models array directly
    if (provider.models && provider.models.some(m => m.id === model)) {
      return { name, provider };
    }
  }
  // Infer provider from model name prefixes
  const prefixMap = {
    'gpt-': 'openai',
    'o1': 'openai',
    'o3': 'openai',
    'o4': 'openai',
    'chatgpt-': 'openai',
    'claude-': 'anthropic',
    'gemini-': 'google',
    'llama': 'groq',
    'mixtral': 'groq',
    'qwen': 'groq',
  };
  for (const [prefix, providerName] of Object.entries(prefixMap)) {
    if (model.startsWith(prefix) || model.includes(prefix)) {
      const provider = providers.get(providerName);
      if (provider) return { name: providerName, provider };
    }
  }
  return null;
}

function formatPrompt(prompt) {
  if (typeof prompt === 'string') {
    return [{ role: 'user', content: prompt }];
  }
  if (Array.isArray(prompt)) {
    return prompt;
  }
  throw new Error('prompt must be a string or array of messages');
}

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function runSingleModel(model, providerInfo, messages, options) {
  const start = performance.now();
  try {
    const result = await providerInfo.provider.chat(messages, {
      model,
      maxTokens: options.maxTokens,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
    });
    const latencyMs = Math.round(performance.now() - start);

    const inputTokens = result.inputTokens || result.usage?.prompt_tokens || 0;
    const outputTokens = result.outputTokens || result.usage?.completion_tokens || 0;
    const cost = calculateCost(model, providerInfo.provider, inputTokens, outputTokens);

    return {
      model,
      provider: providerInfo.name,
      response: result.content || result.message || '',
      latencyMs,
      cost,
      inputTokens,
      outputTokens,
      error: null,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      model,
      provider: providerInfo.name,
      response: null,
      latencyMs,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      error: err.message || String(err),
    };
  }
}

export async function runBattle(prompt, models, providers, options = {}) {
  const { taskType = 'general', maxTokens = 1024, temperature = 0.7 } = options;
  const messages = formatPrompt(prompt);

  // Resolve providers for each model, skip models with no available provider
  const modelProviders = [];
  for (const model of models) {
    const resolved = resolveProvider(model, providers);
    if (resolved) {
      modelProviders.push({ model, providerInfo: resolved });
    }
  }

  if (modelProviders.length === 0) {
    throw new Error('No valid providers found for any of the requested models');
  }

  // Run all models in parallel
  const results = await Promise.allSettled(
    modelProviders.map(({ model, providerInfo }) =>
      runSingleModel(model, providerInfo, messages, { maxTokens, temperature })
    )
  );

  // Collect successful and failed results
  const entries = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      entries.push(result.value);
    }
  }

  if (entries.length === 0) {
    throw new Error('All models failed in the arena battle');
  }

  // Shuffle entries for blind evaluation — position assignment is randomized
  const shuffled = shuffleArray(entries);

  // Prompt preview for DB storage (truncate long prompts)
  const promptText = typeof prompt === 'string'
    ? prompt
    : messages.map(m => `${m.role}: ${m.content}`).join('\n');

  // Create battle in DB
  const battleId = createBattle(promptText.slice(0, 500), taskType);

  // Store entries with randomized positions
  const storedEntries = [];
  for (let i = 0; i < shuffled.length; i++) {
    const entry = shuffled[i];
    const position = i + 1;

    const dbEntry = {
      provider: entry.provider,
      model: entry.model,
      response: entry.response || `[ERROR] ${entry.error}`,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      latencyMs: entry.latencyMs,
      costUsd: entry.cost,
      position,
    };

    const result = addBattleEntry(battleId, dbEntry);

    storedEntries.push({
      entryId: Number(result.lastInsertRowid),
      model: entry.model,
      provider: entry.provider,
      response: entry.response,
      latencyMs: entry.latencyMs,
      cost: entry.cost,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      position,
      error: entry.error,
    });
  }

  return {
    battleId: Number(battleId),
    entries: storedEntries,
  };
}

export async function voteBattle(battleId, winnerEntryId) {
  const battle = getBattle(battleId);
  if (!battle) {
    throw new Error(`Battle ${battleId} not found`);
  }
  if (battle.status === 'voted') {
    throw new Error(`Battle ${battleId} has already been voted on`);
  }

  const winnerEntry = battle.entries.find(e => e.id === winnerEntryId);
  if (!winnerEntry) {
    throw new Error(`Entry ${winnerEntryId} not found in battle ${battleId}`);
  }

  // Record the winner in the DB
  setBattleWinner(battleId, winnerEntryId);

  // Update ELO: winner vs every other entry (loser)
  const loserEntries = battle.entries.filter(e => e.id !== winnerEntryId);
  for (const loser of loserEntries) {
    recordVote(winnerEntry.model, loser.model, battle.task_type);
  }

  return getLeaderboard(battle.task_type);
}
