import { OpenAIProvider } from './openai.js';
import { isChatModelId } from './base.js';

const DEFAULT_HOST = 'http://localhost:11434';
const PROBE_TIMEOUT_MS = 3_000;

// Local models cost nothing and their context window isn't reported by /api/tags
// (no field for it — details carries only parameter_size/quantization_level), so
// a conservative default stands in until a real request tells us otherwise.
const LOCAL_CONTEXT_WINDOW = 8_192;

export class OllamaProvider extends OpenAIProvider {
  #host;
  #hostConfigured;
  #probedOk = false;

  constructor(config = {}) {
    const host = (config.baseUrl || process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/+$/, '');
    super({
      ...config,
      apiKey: config.apiKey || 'ollama', // unused by Ollama, but keeps the shared Authorization header harmless
      baseUrl: `${host}/v1`,
      providerName: 'ollama',
      models: config.models || [],
    });
    this.#host = host;
    this.#hostConfigured = Boolean(config.baseUrl || process.env.OLLAMA_HOST);
  }

  get name() {
    return 'ollama';
  }

  get local() {
    return true;
  }

  // Only "available" once the user pointed us at a host, or a probe actually found
  // one running — an unset OLLAMA_HOST with nothing on localhost:11434 must not
  // make ollama look like a usable provider to the router.
  get available() {
    return this.#hostConfigured || this.#probedOk;
  }

  async discoverModels() {
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.#host}/api/tags`, { method: 'GET' }, PROBE_TIMEOUT_MS);
      try {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const models = (data.models || [])
          .map(m => m.model || m.name)
          .filter(id => typeof id === 'string' && isChatModelId(id))
          .map(id => ({ id, name: id, contextWindow: LOCAL_CONTEXT_WINDOW, costPer1kInput: 0, costPer1kOutput: 0 }));
        this.setDiscoveredModels(models);
        this.#probedOk = true;
      } finally {
        clear();
      }
    } catch (err) {
      // No local Ollama running is the common case, not something worth alarming about.
      console.error('[ollama] probe failed, staying unavailable:', err.message);
    }
  }

  async healthCheck() {
    const startTime = Date.now();
    try {
      const { response, clear } = await this.fetchWithTimeout(`${this.#host}/api/tags`, { method: 'GET' }, PROBE_TIMEOUT_MS);
      try {
        const latencyMs = Date.now() - startTime;
        if (!response.ok) return { healthy: false, latencyMs, reason: `HTTP ${response.status}` };
        this.#probedOk = true;
        return { healthy: true, latencyMs, provider: this.name };
      } finally {
        clear();
      }
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - startTime, reason: err.message };
    }
  }
}
