#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE = `prism <command>

  start                         run the server (same as npm start)
  demo                          run on built-in mock models with seeded comparisons; no API keys needed
  eval <file> --models a,b,c    run every prompt in the file against every model, judge the pairs, print ratings
  leaderboard                   print current ratings with 95% intervals
  route "<prompt>"              show which model each strategy would pick, and why, without sending anything
  export                        write the comparison log as JSON lines

Options
  --task <type>        code | analysis | creative | general
  --source <who>       all | human | judge            (leaderboard, export)
  --strategy <name>    best | value | cheapest | fastest | round-robin   (route)
  --models <ids>       comma-separated model ids      (eval)
  --max-tokens <n>     response cap per model, default 1024   (eval)
  --battles <n>        comparisons to seed, default 240       (demo)
  --port <n>           default 3080                           (start, demo)
  --json               machine-readable output
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    task: { type: 'string' },
    source: { type: 'string', default: 'all' },
    strategy: { type: 'string' },
    models: { type: 'string' },
    'max-tokens': { type: 'string', default: '1024' },
    battles: { type: 'string', default: '240' },
    port: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command = 'start', ...rest] = positionals;

// Thrown, not process.exit(): exiting while a fetch handle is still closing trips
// a libuv assertion on Windows. main() reports it and lets the loop drain.
function fail(message) {
  throw new Error(message);
}

const sources = flags.source === 'all' ? ['human', 'judge'] : [flags.source];

// A forest plot in text: each model's interval drawn on a shared scale.
function printLeaderboard(rows, title) {
  if (rows.length === 0) {
    console.log('No comparisons recorded yet.');
    return;
  }
  const width = 36;
  const low = Math.min(...rows.map(r => r.lo));
  const high = Math.max(...rows.map(r => r.hi));
  const column = value => Math.round(((value - low) / (high - low || 1)) * (width - 1));
  const nameWidth = Math.min(34, Math.max(...rows.map(r => r.model.length)));

  console.log(`\n${title}\n`);
  console.log(`${'model'.padEnd(nameWidth)}  rating  ${`${Math.round(low)}`.padEnd(width - String(Math.round(high)).length)}${Math.round(high)}  games  P(best)`);
  for (const row of rows) {
    const cells = Array(width).fill(' ');
    for (let i = column(row.lo); i <= column(row.hi); i++) cells[i] = '─';
    cells[column(row.rating)] = row.rated ? '●' : '○';
    const name = row.model.length > nameWidth ? `${row.model.slice(0, nameWidth - 1)}…` : row.model;
    console.log(`${name.padEnd(nameWidth)}  ${String(Math.round(row.rating)).padStart(6)}  ${cells.join('')}  ${String(row.battles).padStart(5)}  ${row.pBest.toFixed(2).padStart(7)}`);
  }
  console.log('\n● rated   ○ fewer than 5 games, not routed on   bars are 95% bootstrap intervals\n');
}

function readPrompts(file) {
  const path = resolve(file);
  if (!existsSync(path)) fail(`no such file: ${file}`);
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.map((line, index) => {
    if (!line.startsWith('{')) return line;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.prompt === 'string') return parsed.prompt;
    } catch {
      // fall through to the error below
    }
    return fail(`${file}:${index + 1} is not a prompt or a {"prompt": "..."} object`);
  });
}

async function loadCore() {
  await import('dotenv/config');
  const [{ createProviders, discoverModels }, { Router }, { AutoJudge }, arena, ratings, store] = await Promise.all([
    import('../src/proxy/providers/index.js'),
    import('../src/proxy/router.js'),
    import('../src/services/auto-judge.js'),
    import('../src/arena/arena.js'),
    import('../src/arena/ratings.js'),
    import('../src/db/store.js'),
  ]);
  return { createProviders, discoverModels, Router, AutoJudge, arena, ratings, store };
}

// Runs one battle per prompt and has the judge rule on it. Returns how many were judged.
async function runBattles(core, providers, prompts, pickModels, options) {
  const judge = new core.AutoJudge(providers);
  if (!judge.available) fail('no judge model is available; add a provider key, or run "prism demo"');
  let judged = 0;
  for (const [index, prompt] of prompts.entries()) {
    try {
      const battle = await core.arena.runBattle(prompt, pickModels(index), providers, {
        taskType: flags.task,
        maxTokens: Number(flags['max-tokens']) || 1024,
        origin: options.origin,
      });
      await judge.evaluate(battle.battleId);
      judged++;
    } catch (error) {
      console.error(`  prompt ${index + 1}: ${error.message}`);
    }
    if (options.progress && (index + 1) % options.progress === 0) console.error(`  ${index + 1} of ${prompts.length}`);
  }
  return judged;
}

const DEMO_PROMPTS = [
  'Write a function that merges two sorted arrays without allocating a third',
  'Why does this recursive Fibonacci implementation slow to a crawl past n = 35?',
  'Refactor a 200-line Express route handler into testable pieces',
  'Compare the pros and cons of SQLite and Postgres for a single-user desktop app',
  'Summarize the tradeoffs between leasing and buying a delivery van for a two-person business',
  'Evaluate whether a four-day work week would suit a customer support team of six',
  'Write a short poem about a lighthouse keeper who is afraid of the sea',
  'Draft a wedding toast for my sister that is warm but not sappy',
  'Write a product tagline for a bicycle repair shop that also sells coffee',
  'What should I check before buying a used car from a private seller?',
  'How do I get a stubborn houseplant to flower again?',
  'Plan a three-day trip to a city I have never visited, on a small budget',
];

