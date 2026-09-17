// How many comparisons before the intervals are narrow enough to act on?
// Simulates games between models of known strength and reports the median
// 95% interval half-width, and how often the truly best model is ranked first.
//
//   node scripts/interval-width.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-sim-')), 'sim.db');
const { computeRatings } = await import('../src/arena/ratings.js');

const TRUTH = { a: 1600, b: 1550, c: 1500, d: 1400 };
const SIZES = [20, 50, 100, 200, 500, 1000];
const TRIALS = 40;

function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function simulate(count, random) {
  const names = Object.keys(TRUTH);
  const games = [];
  while (games.length < count) {
    const a = names[Math.floor(random() * names.length)];
    const b = names[Math.floor(random() * names.length)];
    if (a === b) continue;
    const expected = 1 / (1 + 10 ** ((TRUTH[b] - TRUTH[a]) / 400));
    games.push({ a, b, outcome: random() < expected ? 'a' : 'b' });
  }
  return games;
}

const median = values => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];

console.log(`Four models, true ratings ${Object.values(TRUTH).join(' / ')}, ${TRIALS} trials per row\n`);
console.log('comparisons   median ± (95%)   best model ranked first   median P(best) of true best');
for (const size of SIZES) {
  const halfWidths = [];
  const pBest = [];
  let correct = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const { models } = computeRatings(simulate(size, lcg(1000 + trial * 7919 + size)), { seed: trial + 1 });
    halfWidths.push(median(models.map(m => (m.hi - m.lo) / 2)));
    pBest.push(models.find(m => m.model === 'a').pBest);
    if (models[0].model === 'a') correct++;
  }
  console.log(
    `${String(size).padStart(11)}   ${`±${Math.round(median(halfWidths))}`.padStart(14)}   ${`${Math.round((correct / TRIALS) * 100)}%`.padStart(23)}   ${median(pBest).toFixed(2).padStart(27)}`,
  );
}
