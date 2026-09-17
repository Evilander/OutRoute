import { BaseProvider, ProviderError } from './base.js';
import { detectTaskType, estimatePromptTokens } from '../../tasks.js';

// An offline provider with four made-up models of differing quality, speed and
// price. It lets Prism run end to end with no API keys (demo mode) and gives the
// test suite real provider behaviour without a network. Prices are play money.
// `points` is how much a model has to say; `edge` shifts that by task type, so the
// four are not simply ranked: careful leads on code and analysis, balanced and
// rambling do better at creative work, and quick holds its own on small talk.
const MODELS = [
  { id: 'mock-careful', name: 'Mock Careful', points: 5, edge: { code: 1, analysis: 1, creative: -1 }, latencyMs: 900, costPer1kInput: 0.01, costPer1kOutput: 0.03 },
  { id: 'mock-balanced', name: 'Mock Balanced', points: 5, edge: { creative: 1 }, latencyMs: 400, costPer1kInput: 0.002, costPer1kOutput: 0.008 },
  { id: 'mock-rambling', name: 'Mock Rambling', points: 4, edge: { creative: 1 }, latencyMs: 700, costPer1kInput: 0.001, costPer1kOutput: 0.004 },
  { id: 'mock-quick', name: 'Mock Quick', points: 3, edge: { general: 1 }, latencyMs: 120, costPer1kInput: 0.0002, costPer1kOutput: 0.0008 },
].map(m => ({ ...m, contextWindow: 32768 }));

const POINTS = {
  code: [
    'Start from the failing case and write it down as a test.',
    'Keep the function pure; pass the clock and the random source in.',
    'Handle the empty input and the single-element input explicitly.',
    'Prefer a Map over repeated array scans once the list grows.',
    'Name the invariant the loop maintains, then check it at the boundary.',
    'Return early on invalid input instead of nesting the happy path.',
    'Measure before optimising; the slow part is rarely where you expect.',
  ],
  analysis: [
    'Separate what the data shows from what it is being asked to prove.',
    'The comparison only holds if both groups were measured the same way.',
    'State the base rate before reading anything into the difference.',
    'The cheaper option wins unless the failure cost is asymmetric.',
    'Check whether the trend survives dropping the largest outlier.',
    'Name the assumption that, if wrong, reverses the conclusion.',
    'A smaller claim you can defend beats a larger one you cannot.',
  ],
  creative: [
    'Open on a concrete image rather than a statement of theme.',
    'Let the second line turn against the first.',
    'Give the character one want and one thing in the way.',
    'Cut the adjective and find the noun that did not need it.',
    'End a beat earlier than feels safe.',
    'Read it aloud; the rhythm will tell you where it drags.',
    'Keep one detail only this speaker would notice.',
  ],
  general: [
    'The short answer first, then the reasoning behind it.',
    'There are two common cases and they call for different advice.',
    'The usual recommendation assumes conditions that may not apply here.',
    'A quick check will tell you which situation you are in.',
    'If that fails, the fallback costs little and rules out the rest.',
    'Most of the benefit comes from the first step alone.',
    'Revisit the decision once you have a week of real use behind it.',
  ],
};

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const unit = text => hash(text) / 4294967296;

function lastUserText(messages) {
  const turn = [...messages].reverse().find(m => m.role === 'user') || messages[messages.length - 1];
  if (typeof turn?.content === 'string') return turn.content;
  if (Array.isArray(turn?.content)) return turn.content.map(p => p?.text || '').join(' ');
  return '';
}

// A better model makes more distinct points; which ones depends on the prompt,
// and a prompt-dependent wobble lets a weaker model win now and then.
function compose(model, messages) {
  const prompt = lastUserText(messages);
  const taskType = detectTaskType(messages);
  const pool = POINTS[taskType];
  const wobble = Math.round((unit(`${model.id}|${prompt}`) - 0.5) * 3);
  const count = Math.max(1, Math.min(pool.length, model.points + (model.edge[taskType] || 0) + wobble));
  const offset = hash(prompt) % pool.length;
  const lines = Array.from({ length: count }, (_, i) => `- ${pool[(offset + i) % pool.length]}`);

  const subject = prompt.replace(/\s+/g, ' ').trim().slice(0, 80) || 'your question';
  const body = [`On "${subject}":`, '', ...lines];
  if (model.id === 'mock-rambling') {
    body.push('', 'To restate the above at greater length: ' + lines.map(l => l.slice(2)).join(' Furthermore, ').repeat(2));
  }
  return body.join('\n');
}

