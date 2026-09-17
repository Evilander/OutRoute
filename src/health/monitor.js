import { updateProviderHealth, getProviderHealth } from '../db/store.js';

export class HealthMonitor {
  constructor(providers, intervalMs = 60000) {
    this.providers = providers;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    this.checkAll();
    this.timer = setInterval(() => this.checkAll(), this.intervalMs);
    this.timer.unref?.();
    console.log(`[health] Monitoring ${this.providers.size} providers every ${this.intervalMs / 1000}s`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkAll() {
    const checks = [];
    for (const [name, provider] of this.providers) {
      checks.push(this.checkProvider(name, provider));
    }
    await Promise.allSettled(checks);
  }

  async checkProvider(name, provider) {
    const start = Date.now();
    try {
      const result = await provider.healthCheck();
      const latency = result?.latencyMs ?? (Date.now() - start);
      // Adapters report failure in the result rather than by throwing, so a
      // resolved health check is not a healthy one.
      if (result?.healthy) {
        updateProviderHealth(name, 'healthy', latency);
      } else {
        console.error(`[health] ${name} check failed:`, result?.reason || 'unknown reason');
        updateProviderHealth(name, 'unhealthy', latency);
      }
    } catch (err) {
      console.error(`[health] ${name} check failed:`, err.message);
      updateProviderHealth(name, 'unhealthy');
    }
  }

  getStatus() {
    return getProviderHealth();
  }
}
