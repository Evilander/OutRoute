import { getEffectiveComparisons, getComparisonVersion, getJudgeHumanPairs } from '../db/store.js';

// Ratings are fitted from the full comparison log with a Bradley-Terry model
// rather than updated one battle at a time. Online Elo depends on the order the
// battles happened in and gives no measure of uncertainty; with a few dozen
// personal votes both of those matter more than the number itself.

const ANCHOR_RATING = 1500;
const ELO_SCALE = 400;
// Every model plays one virtual game (half a win, half a loss) against a fixed
// 1500-rated opponent. It keeps undefeated models finite, ties disconnected
// groups to a common scale, and washes out after a handful of real games.
const PRIOR_GAMES = 1;
const MAX_ITERATIONS = 500;
const TOLERANCE = 1e-7;
const DEFAULT_ROUNDS = 200;
const DEFAULT_SEED = 0x5eed1e55;

// Two ratings closer than this are level. The solver stops a few hundred-thousandths
// of a point short of equal for models with identical records, and whichever was
// updated first in the sweep would otherwise win every such tie.
const LEVEL = 0.01;

// Below this many games a model is "unrated": it is listed, but not routed on.
export const MIN_GAMES = 5;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toRating = strength => ANCHOR_RATING + ELO_SCALE * Math.log10(strength);

// Cyclic minorization-maximization for Bradley-Terry (Hunter 2004). `wins` counts
// a tie as half a win for each side; `games` is a dense m x m matrix of pair counts.
function fitStrengths(wins, games, m, start) {
  const p = start ? Float64Array.from(start) : new Float64Array(m).fill(1);
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let change = 0;
    for (let i = 0; i < m; i++) {
      let denominator = PRIOR_GAMES / (p[i] + 1);
      const row = i * m;
      for (let j = 0; j < m; j++) {
        const n = games[row + j];
        if (n > 0) denominator += n / (p[i] + p[j]);
      }
      const next = (wins[i] + PRIOR_GAMES / 2) / denominator;
      change = Math.max(change, Math.abs(Math.log(next / p[i])));
      p[i] = next;
    }
    change = Math.max(change, Math.abs(recentre(p)));
    if (change < TOLERANCE) break;
  }
  return p;
}

