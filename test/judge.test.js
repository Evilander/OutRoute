import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'prism-judge-')), 'test.db');

const store = await import('../src/db/store.js');
const { MockProvider } = await import('../src/proxy/providers/mock.js');
const { AutoJudge } = await import('../src/services/auto-judge.js');
const { judgeAgreement } = await import('../src/arena/ratings.js');

function mockProviders() {
  return new Map([['mock', new MockProvider({ mock: { enabled: true, latencyScale: 0 } })]]);
}

// The mock judge scores a response by its number of distinct "- " lines minus a
// length penalty past 900 chars (see proxy/providers/mock.js#scoreResponse).
function bullets(count, label = 'p') {
  return Array.from({ length: count }, (_, i) => `- ${label} point ${i}`).join('\n');
}

// A judge that never produces parseable output, so every pair it judges is a
// parse failure — used to exercise the "spend happened but nothing could be
// recorded" path.
function garbageJudgeProvider(modelId = 'garbage-judge') {
  const model = { id: modelId, costPer1kInput: 0.001, costPer1kOutput: 0.002 };
  return {
    name: 'garbage',
    available: true,
    local: false,
    models: [model],
    ownsModel: id => id === modelId,
    async chat() {
      return { content: 'this is not json and has no fenced block', inputTokens: 50, outputTokens: 50 };
    },
    estimateCost(inputTokens, outputTokens) {
      return (inputTokens * model.costPer1kInput) / 1000 + (outputTokens * model.costPer1kOutput) / 1000;
    },
  };
}

function seedBattle(entries, { taskType = 'general', origin = 'arena' } = {}) {
  const battleId = Number(store.createBattle('which response is better?', taskType, origin));
  const ids = entries.map((e, i) => Number(store.addBattleEntry(battleId, {
    provider: 'mock', model: e.model, response: e.response,
    inputTokens: 5, outputTokens: 5, latencyMs: 1, costUsd: 0.0001, position: i + 1,
  }).lastInsertRowid));
  return { battleId, ids };
}

describe('AutoJudge — judge selection', () => {
  it('is unavailable with no providers, and evaluate() is a harmless no-op', async () => {
    const judge = new AutoJudge(new Map(), {});
    assert.equal(judge.available, false);
    assert.deepEqual(judge.judgeInfo, { provider: null, model: null });
    await assert.doesNotReject(judge.evaluate(999));
  });

  it('falls back to the cheapest available model and marks the evaluation same-family when no other provider exists', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const { battleId } = seedBattle([
      { model: 'mock-careful', response: bullets(5) },
      { model: 'mock-quick', response: bullets(1) },
    ]);

    await judge.evaluate(battleId);

    const evaluation = store.getEvaluation(battleId);
    assert.ok(evaluation);
    assert.equal(evaluation.judge_model, 'mock-quick'); // cheapest of the 4 mock models
    assert.ok(evaluation.reasoning.startsWith('[same-family judge]'));
  });

  it('prefers a judge from a provider with no contestant in the battle, and does not mark it same-family', async () => {
    const providers = mockProviders();
    providers.set('judge-mock', new MockProvider({ mock: { enabled: true, latencyScale: 0 } }));
    const judge = new AutoJudge(providers, { judgeModel: 'mock-careful', judgeProvider: 'judge-mock' });

    assert.deepEqual(judge.judgeInfo, { provider: 'judge-mock', model: 'mock-careful' });

    const { battleId } = seedBattle([
      { model: 'd1', response: bullets(3) },
      { model: 'd2', response: bullets(1) },
    ]);
    await judge.evaluate(battleId);

    const evaluation = store.getEvaluation(battleId);
    assert.equal(evaluation.judge_model, 'mock-careful');
    assert.ok(!evaluation.reasoning.startsWith('[same-family judge]'));
  });
});

