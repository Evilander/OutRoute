import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, logRequest, getRequestStats, createBattle, addBattleEntry, setBattleWinner, getBattle, getAllEloRatings, getEloRating, updateEloRating } from '../src/db/store.js';

describe('Database Store', () => {
  before(() => {
    // Initialize the db (will use prism.db in project root)
    getDb();
  });

  it('should log and retrieve requests', () => {
    logRequest({
      provider: 'openai',
      model: 'gpt-4o',
      strategy: 'best',
      promptPreview: 'test prompt',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      latencyMs: 1200,
      costUsd: 0.001,
      status: 'ok',
      errorMessage: null,
      taskType: 'general',
    });

    const stats = getRequestStats(1);
    assert.ok(stats.length > 0, 'Should have request stats');
    const openaiStats = stats.find(s => s.provider === 'openai');
    assert.ok(openaiStats, 'Should have openai stats');
    assert.ok(openaiStats.total_requests >= 1, 'Should have at least 1 request');
  });

  it('should create and manage battles', () => {
    const battleId = createBattle('What is 2+2?', 'math');
    assert.ok(battleId, 'Should return battle ID');

    addBattleEntry(battleId, {
      provider: 'openai',
      model: 'gpt-4o',
      response: 'The answer is 4.',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 500,
      costUsd: 0.0001,
      position: 1,
    });

    addBattleEntry(battleId, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      response: '2 + 2 = 4',
      inputTokens: 10,
      outputTokens: 4,
      latencyMs: 600,
      costUsd: 0.0002,
      position: 2,
    });

    const battle = getBattle(battleId);
    assert.ok(battle, 'Should retrieve battle');
    assert.equal(battle.entries.length, 2, 'Should have 2 entries');
    assert.equal(battle.task_type, 'math');
  });

  it('should manage ELO ratings', () => {
    const testModel = `test-model-${Date.now()}`;
    const rating = getEloRating(testModel, 'test');
    assert.equal(rating.rating, 1500, 'Default ELO should be 1500');

    updateEloRating(testModel, 'test', 1520, true);
    const updated = getEloRating(testModel, 'test');
    assert.equal(updated.rating, 1520, 'Rating should be updated');
    assert.equal(updated.wins, 1, 'Should have 1 win');
  });
});

describe('ELO Scoring', () => {
  it('should calculate ELO correctly', async () => {
    const { calculateNewRatings } = await import('../src/arena/scorer.js');
    const result = calculateNewRatings(1500, 1500);
    assert.ok(result.newWinnerRating > 1500, 'Winner rating should increase');
    assert.ok(result.newLoserRating < 1500, 'Loser rating should decrease');
    assert.equal(
      Math.round(result.newWinnerRating + result.newLoserRating),
      3000,
      'Total ELO should be conserved'
    );
  });

  it('should give bigger boost when underdog wins', async () => {
    const { calculateNewRatings } = await import('../src/arena/scorer.js');
    const even = calculateNewRatings(1500, 1500);
    const upset = calculateNewRatings(1300, 1700);

    const evenGain = even.newWinnerRating - 1500;
    const upsetGain = upset.newWinnerRating - 1300;
    assert.ok(upsetGain > evenGain, 'Underdog win should give bigger boost');
  });
});