// Real games fix only the ratios between strengths; the level of the whole field
// is set by the virtual games alone, and MM closes in on it very slowly once real
// games outnumber them. Multiplying every strength by c leaves the real-game
// likelihood unchanged, so the best c is found directly: it solves
// sum(tanh((ln c + ln p_i) / 2)) = 0, by Newton's method on t = ln c.
function recentre(p) {
  let t = 0;
  for (let step = 0; step < 50; step++) {
    let value = 0;
    let slope = 0;
    for (let i = 0; i < p.length; i++) {
      const th = Math.tanh((t + Math.log(p[i])) / 2);
      value += th;
      slope += (1 - th * th) / 2;
    }
    const move = Math.max(-2, Math.min(2, value / slope));
    t -= move;
    if (Math.abs(move) < 1e-12) break;
  }
  const c = Math.exp(t);
  for (let i = 0; i < p.length; i++) p[i] *= c;
  return t;
}

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// comparisons: [{ a, b, outcome: 'a' | 'b' | 'tie' }]
// options.models lists extra models to include with zero games.
export function computeRatings(comparisons, options = {}) {
  const { rounds = DEFAULT_ROUNDS, seed = DEFAULT_SEED, models: extraModels = [] } = options;

  const index = new Map();
  const indexOf = model => {
    if (!index.has(model)) index.set(model, index.size);
    return index.get(model);
  };

  const usable = comparisons.filter(c => c.a !== c.b);
  const n = usable.length;
  const left = new Int32Array(n);
  const right = new Int32Array(n);
  const result = new Uint8Array(n); // 0: left won, 1: right won, 2: tie
  usable.forEach((c, k) => {
    left[k] = indexOf(c.a);
    right[k] = indexOf(c.b);
    result[k] = c.outcome === 'a' ? 0 : c.outcome === 'b' ? 1 : 2;
  });
  for (const model of extraModels) indexOf(model);

  const m = index.size;
  const names = [...index.keys()];
  if (m === 0) return { models: [], samples: [], comparisons: 0, index };

  const wins = new Float64Array(m);
  const games = new Float64Array(m * m);
  const tally = names.map(() => ({ wins: 0, losses: 0, ties: 0 }));

  const accumulate = (k, w, g) => {
    const i = left[k];
    const j = right[k];
    g[i * m + j]++;
    g[j * m + i]++;
    if (result[k] === 0) w[i]++;
    else if (result[k] === 1) w[j]++;
    else {
      w[i] += 0.5;
      w[j] += 0.5;
    }
  };

  for (let k = 0; k < n; k++) {
    accumulate(k, wins, games);
    const i = left[k];
    const j = right[k];
    if (result[k] === 0) { tally[i].wins++; tally[j].losses++; }
    else if (result[k] === 1) { tally[j].wins++; tally[i].losses++; }
    else { tally[i].ties++; tally[j].ties++; }
  }

  const strengths = fitStrengths(wins, games, m);

  // Parametric bootstrap: keep who played whom, replay every game with the fitted
  // win probabilities, and refit. The spread of the refits is the uncertainty,
  // and because each refit rates every model at once, the samples stay paired
  // for model-vs-model probabilities.
  //
  // Resampling the observed games instead (the usual bootstrap) cannot produce
  // an outcome that did not happen: a model that won all five of its games wins
  // all five in every resample, the refits agree exactly, and the interval
  // collapses to a point. Small, one-sided records are the normal case for a
  // personal log, so the outcomes are simulated. The two methods agree once
  // there is plenty of mixed data.
  const random = mulberry32(seed);
  const tieRate = n > 0 ? result.reduce((count, r) => count + (r === 2 ? 1 : 0), 0) / n : 0;
  const samples = [];
  const sampleWins = new Float64Array(m);
  const sampleGames = new Float64Array(m * m);
  for (let round = 0; round < rounds && n > 0; round++) {
    sampleWins.fill(0);
    sampleGames.fill(0);
    for (let k = 0; k < n; k++) {
      const i = left[k];
      const j = right[k];
      sampleGames[i * m + j]++;
      sampleGames[j * m + i]++;
      // The fitted probability is an expected score: a tie already counts as half
      // a win in it. So ties are carved out of both sides equally, leaving the
      // expected score of the replayed game exactly where the fit put it. (Ties
      // drawn on top of the win probability instead would make every replay less
      // decisive than the record, and drag every refit toward the middle.)
      const expected = strengths[i] / (strengths[i] + strengths[j]);
      const tie = Math.min(tieRate, 2 * Math.min(expected, 1 - expected));
      const u = random();
      if (u < tie) {
        sampleWins[i] += 0.5;
        sampleWins[j] += 0.5;
      } else if (u < tie + expected - tie / 2) sampleWins[i]++;
      else sampleWins[j]++;
    }
    samples.push(Float64Array.from(fitStrengths(sampleWins, sampleGames, m, strengths), toRating));
  }

  // Models tied for the top of a refit share the credit. Giving it to whichever
  // was listed first would make P(best) depend on the order models were first seen.
  const timesBest = new Float64Array(m);
  for (const sample of samples) {
    let top = -Infinity;
    for (let i = 0; i < m; i++) if (sample[i] > top) top = sample[i];
    const leaders = [];
    for (let i = 0; i < m; i++) if (top - sample[i] < LEVEL) leaders.push(i);
    for (const i of leaders) timesBest[i] += 1 / leaders.length;
  }

  const rated = names.map((model, i) => {
    const rating = toRating(strengths[i]);
    const column = samples.map(sample => sample[i]).sort((x, y) => x - y);
    const { wins: w, losses, ties } = tally[i];
    const played = w + losses + ties;
    return {
      model,
      rating: Math.round(rating * 10) / 10,
      lo: Math.round((column.length ? quantile(column, 0.025) : rating) * 10) / 10,
      hi: Math.round((column.length ? quantile(column, 0.975) : rating) * 10) / 10,
      wins: w,
      losses,
      ties,
      games: played,
      rated: played >= MIN_GAMES,
      pBest: samples.length ? timesBest[i] / samples.length : 0,
    };
  });

  rated.sort((x, y) => y.rating - x.rating);
  return { models: rated, samples, comparisons: n, index };
}

