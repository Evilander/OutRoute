// The one task taxonomy. The router, the arena, the judge and the ratings all
// key on these names, so a rating earned in the arena is the rating the router reads.
export const TASK_TYPES = ['code', 'analysis', 'creative', 'general'];

const ALIASES = {
  coding: 'code',
  programming: 'code',
  analytical: 'analysis',
  reasoning: 'analysis',
  math: 'analysis',
  writing: 'creative',
  factual: 'general',
  chat: 'general',
};

export function normalizeTaskType(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (TASK_TYPES.includes(key)) return key;
  return ALIASES[key] || 'general';
}

// Each signal is [pattern, weight]. Patterns match whole words: a substring
// test would find "api" in "capital" and "java" in every mention of JavaScript.
const SIGNALS = {
  code: [
    [/```/, 4],
    [/\b(?:function|const|let|var|def|class|import|return|async|await)\b\s*[\w({[]/, 3],
    [/\b(?:traceback|stack ?trace|exception|segfault|null ?pointer|undefined is not|syntax ?error|type ?error)\b/, 3],
    [/\b\w+\.(?:js|ts|tsx|jsx|py|rs|go|java|rb|php|cs|cpp|c|h|sql|sh|yml|yaml|json|toml)\b/, 2],
    [/\b(?:select|insert|update|delete)\b[\s\S]{0,80}\b(?:from|into|set|where)\b/, 2],
    [/\b(?:code|coding|function|method|class|implement|debug|refactor|bug|compile|compiler|algorithm|endpoint|api|sdk|database|sql|regex|script|unit tests?|lint|typescript|javascript|python|rust|golang|java|kotlin|swift|html|css|react|vue|node\.?js|django|flask|docker|kubernetes|git|bash|powershell|json|yaml|xml)\b/, 1],
  ],
  creative: [
    [/\b(?:write|compose|draft)\b[\s\S]{0,40}\b(?:story|poem|song|lyrics?|essay|speech|toast|script|screenplay|scene|dialogue|limerick|haiku|sonnet|tagline|slogan|headline|blog post|newsletter|ad copy)\b/, 4],
    [/\b(?:story|poem|poetry|fiction|narrative|character|plot|dialogue|metaphor|imagery|lyrics?|screenplay|limerick|haiku|sonnet|slogan|tagline|headline|copywriting|worldbuilding|protagonist)\b/, 1],
    [/\b(?:in the (?:style|voice|tone) of|rewrite (?:this|it) (?:to|so|as)|make (?:this|it) (?:sound|funnier|punchier|warmer))\b/, 2],
  ],
  analysis: [
    [/\b(?:compare|contrast|evaluate|assess|analy[sz]e|critique|summari[sz]e|interpret|investigate)\b/, 2],
    [/\b(?:pros and cons|trade-?offs?|root cause|step by step|prove|proof|derive|calculate|estimate|forecast|probability|statistics?|hypothesis|correlation)\b/, 2],
    [/\b(?:analysis|summary|explain|breakdown|research|data|trend|pattern|insight|report|findings|conclusion|benchmark|metric|strategy|implications?)\b/, 1],
  ],
};

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ');
  }
  return '';
}

// Classifies a conversation by what the user is asking for. The latest user turn
// counts double: a chat that started with code and moved on to a toast is a toast.
export function detectTaskType(messages) {
  const userTurns = (messages || []).filter(m => m?.role === 'user');
  const turns = userTurns.length > 0 ? userTurns : (messages || []);
  const scores = { code: 0, creative: 0, analysis: 0 };

  turns.forEach((message, index) => {
    const text = textOf(message).toLowerCase();
    const turnWeight = index === turns.length - 1 ? 2 : 1;
    for (const [type, signals] of Object.entries(SIGNALS)) {
      for (const [pattern, weight] of signals) {
        if (pattern.test(text)) scores[type] += weight * turnWeight;
      }
    }
  });

  const [best, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return score >= 2 ? best : 'general';
}

export function estimatePromptTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    chars += textOf(m).length;
    chars += (m?.role || '').length + 4;
  }
  return Math.ceil(chars / 4);
}
