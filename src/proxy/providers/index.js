import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { GroqProvider } from './groq.js';
import { OpenRouterProvider } from './openrouter.js';

const PROVIDER_CLASSES = [
  OpenAIProvider,
  AnthropicProvider,
  GoogleProvider,
  GroqProvider,
  OpenRouterProvider,
];

export function createProviders(config = {}) {
  const providers = new Map();

  for (const ProviderClass of PROVIDER_CLASSES) {
    const instance = new ProviderClass(config);
    if (instance.available) {
      providers.set(instance.name, instance);
    }
  }

  return providers;
}

export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { GoogleProvider } from './google.js';
export { GroqProvider } from './groq.js';
export { OpenRouterProvider } from './openrouter.js';
export { BaseProvider, ProviderError } from './base.js';