describe('AutoJudge — verdicts', () => {
  it('records a consistent win when the position swap agrees', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const { battleId } = seedBattle([
      { model: 'strong', response: bullets(5) },
      { model: 'weak', response: bullets(1) },
    ]);

    await judge.evaluate(battleId);

    const comparisons = store.getBattleComparisons(battleId);
    assert.equal(comparisons.length, 1);
    assert.equal(comparisons[0].source, 'judge');
    assert.equal(comparisons[0].consistent, 1);
    assert.equal(comparisons[0].model_a, 'strong');
    assert.equal(comparisons[0].outcome, 'a');

    const evaluation = store.getEvaluation(battleId);
    assert.equal(evaluation.winner_model, 'strong');
    assert.ok(evaluation.cost_usd > 0);
  });

  it('records a tie with consistent = 0 when the position swap disagrees (mock\'s position bias on a close call)', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const { battleId } = seedBattle([
      { model: 'alpha', response: bullets(2, 'alpha') },
      { model: 'beta', response: bullets(2, 'beta') },
    ]);

    await judge.evaluate(battleId);

    const comparisons = store.getBattleComparisons(battleId);
    assert.equal(comparisons.length, 1);
    assert.equal(comparisons[0].source, 'judge');
    assert.equal(comparisons[0].consistent, 0);
    assert.equal(comparisons[0].outcome, 'tie');
  });

  it('never judges an errored or empty entry', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const { battleId } = seedBattle([
      { model: 'ok-1', response: bullets(3) },
      { model: 'ok-2', response: bullets(2) },
      { model: 'broken', response: '' },
    ]);

    await judge.evaluate(battleId);

    const comparisons = store.getBattleComparisons(battleId);
    assert.equal(comparisons.length, 1);
    assert.ok(comparisons.every(c => c.model_a !== 'broken' && c.model_b !== 'broken'));
  });

  it('is idempotent: a second evaluate() call adds no further comparisons', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const { battleId } = seedBattle([
      { model: 'strong', response: bullets(5) },
      { model: 'weak', response: bullets(1) },
    ]);

    await judge.evaluate(battleId);
    const first = store.getBattleComparisons(battleId).length;
    await judge.evaluate(battleId);
    assert.equal(store.getBattleComparisons(battleId).length, first);
  });

  it('still judges a battle a human already voted on, without touching its status or winner', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const { battleId, ids } = seedBattle([
      { model: 'strong', response: bullets(5) },
      { model: 'weak', response: bullets(1) },
    ]);
    store.setBattleWinner(battleId, ids[0]);
    store.addComparison({ battleId, modelA: 'strong', modelB: 'weak', outcome: 'a', taskType: 'general', source: 'human' });

    await judge.evaluate(battleId);

    const battle = store.getBattle(battleId);
    assert.equal(battle.status, 'voted');
    assert.equal(battle.entries.find(e => e.id === ids[0]).is_winner, 1);

    const comparisons = store.getBattleComparisons(battleId);
    assert.equal(comparisons.length, 2);
    assert.ok(comparisons.some(c => c.source === 'human'));
    assert.ok(comparisons.some(c => c.source === 'judge'));

    const agreement = judgeAgreement();
    assert.ok(agreement.pairs >= 1);
  });

  it('judges all pairs for up to 4 entries', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const { battleId } = seedBattle([
      { model: 'a1', response: bullets(1) },
      { model: 'a2', response: bullets(2) },
      { model: 'a3', response: bullets(3) },
    ]);

    await judge.evaluate(battleId);
    assert.equal(store.getBattleComparisons(battleId).length, 3); // 3 choose 2
  });

  it('runs a single-elimination bracket above 4 entries, recording only played matches', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const { battleId } = seedBattle([
      { model: 'm1', response: bullets(1) },
      { model: 'm2', response: bullets(2) },
      { model: 'm3', response: bullets(3) },
      { model: 'm4', response: bullets(4) },
      { model: 'm5', response: bullets(5) },
    ]);

    await judge.evaluate(battleId);
    assert.equal(store.getBattleComparisons(battleId).length, 4); // fewer than 5 choose 2 = 10
    assert.equal(store.getEvaluation(battleId).winner_model, 'm5');
  });

  it('feeds the store\'s length-bias query — how often the judge picks the longer response', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const before = store.getJudgeLengthBias();
    const { battleId } = seedBattle([
      { model: 'long', response: bullets(5) },
      { model: 'short', response: bullets(1) },
    ]);

    await judge.evaluate(battleId);

    const after = store.getJudgeLengthBias();
    assert.equal(after.pairs - before.pairs, 1);
    assert.equal(after.longerWins - before.longerWins, 1);
  });
});

describe('AutoJudge — total parse failure', () => {
  it('logs the incurred judge cost instead of discarding it silently when nothing could be judged', async () => {
    const providers = mockProviders();
    providers.set('garbage', garbageJudgeProvider());
    const judge = new AutoJudge(providers, { judgeModel: 'garbage-judge', judgeProvider: 'garbage' });
    assert.deepEqual(judge.judgeInfo, { provider: 'garbage', model: 'garbage-judge' });

    const { battleId } = seedBattle([
      { model: 'a1', response: bullets(3) },
      { model: 'a2', response: bullets(2) },
    ]);

    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await judge.evaluate(battleId);
    } finally {
      console.error = originalError;
    }

    assert.equal(store.getEvaluation(battleId), undefined, 'no evaluation row when nothing was judged');
    assert.equal(store.getBattleComparisons(battleId).length, 0);
    assert.ok(
      errors.some(e => e.includes(String(battleId)) && e.includes('judge cost')),
      `expected a logged judge-cost warning, got: ${JSON.stringify(errors)}`,
    );
  });

  it('is still idempotent afterwards: a battle judged as a total parse failure will retry (no fake evaluation row blocks a later real judge)', async () => {
    const providers = mockProviders();
    providers.set('garbage', garbageJudgeProvider());
    // A second, real judge option cheaper than the garbage one, so the
    // no-override AutoJudge below picks it instead of repeating the failure.
    providers.set('mock-judge', new MockProvider({ mock: { enabled: true, latencyScale: 0 } }));

    const flakyJudge = new AutoJudge(providers, { judgeModel: 'garbage-judge', judgeProvider: 'garbage' });
    const { battleId } = seedBattle([
      { model: 'a1', response: bullets(3) },
      { model: 'a2', response: bullets(2) },
    ]);

    const originalError = console.error;
    console.error = () => {};
    try {
      await flakyJudge.evaluate(battleId);
    } finally {
      console.error = originalError;
    }
    assert.equal(store.getEvaluation(battleId), undefined);

    // judgeInfo ignores per-battle exclusions (it reports the cheapest judge
    // overall, contestants or not), so the meaningful check is the actual
    // per-battle pick evaluate() makes: excluding the 'mock' contestants
    // leaves 'mock-judge' cheaper than 'garbage', so it is used instead of
    // repeating the parse failure.
    const realJudge = new AutoJudge(providers, {});
    await realJudge.evaluate(battleId);
    const evaluation = store.getEvaluation(battleId);
    assert.ok(evaluation);
    assert.notEqual(evaluation.judge_model, 'garbage-judge');
  });
});

