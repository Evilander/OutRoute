import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { GroqProvider } from './groq.js';

// All provider classes, keyed by name
const PROVIDER_CLASSES = [
  OpenAIProvider,
  AnthropicProvider,
  GoogleProvider,
  GroqProvider,
];

let cachedProviders = null;
let cachedModelMap = null;

export function createProviders(config = {}) {
  const providers = new Map();

  for (const ProviderClass of PROVIDER_CLASSES) {
    const instance = new ProviderClass(config);
    if (instance.available) {
      providers.set(instance.name, instance);
    }
  }

  // Cache for model lookups
  cachedProviders = providers;
  cachedModelMap = null;

  return providers;
}

function buildModelMap(providers) {
  if (cachedModelMap && cachedProviders === providers) return cachedModelMap;

  const map = new Map();
  for (const [, provider] of providers) {
    for (const model of provider.models) {
      map.set(model.id, provider);
    }
  }
  cachedModelMap = map;
  cachedProviders = providers;
  return map;
}

export function getModelProvider(modelId, providers) {
  // If providers not passed, use the last created set
  const p = providers || cachedProviders;
  if (!p) return null;

  const modelMap = buildModelMap(p);
  return modelMap.get(modelId) || null;
}

export function getAllModels(providers) {
  const p = providers || cachedProviders;
  if (!p) return [];

  const models = [];
  for (const [, provider] of p) {
    for (const model of provider.models) {
      models.push({
        ...model,
        provider: provider.name,
      });
    }
  }
  return models;
}

export function getModelInfo(modelId, providers) {
  const provider = getModelProvider(modelId, providers);
  if (!provider) return null;

  const model = provider.getModel(modelId);
  return model ? { ...model, provider: provider.name } : null;
}

export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { GoogleProvider } from './google.js';
export { GroqProvider } from './groq.js';
export { BaseProvider, ProviderError } from './base.js';