// The stand-in judge scores a response by how many distinct points it makes and
// marks down padding. When the two are close it leans toward whichever came
// first, which is the position bias real judges show and the swap exists to catch.
function scoreResponse(text) {
  const points = new Set(text.split('\n').filter(line => line.startsWith('- '))).size;
  return points - Math.max(0, text.length - 900) / 600;
}

function judge(messages) {
  const text = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const a = text.match(/<model_a_response>([\s\S]*?)<\/model_a_response>/)?.[1] ?? '';
  const b = text.match(/<model_b_response>([\s\S]*?)<\/model_b_response>/)?.[1] ?? '';
  const prompt = text.match(/<user_prompt>([\s\S]*?)<\/user_prompt>/)?.[1] ?? '';
  const margin = scoreResponse(a) - scoreResponse(b);
  const winner = margin > 0.5 ? 'model_a' : margin < -0.5 ? 'model_b' : margin >= 0 ? 'model_a' : 'tie';
  return JSON.stringify({
    domain: detectTaskType([{ role: 'user', content: prompt }]),
    reasoning: `Response A makes ${scoreResponse(a).toFixed(1)} points' worth of argument, response B ${scoreResponse(b).toFixed(1)}.`,
    winner,
  });
}

const isJudgeRequest = messages => messages.some(m => typeof m.content === 'string' && m.content.includes('<model_a_response>'));

export class MockProvider extends BaseProvider {
  #enabled;
  #latencyScale;
  #failing;

  // config.mock: { enabled, latencyScale (0 disables delays), fail: [model ids that error] }
  constructor(config = {}) {
    super(config);
    const options = config.mock || {};
    this.#enabled = options.enabled ?? process.env.PRISM_DEMO === '1';
    this.#latencyScale = options.latencyScale ?? 1;
    this.#failing = new Set(options.fail || []);
  }

  get name() {
    return 'mock';
  }

  get available() {
    return this.#enabled;
  }

  // Not "local" in the pricing sense: the mock models carry play-money prices so
  // the cost strategies and the frontier chart have something to work with.
  get local() {
    return false;
  }

  get models() {
    return MODELS;
  }

  async discoverModels() {}

  #wait(ms) {
    const scaled = ms * this.#latencyScale;
    return scaled > 0 ? new Promise(resolve => setTimeout(resolve, scaled)) : Promise.resolve();
  }

  async chat(messages, options = {}) {
    const model = this.getModel(options.model) || MODELS[1];
    if (this.#failing.has(model.id)) {
      throw new ProviderError('Mock failure', { provider: this.name, model: model.id, status: 503, retryable: true });
    }

    const startTime = Date.now();
    const content = isJudgeRequest(messages) ? judge(messages) : compose(model, messages);
    const usage = { inputTokens: estimatePromptTokens(messages), outputTokens: Math.ceil(content.length / 4) };

    if (options.stream) return this.#stream(model, content, usage, startTime);

    await this.#wait(model.latencyMs);
    return { content, model: model.id, ...usage, latencyMs: Date.now() - startTime, finishReason: 'stop' };
  }

  async *#stream(model, content, usage, startTime) {
    const words = content.split(/(\s+)/).filter(Boolean);
    const pause = model.latencyMs / Math.max(1, words.length);
    for (const word of words) {
      await this.#wait(pause);
      yield { type: 'delta', content: word };
    }
    yield { type: 'done', model: model.id, ...usage, latencyMs: Date.now() - startTime, finishReason: 'stop' };
  }

  async healthCheck() {
    return { healthy: true, latencyMs: 0, provider: this.name };
  }
}