// Share of bootstrap refits in which `model` rates below `other`. 0.5 when
// there is nothing to go on.
export function probabilityWorse(ratings, model, other) {
  const i = ratings.index.get(model);
  const j = ratings.index.get(other);
  if (i === undefined || j === undefined || ratings.samples.length === 0) return 0.5;
  // A refit that rates the two exactly level counts half each way, so two models
  // with identical records come out at 0.5, not 0.
  let worse = 0;
  for (const sample of ratings.samples) {
    if (Math.abs(sample[i] - sample[j]) < LEVEL) worse += 0.5;
    else if (sample[i] < sample[j]) worse++;
  }
  return worse / ratings.samples.length;
}

// One bootstrap refit picked at random: a plausible version of the truth given
// the data. Picking the top model of a random refit is Thompson sampling.
export function sampleRatings(ratings, random = Math.random) {
  if (ratings.samples.length === 0) return null;
  const sample = ratings.samples[Math.floor(random() * ratings.samples.length)];
  return model => {
    const i = ratings.index.get(model);
    return i === undefined ? ANCHOR_RATING : sample[i];
  };
}

const cache = new Map();
// The router asks for ratings on every request. A small log refits in a few
// milliseconds, so it is always current. Once the log is large, one more
// comparison cannot move anything much, and a refit per request would hurt: a
// fit that is a few seconds old is served instead.
const LARGE_LOG = 2000;
const LARGE_LOG_MAX_AGE_MS = 10_000;

// Ratings for one task type, or pooled across all of them when taskType is null.
export function getRatings(taskType = null, { sources = ['human', 'judge'] } = {}) {
  const key = `${taskType || '*'}|${[...sources].sort().join(',')}`;
  const version = getComparisonVersion();
  const hit = cache.get(key);
  if (hit) {
    if (hit.version === version) return hit.ratings;
    if (hit.ratings.comparisons >= LARGE_LOG && Date.now() - hit.at < LARGE_LOG_MAX_AGE_MS) return hit.ratings;
  }

  const ratings = computeRatings(getEffectiveComparisons({ taskType, sources }));
  ratings.taskType = taskType;
  cache.set(key, { version, ratings, at: Date.now() });
  return ratings;
}

export function getLeaderboard(taskType = null, options = {}) {
  return getRatings(taskType, options).models.map(({ games, ...row }) => ({
    ...row,
    battles: games,
    winRate: games > 0 ? Math.round(((row.wins + row.ties / 2) / games) * 10000) / 100 : 0,
    pBest: Math.round(row.pBest * 1000) / 1000,
    taskType: taskType || 'overall',
  }));
}

// How often the judge reaches the verdict a person reached on the same pair.
// Outcomes are re-expressed against an alphabetical pair order first: a person's
// pick is always stored as "a won", which would otherwise make chance agreement
// look near-certain and kappa meaningless.
export function judgeAgreement(pairs = getJudgeHumanPairs()) {
  if (pairs.length === 0) return { pairs: 0, agreement: null, kappa: null };

  const canonical = (a, b, outcome) => (outcome === 'tie' || a <= b ? outcome : outcome === 'a' ? 'b' : 'a');
  const categories = ['a', 'b', 'tie'];
  const humanCounts = { a: 0, b: 0, tie: 0 };
  const judgeCounts = { a: 0, b: 0, tie: 0 };
  let agreed = 0;

  for (const pair of pairs) {
    const human = canonical(pair.humanA, pair.humanB, pair.humanOutcome);
    const judge = canonical(pair.judgeA, pair.judgeB, pair.judgeOutcome);
    humanCounts[human]++;
    judgeCounts[judge]++;
    if (human === judge) agreed++;
  }

  const total = pairs.length;
  const observed = agreed / total;
  const expected = categories.reduce((sum, c) => sum + (humanCounts[c] / total) * (judgeCounts[c] / total), 0);
  return {
    pairs: total,
    agreement: Math.round(observed * 1000) / 1000,
    kappa: expected < 1 ? Math.round(((observed - expected) / (1 - expected)) * 1000) / 1000 : null,
  };
}
