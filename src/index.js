import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { createHash, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from './db/store.js';
import { TASK_TYPES } from './tasks.js';
import { createProviders, discoverModels } from './proxy/providers/index.js';
import { Router, STRATEGIES } from './proxy/router.js';
import createProxyRouter from './proxy/server.js';
import { HealthMonitor } from './health/monitor.js';
import { ModelSyncService } from './services/model-sync.js';
import { AutoJudge } from './services/auto-judge.js';
import { ShadowEvaluator } from './services/shadow.js';
import { createArenaRouter } from './arena/routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 60_000;

const digest = value => createHash('sha256').update(value).digest();

function hostnameOf(hostHeader = '') {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0];
}

export async function createApp(config = {}) {
  const host = config.host ?? process.env.HOST ?? 'localhost';
  const secret = config.secret ?? process.env.PRISM_SECRET ?? '';
  let corsOrigin = config.corsOrigin ?? process.env.CORS_ORIGIN ?? '';
  if (corsOrigin.trim() === '*') {
    // A wildcard would let any page the user visits drive this server with their keys.
    console.warn('[prism] CORS_ORIGIN=* is refused. Name the one origin that needs access.');
    corsOrigin = '';
  }

  getDb();

  const providers = config.providers ?? createProviders(config);
  const demo = providers.has('mock');
  const router = new Router(providers);
  const autoJudge = new AutoJudge(providers, {
    judgeModel: process.env.JUDGE_MODEL,
    judgeProvider: process.env.JUDGE_PROVIDER,
  });
  const shadow = new ShadowEvaluator({
    providers,
    router,
    autoJudge,
    rate: Number(config.shadowRate ?? process.env.SHADOW_RATE ?? 0),
    budgetUsd: Number(config.shadowBudgetUsd ?? process.env.SHADOW_DAILY_BUDGET_USD ?? 1),
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // Bound to loopback, the only legitimate Host headers are loopback names. A page
  // on another origin can point its own hostname at 127.0.0.1 (DNS rebinding) and
  // would otherwise be served as same-origin, with the user's API keys behind it.
  // ALLOWED_HOSTS turns the same check on for other binds (the Docker image sets it).
  const extraHosts = (config.allowedHosts ?? process.env.ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean);
  if (LOOPBACK.has(host) || extraHosts.length > 0) {
    const allowed = new Set([...LOOPBACK, ...extraHosts]);
    app.use((req, res, next) => {
      if (allowed.has(hostnameOf(req.headers.host))) return next();
      res.status(421).json({ error: { message: 'Unrecognised Host header. Add it to ALLOWED_HOSTS if this is intended.', code: 'bad_host' } });
    });
  }

  // No CORS headers unless asked for: the dashboard is same-origin, and a wildcard
  // would let any site the user visits spend their provider credits through this server.
  if (corsOrigin) {
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', corsOrigin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Prism-No-Shadow');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.use(express.json({ limit: '10mb' }));

  if (secret) {
    // Header bytes arrive decoded as latin1. A client may have sent the secret as
    // UTF-8 (curl) or as latin1 (browsers), so both encodings of it are accepted.
    const expected = [digest(Buffer.from(secret, 'utf8')), digest(Buffer.from(secret, 'latin1'))];
    const open = path => path === '/' || path === '/health' || path === '/api/config' || path === '/dashboard' || path.startsWith('/dashboard/');
    // Wrong tokens are counted per address, so the secret cannot be guessed at line rate.
    const failures = new Map();
    app.use((req, res, next) => {
      if (open(req.path)) return next();
      const address = req.ip || req.socket?.remoteAddress || 'unknown';
      const now = Date.now();
      let failed = failures.get(address);
      if (failed && now - failed.since > AUTH_FAILURE_WINDOW_MS) {
        failures.delete(address);
        failed = undefined;
      }
      if (failed && failed.count >= AUTH_FAILURE_LIMIT) {
        return res.status(429).json({ error: { message: 'Too many failed attempts. Try again in a minute.', code: 'too_many_attempts' } });
      }

      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      // Digests are compared so the check takes the same time whatever the token's length.
      const presented = digest(Buffer.from(token, 'latin1'));
      const matches = expected.map(e => timingSafeEqual(presented, e));
      if (token && matches.includes(true)) return next();

      if (failed) failed.count++;
      else {
        if (failures.size >= 10_000) failures.clear();
        failures.set(address, { since: now, count: 1 });
      }
      res.status(401).json({
        error: { message: 'Unauthorized. Send Authorization: Bearer <PRISM_SECRET>.', code: 'unauthorized' },
      });
    });
  }

  app.use('/dashboard', express.static(join(__dirname, 'dashboard')));
  app.get('/', (req, res) => res.redirect('/dashboard/'));

  const info = {
    version,
    demo,
    authRequired: Boolean(secret),
    strategies: STRATEGIES,
    defaultStrategy: process.env.DEFAULT_STRATEGY || 'best',
    taskTypes: TASK_TYPES,
  };
  app.use(createProxyRouter(providers, router, { shadow, info }));
  app.use('/arena', createArenaRouter(providers, { autoJudge }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version, providers: providers.size, uptime: process.uptime() });
  });

  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { message: 'Request body too large', code: 'payload_too_large' } });
    }
    if (err instanceof SyntaxError || err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'Request body is not valid JSON', code: 'invalid_json' } });
    }
    console.error('[prism] unhandled error:', err?.message);
    res.status(500).json({ error: { message: 'Internal server error', code: 'internal_error' } });
  });

  return { app, providers, router, autoJudge, shadow, demo, authRequired: Boolean(secret) };
}

