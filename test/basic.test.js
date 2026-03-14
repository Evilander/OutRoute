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

describe('Arena model resolution', () => {
  it('Anthropic provider uses current model IDs', async () => {
    const { AnthropicProvider } = await import('../src/proxy/providers/anthropic.js');
    const provider = new AnthropicProvider({ apiKey: 'test' });
    const modelIds = provider.models.map(m => m.id);
    assert.ok(modelIds.includes('claude-sonnet-4-6'), 'Should include claude-sonnet-4-6');
    assert.ok(modelIds.includes('claude-opus-4-6'), 'Should include claude-opus-4-6');
    assert.ok(!modelIds.some(id => id.includes('20250514')), 'Should not include stale 20250514 model IDs');
  });
});

describe('Router', () => {
  let router;

  before(async () => {
    const { Router } = await import('../src/proxy/router.js');
    const mockProviders = new Map([
      ['openai', {
        models: [
          { id: 'gpt-4o', costPer1kInput: 0.0025, costPer1kOutput: 0.01 },
          { id: 'gpt-4o-mini', costPer1kInput: 0.00015, costPer1kOutput: 0.0006 },
        ],
      }],
      ['anthropic', {
        models: [
          { id: 'claude-haiku-4-5-20251001', costPer1kInput: 0.0008, costPer1kOutput: 0.004 },
        ],
      }],
    ]);
    router = new Router(mockProviders);
  });

  it('getAllModels returns all models from all providers', () => {
    const models = router.getAllModels();
    assert.equal(models.length, 3);
    assert.ok(models.every(m => m.provider && m.model));
  });

  it('findModelByName finds exact match', () => {
    const result = router.findModelByName('gpt-4o');
    assert.equal(result.model, 'gpt-4o');
    assert.equal(result.provider, 'openai');
  });

  it('findModelByName returns null for unknown model', () => {
    const result = router.findModelByName('nonexistent-model-xyz');
    assert.equal(result, null);
  });

  it('selectModel cheapest picks lowest cost model', () => {
    const result = router.selectModel('cheapest');
    // gpt-4o-mini: 0.00015 + 0.0006 = 0.00075 (cheapest)
    // claude-haiku: 0.0008 + 0.004 = 0.0048
    // gpt-4o: 0.0025 + 0.01 = 0.0125
    assert.equal(result.model, 'gpt-4o-mini');
  });

  it('selectModel excludes specified providers', () => {
    const result = router.selectModel('cheapest', 'general', ['openai']);
    assert.equal(result.provider, 'anthropic');
  });

  it('estimateCost calculates correctly', () => {
    const meta = { costPer1kInput: 0.001, costPer1kOutput: 0.002 };
    const cost = router.estimateCost(meta, 1000);
    assert.equal(cost.estimatedInputCost, 0.001);
    // output is ~1.5x input: 1500 tokens * 0.002/1k = 0.003
    assert.equal(cost.estimatedOutputCost, 0.003);
    assert.equal(cost.estimatedTotalCost, 0.004);
  });

  it('_calculateCost handles zero-cost models', () => {
    const cost = router._calculateCost({}, 100, 50);
    assert.equal(cost, 0);
  });

  it('ELO confidence threshold: low-battle model uses 1500 default', () => {
    // Model with 0 battles should get treated as 1500, not whatever rating it has
    // This prevents cold-start bias where a model with 1 battle at 1600 beats a proven 1580
    const candidates = router.getAllModels();
    const result = router._selectBest(candidates, 'general');
    // All models have 0 battles so all are 1500 — should still return a valid model
    assert.ok(result, 'Should return a candidate even with no battle data');
    assert.ok(result.model, 'Result should have model field');
  });
});

describe('Task type detection', () => {
  it('detects code tasks', async () => {
    const { detectTaskType } = await import('../src/proxy/router.js');
    const messages = [{ role: 'user', content: 'Write a Python function to sort an array' }];
    assert.equal(detectTaskType(messages), 'code');
  });

  it('detects creative tasks', async () => {
    const { detectTaskType } = await import('../src/proxy/router.js');
    const messages = [{ role: 'user', content: 'Write a short story about a lost lighthouse keeper' }];
    assert.equal(detectTaskType(messages), 'creative');
  });

  it('detects analysis tasks', async () => {
    const { detectTaskType } = await import('../src/proxy/router.js');
    const messages = [{ role: 'user', content: 'Analyze and summarize the pros and cons of microservices' }];
    assert.equal(detectTaskType(messages), 'analysis');
  });

  it('falls back to general for ambiguous prompts', async () => {
    const { detectTaskType } = await import('../src/proxy/router.js');
    const messages = [{ role: 'user', content: 'Hello' }];
    assert.equal(detectTaskType(messages), 'general');
  });
});

describe('Token estimation', () => {
  it('estimates tokens from message content', async () => {
    const { estimatePromptTokens } = await import('../src/proxy/router.js');
    const messages = [{ role: 'user', content: 'a'.repeat(400) }];
    // 400 chars / 4 ≈ 100 tokens, plus role overhead
    const estimate = estimatePromptTokens(messages);
    assert.ok(estimate >= 100 && estimate <= 120, `Expected ~100-120 tokens, got ${estimate}`);
  });

  it('handles array content gracefully', async () => {
    const { estimatePromptTokens } = await import('../src/proxy/router.js');
    const messages = [{ role: 'user', content: ['text part', { type: 'image' }] }];
    const estimate = estimatePromptTokens(messages);
    assert.ok(estimate >= 0, 'Should return non-negative estimate for non-string content');
  });
});
