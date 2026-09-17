import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { GroqProvider } from './groq.js';
import { XAIProvider } from './xai.js';
import { MistralProvider } from './mistral.js';
import { OpenRouterProvider } from './openrouter.js';
import { OllamaProvider } from './ollama.js';
import { MockProvider } from './mock.js';
import { getOpenRouterCatalog } from './pricing.js';

// Providers gated on having an API key. Registration order is failover order
// when a caller doesn't otherwise rank the pool.
const KEYED_PROVIDER_CLASSES = [
  OpenAIProvider,
  AnthropicProvider,
  GoogleProvider,
  GroqProvider,
  XAIProvider,
  MistralProvider,
  OpenRouterProvider,
];

export function createProviders(config = {}) {
  const providers = new Map();

  for (const ProviderClass of KEYED_PROVIDER_CLASSES) {
    const instance = new ProviderClass(config);
    if (instance.available) providers.set(instance.name, instance);
  }
  const anyKeyedAvailable = providers.size > 0;

  // Ollama has no key to gate on — it's always registered and starts out
  // contributing zero models until discoverModels()/healthCheck() probes it.
  const ollama = new OllamaProvider(config);
  providers.set(ollama.name, ollama);

  const demoRequested = config.mock?.enabled === true || process.env.PRISM_DEMO === '1';
  if (demoRequested || (!anyKeyedAvailable && !ollama.available)) {
    // enabled: true goes last — this branch means mock MUST turn on (PRISM_DEMO=1,
    // or nothing else is usable at all), so it can't be overridden by a stale
    // config.mock.enabled: false left over from unrelated config.
    const mock = new MockProvider({ ...config, mock: { ...(config.mock || {}), enabled: true } });
    providers.set(mock.name, mock);
  }

  return providers;
}

// Refreshes every provider's catalog and primes the shared OpenRouter price cache,
// all in parallel. Never throws — a provider that can't refresh keeps its
// last-known (or built-in fallback) model list, logged once.
export async function discoverModels(providers) {
  const tasks = [...providers.values()].map(async provider => {
    try {
      await provider.discoverModels();
    } catch (err) {
      console.error(`[${provider.name}] discoverModels failed:`, err.message);
    }
  });
  tasks.push(getOpenRouterCatalog().catch(err => console.error('[pricing] OpenRouter catalog fetch failed:', err.message)));
  await Promise.all(tasks);
}

export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { GoogleProvider } from './google.js';
export { GroqProvider } from './groq.js';
export { XAIProvider } from './xai.js';
export { MistralProvider } from './mistral.js';
export { OpenRouterProvider } from './openrouter.js';
export { OllamaProvider } from './ollama.js';
export { MockProvider } from './mock.js';
export { BaseProvider, ProviderError } from './base.js';