export async function start(config = {}) {
  const port = Number(process.env.PORT) || 3080;
  const host = process.env.HOST || 'localhost';

  const { app, providers, autoJudge, shadow, demo, authRequired } = await createApp({ host, ...config });

  const monitor = new HealthMonitor(providers);
  const modelSync = new ModelSyncService();
  monitor.start();
  autoJudge.start();
  // Catalog and price discovery hit the network; the server does not wait on them.
  // On mock models alone there is nothing to discover, and demo mode makes no requests at all.
  if ([...providers.keys()].some(name => name !== 'mock')) {
    discoverModels(providers).catch(err => console.error('[prism] model discovery failed:', err.message));
  }
  if (providers.has('openrouter')) {
    modelSync.start().catch(err => console.error('[prism] model sync failed:', err.message));
  }

  // "localhost" resolves to ::1 first on Windows, and a server bound there refuses
  // http://127.0.0.1. Bound to 127.0.0.1, both spellings work: clients that try
  // ::1 first fall back to IPv4.
  const server = app.listen(port, host === 'localhost' ? '127.0.0.1' : host, () => {
    const base = `http://${host}:${port}`;
    console.log(`\n  Prism ${version}`);
    console.log(`  Dashboard   ${base}/`);
    console.log(`  API         ${base}/v1/chat/completions`);
    console.log(`  Providers   ${[...providers.keys()].join(', ') || 'none'}`);
    console.log(`  Judge       ${autoJudge.available ? `${autoJudge.judgeInfo.provider}/${autoJudge.judgeInfo.model}` : 'unavailable'}`);
    const shadowStats = shadow.stats();
    console.log(`  Shadow      ${shadowStats.enabled ? `${Math.round(shadowStats.rate * 100)}% of traffic, $${shadowStats.budgetUsd.toFixed(2)}/day cap` : 'off'}`);
    if (demo) console.log('\n  Demo mode: responses come from built-in mock models. Add an API key to .env for real ones.');
    if (!LOOPBACK.has(host) && !authRequired) {
      console.warn(`\n  Warning: listening on ${host} without PRISM_SECRET. Anyone who can reach this port can spend your API keys.`);
    }
    console.log('');
  });

  let stopping = false;
  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`\n[prism] ${signal} received, shutting down`);
    monitor.stop();
    modelSync.stop();
    autoJudge.stop();
    // Open SSE streams would otherwise hold the server open until the timeout below.
    server.closeAllConnections?.();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Windows hands over the script path with whatever drive-letter case the shell used.
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  start().catch(err => {
    console.error('[prism] Fatal error:', err);
    process.exit(1);
  });
}