async function seedDemo(core, providers, count) {
  const { getComparisonVersion, addComparison, getBattle, setBattleWinner } = core.store;
  if (!getComparisonVersion().startsWith('0:')) return;

  console.error(`Seeding ${count} comparisons between the mock models…`);
  const models = providers.get('mock').models.map(m => m.id);
  let state = 20260917;
  const random = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const prompts = Array.from({ length: count }, (_, i) => `${DEMO_PROMPTS[i % DEMO_PROMPTS.length]} (variation ${i + 1})`);
  const pick = () => {
    const shuffled = [...models].sort(() => random() - 0.5);
    return shuffled.slice(0, 2);
  };
  await runBattles(core, providers, prompts, pick, { origin: 'eval', progress: 60 });

  // A stand-in for the person at the keyboard, so the Judge page has agreement to
  // show: they vote on about a third of the battles, mostly prefer the response
  // with more substance, and have no patience for padding.
  const db = core.store.getDb();
  const battles = db.prepare("SELECT id FROM battles WHERE origin = 'eval' ORDER BY id").all();
  for (const { id } of battles) {
    if (random() > 0.35) continue;
    const battle = getBattle(id);
    const [a, b] = battle.entries;
    if (!a || !b || a.model === b.model) continue;
    const taste = entry => entry.response.split('\n').filter(l => l.startsWith('- ')).length - (entry.response.length > 900 ? 3 : 0) + (random() - 0.5) * 2.4;
    const margin = taste(a) - taste(b);
    const outcome = Math.abs(margin) < 0.4 ? 'tie' : margin > 0 ? 'a' : 'b';
    addComparison({ battleId: id, modelA: a.model, modelB: b.model, outcome, taskType: battle.task_type, source: 'human' });
    setBattleWinner(id, outcome === 'tie' ? null : outcome === 'a' ? a.id : b.id);
  }
}

async function main() {
  if (flags.help || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (flags.port) process.env.PORT = flags.port;
  if (!['all', 'human', 'judge'].includes(flags.source)) fail('--source must be all, human or judge');

  // Arguments are checked before anything touches the network or the database.
  const routePrompt = rest.join(' ');
  const evalModels = [...new Set((flags.models || '').split(',').map(m => m.trim()).filter(Boolean))];
  if (command === 'route' && !routePrompt) fail('give a prompt to route, in quotes');
  if (command === 'eval') {
    if (!rest[0]) fail('give a prompts file: prism eval prompts.txt --models a,b');
    if (evalModels.length < 2) fail('--models needs at least two model ids');
  }
  const evalPrompts = command === 'eval' ? readPrompts(rest[0]) : [];
  if (!['start', 'demo', 'leaderboard', 'export', 'route', 'eval'].includes(command)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (command === 'start') {
    const { start } = await import('../src/index.js');
    return start();
  }

  if (command === 'demo') {
    process.env.PRISM_DEMO = '1';
    process.env.DB_PATH ||= resolve('prism-demo.db');
    const core = await loadCore();
    const { MockProvider } = await import('../src/proxy/providers/mock.js');
    const instant = new Map([['mock', new MockProvider({ mock: { enabled: true, latencyScale: 0 } })]]);
    await seedDemo(core, instant, Math.max(10, Number(flags.battles) || 240));
    const { start } = await import('../src/index.js');
    return start({ providers: new Map([['mock', new MockProvider({ mock: { enabled: true } })]]) });
  }

  const core = await loadCore();

  if (command === 'leaderboard') {
    const rows = core.ratings.getLeaderboard(flags.task || null, { sources });
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else printLeaderboard(rows, `Ratings for ${flags.task || 'all tasks'} (${flags.source === 'all' ? 'your votes and the judge' : flags.source})`);
    return core.store.closeDb();
  }

  if (command === 'export') {
    for (const row of core.store.getEffectiveComparisons({ taskType: flags.task || null, sources })) {
      console.log(JSON.stringify(row));
    }
    return core.store.closeDb();
  }

  const providers = core.createProviders();
  await core.discoverModels(providers);

  if (command === 'route') {
    const prompt = routePrompt;
    const { detectTaskType } = await import('../src/tasks.js');
    const router = new core.Router(providers);
    const taskType = flags.task || detectTaskType([{ role: 'user', content: prompt }]);
    const { STRATEGIES } = await import('../src/proxy/router.js');
    const strategies = flags.strategy ? [flags.strategy] : STRATEGIES;
    const picks = strategies.map(strategy => {
      const [first] = router.rank(strategy, taskType);
      return { strategy, model: first?.model ?? null, provider: first?.provider ?? null, reason: first?.reason ?? 'no model available' };
    });
    if (flags.json) console.log(JSON.stringify({ taskType, picks }, null, 2));
    else {
      console.log(`\nTask type: ${taskType}\n`);
      for (const pick of picks) console.log(`${pick.strategy.padEnd(12)} ${String(pick.model).padEnd(30)} ${pick.reason}`);
      console.log('');
    }
    return core.store.closeDb();
  }

  if (command === 'eval') {
    const models = evalModels;
    const prompts = evalPrompts;
    console.error(`${prompts.length} prompts × ${models.length} models`);
    const judged = await runBattles(core, providers, prompts, () => models, { origin: 'eval', progress: 5 });
    const rows = core.ratings.getLeaderboard(flags.task || null, { sources }).filter(r => models.includes(r.model));
    if (flags.json) console.log(JSON.stringify({ judged, ratings: rows }, null, 2));
    else printLeaderboard(rows, `${judged} of ${prompts.length} prompts judged. Ratings include earlier comparisons of these models.`);
    return core.store.closeDb();
  }

}

main().catch(error => {
  console.error(`prism: ${error.message}`);
  process.exitCode = 1;
});
