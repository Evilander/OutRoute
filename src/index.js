import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3080;
const HOST = process.env.HOST || 'localhost';

async function main() {
  // Initialize database
  getDb();
  console.log('[prism] Database initialized');

  // Load providers
  const { createProviders } = await import('./proxy/providers/index.js');
  const providers = createProviders();
  console.log(`[prism] Loaded ${providers.size} providers: ${[...providers.keys()].join(', ')}`);

  if (providers.size === 0) {
    console.warn('[prism] No providers configured! Add API keys to .env');
  }

  // Initialize router
  const { Router } = await import('./proxy/router.js');
  const router = new Router(providers);

  // Initialize health monitor
  const { HealthMonitor } = await import('./health/monitor.js');
  const monitor = new HealthMonitor(providers);
  monitor.start();

  // Create Express app
  const app = express();
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
      if (!auth.startsWith('Bearer ') || auth.slice(7) !== secret) {
        return res.status(401).json({
          error: { message: 'Unauthorized — set Authorization: Bearer <PRISM_SECRET>', code: 'unauthorized' },
        });
      }
      next();
    });
    console.log('[prism] Bearer token auth enabled (PRISM_SECRET set)');
  }

  // Dashboard static files
  app.use('/dashboard', express.static(join(__dirname, 'dashboard')));

  // Root -> dashboard
  app.get('/', (req, res) => res.redirect('/dashboard/index.html'));

  // Mount proxy routes
  const { default: createProxyRouter } = await import('./proxy/server.js');
  app.use(createProxyRouter(providers, router));

  // Mount arena routes
  const { createArenaRouter } = await import('./arena/routes.js');
  app.use('/arena', createArenaRouter(providers));

  // Health endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      providers: providers.size,
      uptime: process.uptime(),
    });
  });

  // Start server
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

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`\n[prism] ${signal} received, shutting down...`);
    monitor.stop();
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
