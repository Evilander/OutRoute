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
      await provider.healthCheck();
      const latency = Date.now() - start;
      updateProviderHealth(name, 'healthy', latency);
    } catch (err) {
      console.error(`[health] ${name} check failed:`, err.message);
      updateProviderHealth(name, 'unhealthy');
    }
  }

  getStatus() {
    return getProviderHealth();
  }
}