describe('AutoJudge — a judge whose provider is not answering', () => {
  // A key can be present and the account still unusable (no credit, revoked):
  // the provider reports itself available and only a real call finds out.
  function deadJudgeProvider() {
    const calls = { count: 0 };
    return {
      calls,
      provider: {
        name: 'dead',
        available: true,
        local: false,
        models: [{ id: 'dead-judge', costPer1kInput: 0.0001, costPer1kOutput: 0.0001 }],
        ownsModel: id => id === 'dead-judge',
        async chat() {
          calls.count++;
          const err = new Error('Your credit balance is too low');
          err.status = 400;
          throw err;
        },
        estimateCost: () => 0,
      },
    };
  }

  it('falls through to the next judge and records the verdict under the judge that ruled', async () => {
    const dead = deadJudgeProvider();
    const providers = mockProviders();
    providers.set('dead', dead.provider);
    providers.set('backup', new MockProvider({ mock: { enabled: true, latencyScale: 0 } }));
    const judge = new AutoJudge(providers, { judgeModel: 'dead-judge', judgeProvider: 'dead' });

    const { battleId } = seedBattle([
      { model: 'a1', response: bullets(5) },
      { model: 'a2', response: bullets(2) },
    ]);
    const silence = [console.error, console.warn];
    console.error = () => {};
    console.warn = () => {};
    try {
      await judge.evaluate(battleId);
    } finally {
      [console.error, console.warn] = silence;
    }

    const [comparison] = store.getBattleComparisons(battleId);
    assert.ok(comparison, 'the battle must still get a verdict');
    assert.notEqual(comparison.judge_model, 'dead-judge');
    assert.equal(comparison.outcome, 'a');
    assert.equal(store.getEvaluation(battleId).judge_model, comparison.judge_model);

    // The dead provider sits out the next battle instead of being paid a visit every time.
    const callsAfterFirst = dead.calls.count;
    const second = seedBattle([
      { model: 'a1', response: bullets(4) },
      { model: 'a2', response: bullets(1) },
    ]);
    await judge.evaluate(second.battleId);
    assert.equal(dead.calls.count, callsAfterFirst);
    assert.ok(store.getEvaluation(second.battleId));
  });

  it('stops calling once every judge has failed, rather than retrying it for each remaining pair', async () => {
    const dead = deadJudgeProvider();
    const judge = new AutoJudge(new Map([['dead', dead.provider]]), {});
    const { battleId } = seedBattle([
      { model: 'a1', response: bullets(5) },
      { model: 'a2', response: bullets(3) },
      { model: 'a3', response: bullets(1) },
    ]);
    const originalError = console.error;
    console.error = () => {};
    try {
      await judge.evaluate(battleId);
    } finally {
      console.error = originalError;
    }
    assert.equal(dead.calls.count, 2, 'three entries make three pairs; only the first pair should reach the dead judge');
  });

  it('records nothing, and no evaluation, when every judge is down', async () => {
    const dead = deadJudgeProvider();
    const providers = new Map([['dead', dead.provider]]);
    const judge = new AutoJudge(providers, {});
    const { battleId } = seedBattle([
      { model: 'a1', response: bullets(5) },
      { model: 'a2', response: bullets(2) },
    ]);
    const originalError = console.error;
    console.error = () => {};
    try {
      await judge.evaluate(battleId);
    } finally {
      console.error = originalError;
    }
    assert.equal(store.getBattleComparisons(battleId).length, 0);
    assert.equal(store.getEvaluation(battleId), undefined);
  });
});

describe('AutoJudge — queue', () => {
  it('bounds the queue and drops the oldest entry once full, logging it', async () => {
    const providers = mockProviders();
    const judge = new AutoJudge(providers, {});
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      for (let i = 0; i < 210; i++) judge.enqueue(1_000_000 + i);
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      judge.stop();
      console.warn = originalWarn;
    }
    assert.ok(warnings.some(w => w.includes('queue full')));
  });
});
