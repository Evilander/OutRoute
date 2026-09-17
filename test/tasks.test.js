import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectTaskType, normalizeTaskType, estimatePromptTokens, TASK_TYPES } from '../src/tasks.js';

const ask = content => [{ role: 'user', content }];

describe('detectTaskType', () => {
  it('detects code from keywords, fences and file names', () => {
    assert.equal(detectTaskType(ask('Write a Python merge sort')), 'code');
    assert.equal(detectTaskType(ask('why does this fail?\n```\nconst x = y.map(\n```')), 'code');
    assert.equal(detectTaskType(ask('index.js throws a TypeError on startup')), 'code');
  });

  it('detects creative writing', () => {
    assert.equal(detectTaskType(ask('Write a short story about a lighthouse keeper')), 'creative');
    assert.equal(detectTaskType(ask('Give me a haiku about rain')), 'creative');
  });

  it('detects analysis', () => {
    assert.equal(detectTaskType(ask('Compare the pros and cons of leasing versus buying')), 'analysis');
  });

  it('does not match keywords inside other words', () => {
    assert.equal(detectTaskType(ask('What is the capital of France?')), 'general');
    assert.equal(detectTaskType(ask('What is the latest news on the classic car show?')), 'general');
  });

  it('falls back to general for small talk and empty input', () => {
    assert.equal(detectTaskType(ask('hello there')), 'general');
    assert.equal(detectTaskType([]), 'general');
    assert.equal(detectTaskType(undefined), 'general');
  });

  it('weights the latest user turn over earlier ones', () => {
    const conversation = [
      { role: 'user', content: 'fix the bug in this function' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks. now write a poem for my sister\'s wedding toast, a sonnet if you can' },
    ];
    assert.equal(detectTaskType(conversation), 'creative');
  });

  it('ignores assistant and system text when a user turn exists', () => {
    const conversation = [
      { role: 'system', content: 'You are a coding assistant. Write code, debug functions.' },
      { role: 'user', content: 'hi' },
    ];
    assert.equal(detectTaskType(conversation), 'general');
  });

  it('reads text parts of multimodal content', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'refactor this function' }, { type: 'image_url', image_url: {} }] }];
    assert.equal(detectTaskType(messages), 'code');
  });
});

describe('normalizeTaskType', () => {
  it('maps judge and legacy names onto the shared taxonomy', () => {
    assert.equal(normalizeTaskType('coding'), 'code');
    assert.equal(normalizeTaskType('Analytical'), 'analysis');
    assert.equal(normalizeTaskType('factual'), 'general');
    assert.equal(normalizeTaskType('creative'), 'creative');
  });

  it('never returns a name outside the taxonomy', () => {
    for (const value of [null, undefined, '', 'nonsense', 42, {}]) {
      assert.ok(TASK_TYPES.includes(normalizeTaskType(value)));
    }
  });
});

describe('estimatePromptTokens', () => {
  it('estimates from string and array content', () => {
    assert.ok(estimatePromptTokens(ask('a'.repeat(400))) >= 100);
    assert.ok(estimatePromptTokens([{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }] }]) >= 100);
    assert.equal(estimatePromptTokens([]), 0);
  });
});
