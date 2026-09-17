import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-ratings-')), 'test.db');
const { computeRatings, probabilityWorse, sampleRatings, judgeAgreement, MIN_GAMES } = await import('../src/arena/ratings.js');

function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// Plays `count` games between random pairs, with win odds set by the true ratings.
function simulate(truth, count, seed = 7, tieRate = 0) {
  const random = lcg(seed);
  const names = Object.keys(truth);
  const comparisons = [];
  while (comparisons.length < count) {
    const a = names[Math.floor(random() * names.length)];
    const b = names[Math.floor(random() * names.length)];
    if (a === b) continue;
    if (random() < tieRate) {
      comparisons.push({ a, b, outcome: 'tie' });
      continue;
    }
    const expected = 1 / (1 + 10 ** ((truth[b] - truth[a]) / 400));
    comparisons.push({ a, b, outcome: random() < expected ? 'a' : 'b' });
  }
  return comparisons;
}

describe('Bradley-Terry ratings', () => {
  const truth = { strong: 1700, solid: 1560, middling: 1480, weak: 1300 };

  it('recovers the true ordering and rating gaps from simulated games', () => {
    const { models } = computeRatings(simulate(truth, 1200));
    assert.deepEqual(models.map(m => m.model), ['strong', 'solid', 'middling', 'weak']);

    const byName = Object.fromEntries(models.map(m => [m.model, m]));
    const gap = byName.strong.rating - byName.weak.rating;
    assert.ok(Math.abs(gap - 400) < 60, `strong-weak gap was ${gap}, expected about 400`);
  });

  it('gives intervals that narrow as games accumulate', () => {
    const few = computeRatings(simulate(truth, 40)).models.find(m => m.model === 'solid');
    const many = computeRatings(simulate(truth, 1200)).models.find(m => m.model === 'solid');
    assert.ok(few.hi - few.lo > many.hi - many.lo);
    assert.ok(many.lo <= many.rating && many.rating <= many.hi);
  });

  it('is independent of the order the games were played in', () => {
    const games = simulate(truth, 300);
    const forward = computeRatings(games, { rounds: 0 }).models;
    const reversed = computeRatings([...games].reverse(), { rounds: 0 }).models;
    for (const row of forward) {
      const other = reversed.find(m => m.model === row.model);
      assert.ok(Math.abs(row.rating - other.rating) < 0.2);
    }
  });

  it('is deterministic for the same data and seed', () => {
    const games = simulate(truth, 200);
    assert.deepEqual(computeRatings(games).models, computeRatings(games).models);
  });

  it('keeps an undefeated model finite', () => {
    const games = Array.from({ length: 12 }, () => ({ a: 'champ', b: 'chump', outcome: 'a' }));
    const { models } = computeRatings(games);
    assert.ok(Number.isFinite(models[0].rating) && models[0].rating < 2600);
    assert.equal(models[0].model, 'champ');
  });

  it('treats a tie as half a win for each side', () => {
    const { models } = computeRatings(Array.from({ length: 20 }, () => ({ a: 'x', b: 'y', outcome: 'tie' })));
    assert.ok(Math.abs(models[0].rating - models[1].rating) < 0.5);
    assert.equal(models[0].ties, 20);
    assert.equal(models[0].wins, 0);
  });

  it('gives the same result whichever side of the pair a model is listed on', () => {
    const asA = computeRatings(Array.from({ length: 10 }, () => ({ a: 'x', b: 'y', outcome: 'a' })), { rounds: 0 });
    const asB = computeRatings(Array.from({ length: 10 }, () => ({ a: 'y', b: 'x', outcome: 'b' })), { rounds: 0 });
    assert.equal(asA.models[0].model, 'x');
    assert.equal(asB.models[0].model, 'x');
    assert.ok(Math.abs(asA.models[0].rating - asB.models[0].rating) < 0.01);
  });

  it('rates groups that never met on a shared scale', () => {
    const games = [
      ...Array.from({ length: 10 }, () => ({ a: 'a1', b: 'a2', outcome: 'a' })),
      ...Array.from({ length: 10 }, () => ({ a: 'b1', b: 'b2', outcome: 'a' })),
    ];
    const { models } = computeRatings(games, { rounds: 0 });
    assert.ok(models.every(m => Number.isFinite(m.rating)));
    const a1 = models.find(m => m.model === 'a1');
    const b1 = models.find(m => m.model === 'b1');
    assert.ok(Math.abs(a1.rating - b1.rating) < 0.5);
  });

  it('lists models with no games at 1500 and marks them unrated', () => {
    const { models } = computeRatings(simulate(truth, 100), { models: ['newcomer'] });
    const newcomer = models.find(m => m.model === 'newcomer');
    assert.equal(newcomer.rating, 1500);
    assert.equal(newcomer.games, 0);
    assert.equal(newcomer.rated, false);
    assert.ok(models.find(m => m.model === 'strong').games >= MIN_GAMES);
  });

  it('ignores a model compared against itself', () => {
    const { comparisons } = computeRatings([{ a: 'x', b: 'x', outcome: 'a' }, { a: 'x', b: 'y', outcome: 'a' }]);
    assert.equal(comparisons, 1);
  });

  it('returns an empty board for an empty log', () => {
    const ratings = computeRatings([]);
    assert.deepEqual(ratings.models, []);
    assert.equal(probabilityWorse(ratings, 'a', 'b'), 0.5);
    assert.equal(sampleRatings(ratings), null);
  });

  it('reports pBest as a probability distribution over models', () => {
    const { models } = computeRatings(simulate(truth, 600));
    const total = models.reduce((sum, m) => sum + m.pBest, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.ok(models[0].pBest > 0.9);
  });
});

describe('uncertainty when the data is thin or one-sided', () => {
  const sweep = (wins, a = 'champ', b = 'chump') => Array.from({ length: wins }, () => ({ a, b, outcome: 'a' }));

  it('does not claim certainty from a clean sweep of five games', () => {
    const ratings = computeRatings(sweep(5));
    const champ = ratings.models.find(m => m.model === 'champ');
    assert.ok(champ.hi - champ.lo > 100, `a 5-0 record gave an interval only ${champ.hi - champ.lo} wide`);
    assert.ok(probabilityWorse(ratings, 'champ', 'chump') < 0.05, 'five straight wins is strong evidence');
  });

  it('treats a single game as weak evidence', () => {
    const ratings = computeRatings(sweep(1));
    const champ = ratings.models.find(m => m.model === 'champ');
    assert.ok(champ.hi - champ.lo > 200, `${champ.lo} to ${champ.hi}`);
    const upset = probabilityWorse(ratings, 'champ', 'chump');
    assert.ok(upset > 0.1 && upset < 0.35, `one win left P(worse) at ${upset}`);
  });

  it('grows more sure as a sweep gets longer', () => {
    const upset = n => probabilityWorse(computeRatings(sweep(n)), 'champ', 'chump');
    assert.ok(upset(1) > upset(3));
    assert.ok(upset(3) > upset(10));
  });

  it('reads an even record as undecided', () => {
    const games = [...sweep(6), ...sweep(4, 'chump', 'champ')];
    const upset = probabilityWorse(computeRatings(games), 'champ', 'chump');
    assert.ok(upset > 0.08 && upset < 0.4, `6-4 gave P(worse) = ${upset}`);
  });

  it('centres each interval on its estimate, even when a third of the games are ties', () => {
    const truth = { strong: 1700, solid: 1560, middling: 1480, weak: 1300 };
    for (const tieRate of [0, 0.3]) {
      const { models } = computeRatings(simulate(truth, 400, 21, tieRate));
      for (const m of models) {
        const offCentre = Math.abs(m.rating - (m.lo + m.hi) / 2) / (m.hi - m.lo);
        assert.ok(m.lo < m.rating && m.rating < m.hi, `${m.model}: ${m.rating} outside ${m.lo}..${m.hi} (ties ${tieRate})`);
        assert.ok(offCentre < 0.2, `${m.model}: estimate sits ${Math.round(offCentre * 100)}% off the middle of its interval (ties ${tieRate})`);
      }
    }
  });

  it('does not let the order models were first seen decide between identical records', () => {
    // x and y each beat z five times and never meet: nothing separates them.
    const games = order => order.flatMap(winner => Array.from({ length: 5 }, () => ({ a: winner, b: 'z', outcome: 'a' })));
    for (const order of [['x', 'y'], ['y', 'x']]) {
      const ratings = computeRatings(games(order));
      const x = ratings.models.find(m => m.model === 'x');
      const y = ratings.models.find(m => m.model === 'y');
      assert.ok(Math.abs(x.pBest - y.pBest) < 0.15, `first seen ${order[0]}: P(best) x=${x.pBest} y=${y.pBest}`);
      const p = probabilityWorse(ratings, 'x', 'y');
      assert.ok(p > 0.35 && p < 0.65, `first seen ${order[0]}: P(x worse than y) = ${p}`);
    }
    assert.equal(probabilityWorse(computeRatings(games(['x', 'y'])), 'x', 'x'), 0.5);
  });

  it('leaves a large mixed dataset essentially as the bootstrap had it', () => {
    const { models } = computeRatings(simulate({ strong: 1700, solid: 1560, middling: 1480, weak: 1300 }, 1200));
    for (const m of models) assert.ok((m.hi - m.lo) / 2 < 40, `${m.model} half-width ${(m.hi - m.lo) / 2}`);
  });
});

describe('probabilityWorse', () => {
  it('is near 1 for a clearly weaker model and near 0.5 for a coin flip', () => {
    const clear = computeRatings(simulate({ good: 1700, bad: 1300 }, 200));
    assert.ok(probabilityWorse(clear, 'bad', 'good') > 0.99);
    assert.ok(probabilityWorse(clear, 'good', 'bad') < 0.01);

    const split = [
      ...Array.from({ length: 30 }, () => ({ a: 'left', b: 'right', outcome: 'a' })),
      ...Array.from({ length: 30 }, () => ({ a: 'left', b: 'right', outcome: 'b' })),
    ];
    const p = probabilityWorse(computeRatings(split), 'left', 'right');
    assert.ok(p > 0.3 && p < 0.7, `a 30-30 record should be a coin flip, got ${p}`);
  });
});

describe('sampleRatings', () => {
  it('draws a whole refit, so repeated draws vary for close models', () => {
    const ratings = computeRatings(simulate({ left: 1500, right: 1510 }, 40, 3));
    const random = lcg(99);
    const leaders = new Set();
    for (let i = 0; i < 50; i++) {
      const draw = sampleRatings(ratings, random);
      leaders.add(draw('left') > draw('right') ? 'left' : 'right');
    }
    assert.equal(leaders.size, 2);
  });
});

describe('judgeAgreement', () => {
  const pair = (humanOutcome, judgeOutcome, flipped = false) => ({
    humanA: 'alpha', humanB: 'beta', humanOutcome,
    judgeA: flipped ? 'beta' : 'alpha', judgeB: flipped ? 'alpha' : 'beta', judgeOutcome,
  });

  it('reads a judge pair listed in the opposite order correctly', () => {
    const result = judgeAgreement([pair('a', 'b', true), pair('a', 'b', true)]);
    assert.equal(result.agreement, 1);
  });

  it('computes kappa below raw agreement when verdicts are lopsided', () => {
    const pairs = [
      ...Array.from({ length: 8 }, () => pair('a', 'a')),
      pair('b', 'a'),
      pair('b', 'b'),
    ];
    const result = judgeAgreement(pairs);
    assert.equal(result.pairs, 10);
    assert.equal(result.agreement, 0.9);
    assert.ok(result.kappa < 0.9 && result.kappa > 0);
  });

  it('returns nulls when there is nothing to compare', () => {
    assert.deepEqual(judgeAgreement([]), { pairs: 0, agreement: null, kappa: null });
  });
});
