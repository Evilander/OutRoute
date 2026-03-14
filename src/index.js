import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { timingSafeEqual } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3080;
const HOST = process.env.HOST || 'localhost';

async function main() {
  getDb();
  console.log('[prism] Database initialized');

  const { createProviders } = await import('./proxy/providers/index.js');
  const providers = createProviders();
  console.log(`[prism] Loaded ${providers.size} providers: ${[...providers.keys()].join(', ')}`);

  if (providers.size === 0) {
    console.warn('[prism] No providers configured! Add API keys to .env');
  }

  const { Router } = await import('./proxy/router.js');
  const router = new Router(providers);

  const { HealthMonitor } = await import('./health/monitor.js');
  const monitor = new HealthMonitor(providers);
  monitor.start();

  const { ModelSyncService } = await import('./services/model-sync.js');
  const modelSync = new ModelSyncService();
  await modelSync.start();

  const app = express();
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '10mb' }));

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Optional bearer token auth (set PRISM_SECRET in .env to enable)
  const secret = process.env.PRISM_SECRET;
  if (secret) {
    app.use((req, res, next) => {
      // Allow dashboard, health, and static files without auth
      if (req.path.startsWith('/dashboard') || req.path === '/' || req.path === '/health') {
        return next();
      }
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const tokenBuf = Buffer.from(token.padEnd(secret.length));
      const secretBuf = Buffer.from(secret);
      const valid = token.length === secret.length && timingSafeEqual(tokenBuf, secretBuf);
      if (!valid) {
        return res.status(401).json({
          error: { message: 'Unauthorized — set Authorization: Bearer <PRISM_SECRET>', code: 'unauthorized' },
        });
      }
      next();
    });
    console.log('[prism] Bearer token auth enabled (PRISM_SECRET set)');
  }

  app.use('/dashboard', express.static(join(__dirname, 'dashboard')));
  app.get('/', (req, res) => res.redirect('/dashboard/index.html'));

  const { default: createProxyRouter } = await import('./proxy/server.js');
  app.use(createProxyRouter(providers, router));

  const { AutoJudge } = await import('./services/auto-judge.js');
  const autoJudge = new AutoJudge(providers);
  autoJudge.start();

  const { createArenaRouter, setAutoJudge } = await import('./arena/routes.js');
  setAutoJudge(autoJudge);
  app.use('/arena', createArenaRouter(providers));

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      providers: providers.size,
      uptime: process.uptime(),
    });
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`
  ╔═══════════════════════════════════════════════╗
  ║                                               ║
  ║   ██████╗ ██████╗ ██╗███████╗███╗   ███╗      ║
  ║   ██╔══██╗██╔══██╗██║██╔════╝████╗ ████║      ║
  ║   ██████╔╝██████╔╝██║███████╗██╔████╔██║      ║
  ║   ██╔═══╝ ██╔══██╗██║╚════██║██║╚██╔╝██║      ║
  ║   ██║     ██║  ██║██║███████║██║ ╚═╝ ██║      ║
  ║   ╚═╝     ╚═╝  ╚═╝╚═╝╚══════╝╚═╝     ╚═╝      ║
  ║                                               ║
  ║   LLM Arena + Intelligent Router               ║
  ║                                               ║
  ╠═══════════════════════════════════════════════╣
  ║                                               ║
  ║   Dashboard:  http://${HOST}:${PORT}               ║
  ║   API:        http://${HOST}:${PORT}/v1/chat/completions ║
  ║   Arena:      http://${HOST}:${PORT}/arena/battle   ║
  ║   Health:     http://${HOST}:${PORT}/health         ║
  ║                                               ║
  ║   Providers:  ${[...providers.keys()].join(', ') || 'none'}
  ║                                               ║
  ╚═══════════════════════════════════════════════╝
`);
  });

  function shutdown(signal) {
    console.log(`\n[prism] ${signal} received, shutting down...`);
    monitor.stop();
    modelSync.stop();
    autoJudge.stop();
    server.close(() => {
      try { getDb().close(); } catch {}
      console.log('[prism] Goodbye.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[prism] Fatal error:', err);
  process.exit(1);
});
