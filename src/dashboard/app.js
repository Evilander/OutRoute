const API = '';
let currentBattleId = null;
let selectedModels = new Set();
let allModels = [];

// --- Tab Navigation ---

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Data Fetching ---

async function fetchJSON(url, options = {}) {
  try {
    const res = await fetch(API + url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Fetch failed: ${url}`, err);
    return null;
  }
}

// --- Safe DOM helpers ---
// All user-generated content goes through textContent or createTextNode.
// Only static, developer-controlled markup uses innerHTML.

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function text(str) { return document.createTextNode(str || ''); }

function clearAndAppend(container, nodes) {
  container.textContent = '';
  if (Array.isArray(nodes)) nodes.forEach(n => container.appendChild(n));
  else container.appendChild(nodes);
}

function modelBadge(model, provider) {
  return el('span', { className: `model-badge ${provider || guessProvider(model)}` }, [truncModel(model)]);
}

// --- Dashboard ---

async function refreshDashboard() {
  const [statsRes, providers, battles, requestsRes] = await Promise.all([
    fetchJSON('/api/stats'),
    fetchJSON('/api/providers'),
    fetchJSON('/arena/battles'),
    fetchJSON('/api/requests'),
  ]);

  // Server returns { hours, totals, by_model: [] }
  const stats = statsRes?.by_model || statsRes || [];
  if (stats) renderStats(Array.isArray(stats) ? stats : []);
  if (providers) renderProviders(providers);
  if (battles) renderRecentBattles(battles.battles || []);
  // Server returns { requests: [] }
  const requests = requestsRes?.requests || requestsRes || [];
  if (requests) renderRequests(Array.isArray(requests) ? requests : []);
  await refreshLeaderboard();
}

function renderStats(stats) {
  const totals = stats.reduce((acc, s) => {
    acc.requests += s.total_requests || 0;
    acc.cost += s.total_cost || 0;
    acc.latency += (s.avg_latency || 0) * (s.total_requests || 0);
    return acc;
  }, { requests: 0, cost: 0, latency: 0 });

  const avgLatency = totals.requests > 0 ? Math.round(totals.latency / totals.requests) : 0;

  document.getElementById('stat-requests').textContent = totals.requests.toLocaleString();
  document.getElementById('stat-cost').textContent = `$${totals.cost.toFixed(4)}`;
  document.getElementById('stat-latency').textContent = `${avgLatency}ms`;

  // Cost breakdown
  const costEl = document.getElementById('cost-breakdown');
  if (stats.length === 0) {
    clearAndAppend(costEl, el('div', { className: 'empty-state' }, [el('p', {}, ['No data yet'])]));
    return;
  }

  const byProvider = {};
  stats.forEach(s => {
    if (!byProvider[s.provider]) byProvider[s.provider] = 0;
    byProvider[s.provider] += s.total_cost || 0;
  });

  const maxCost = Math.max(...Object.values(byProvider));
  const rows = Object.entries(byProvider)
    .sort((a, b) => b[1] - a[1])
    .map(([provider, cost]) =>
      el('div', { className: 'leaderboard-row' }, [
        el('span', { className: `model-badge ${provider}` }, [provider]),
        el('div', { className: 'elo-bar' }, [
          el('div', { className: 'elo-fill', style: { width: `${(cost / maxCost) * 100}%` } })
        ]),
        el('span', { className: `elo-value ${costClass(cost)}` }, [`$${cost.toFixed(4)}`]),
      ])
    );
  clearAndAppend(costEl, el('div', {}, rows));

  // Model usage
  const usageEl = document.getElementById('model-usage');
  const maxReqs = Math.max(...stats.map(s => s.total_requests || 0));
  const usageRows = stats
    .sort((a, b) => (b.total_requests || 0) - (a.total_requests || 0))
    .map(s =>
      el('div', { className: 'leaderboard-row' }, [
        modelBadge(s.model, s.provider),
        el('div', { className: 'elo-bar' }, [
          el('div', { className: 'elo-fill', style: { width: `${((s.total_requests || 0) / maxReqs) * 100}%` } })
        ]),
        el('span', { className: 'elo-value' }, [String(s.total_requests || 0)]),
      ])
    );
  clearAndAppend(usageEl, el('div', {}, usageRows));
}

function renderProviders(providers) {
  const grid = document.getElementById('providers-grid');
  const count = document.getElementById('provider-count');

  if (!providers.providers || providers.providers.length === 0) {
    clearAndAppend(grid, el('div', { className: 'card empty-state' }, [
      el('h3', {}, ['No providers configured']),
      el('p', {}, ['Add API keys to .env to enable providers']),
    ]));
    count.textContent = '0 providers';
    return;
  }

  count.textContent = `${providers.providers.length} providers`;
  allModels = [];

  const cards = providers.providers.map(p => {
    p.models.forEach(m => allModels.push({ ...m, provider: p.name }));
    const statusClass = p.health?.status || 'unknown';
    const latency = p.health?.avg_latency_ms ? `${Math.round(p.health.avg_latency_ms)}ms` : '\u2014';

    return el('div', { className: 'card provider-card animate-in' }, [
      el('div', { className: `provider-status ${statusClass}` }),
      el('div', { className: 'provider-info' }, [
        el('div', { className: 'provider-name' }, [p.name]),
        el('div', { className: 'provider-meta' }, [`${p.models.length} models \u00B7 ${latency} avg latency`]),
        el('div', { className: 'provider-models' }, [p.models.map(m => truncModel(m.id)).join(', ')]),
      ]),
    ]);
  });

  clearAndAppend(grid, el('div', { className: 'providers-grid', style: { display: 'contents' } }, cards));
  // Since the grid is the parent with CSS grid, we need to append directly
  grid.textContent = '';
  cards.forEach(c => grid.appendChild(c));

  renderModelSelector();
}

// --- Arena ---

function renderModelSelector() {
  const selector = document.getElementById('model-selector');
  if (allModels.length === 0) {
    clearAndAppend(selector, el('span', { className: 'stat-label' }, ['No models available']));
    return;
  }

  const buttons = allModels.map(m => {
    const isSelected = selectedModels.has(m.id);
    const btn = el('button', {
      className: `model-toggle ${isSelected ? 'selected' : ''}`,
      'data-model': m.id,
    }, [truncModel(m.id)]);
    btn.addEventListener('click', () => toggleModel(m.id));
    return btn;
  });
  clearAndAppend(selector, el('div', { style: { display: 'contents' } }, buttons));
  selector.textContent = '';
  buttons.forEach(b => selector.appendChild(b));
}

function toggleModel(modelId) {
  if (selectedModels.has(modelId)) {
    selectedModels.delete(modelId);
  } else {
    selectedModels.add(modelId);
  }
  renderModelSelector();
}

async function startBattle() {
  const prompt = document.getElementById('arena-prompt').value.trim();
  if (!prompt) return;

  const models = selectedModels.size >= 2
    ? Array.from(selectedModels)
    : allModels.slice(0, Math.min(3, allModels.length)).map(m => m.id);

  if (models.length < 2) {
    document.getElementById('battle-status').textContent = 'Select at least 2 models';
    return;
  }

  const btn = document.getElementById('btn-battle');
  const status = document.getElementById('battle-status');
  btn.disabled = true;
  clearAndAppend(status, el('span', {}, [el('span', { className: 'spinner' }), text(' Running battle...')]));

  const result = await fetchJSON('/arena/battle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, models })
  });

  btn.disabled = false;

  if (!result || result.error) {
    status.textContent = result?.error || 'Battle failed';
    return;
  }

  status.textContent = '';
  currentBattleId = result.battleId;
  renderBattleResults(result);
};

function renderBattleResults(result) {
  const container = document.getElementById('battle-results');
  const responses = document.getElementById('battle-responses');
  container.style.display = 'block';
  document.getElementById('btn-reveal').style.display = 'inline-block';

  // Keyboard voting: press 1/2/3/... to vote for that position
  const keyHandler = (e) => {
    const n = parseInt(e.key);
    if (n >= 1 && n <= result.entries.length) {
      document.removeEventListener('keydown', keyHandler);
      voteBattle(result.battleId, n);
    }
  };
  document.addEventListener('keydown', keyHandler);
  window._activeKeyHandler = keyHandler;

  const cards = result.entries.map((entry, i) => {
    const card = el('div', {
      className: 'battle-response animate-in',
      id: `response-${entry.id}`,
      style: { animationDelay: `${i * 0.1}s` },
    }, [
      el('div', { className: 'response-header' }, [
        el('span', { className: 'response-label' }, [`Response ${entry.position}`]),
        el('span', { className: 'response-meta' }, [`${entry.latencyMs}ms \u00B7 $${(entry.costUsd || 0).toFixed(4)}`]),
      ]),
      el('div', { className: 'response-body' }, [entry.response || 'No response']),
      el('div', { style: { marginTop: '16px', textAlign: 'center' } }, [
        (() => {
          const voteBtn = el('button', { className: 'btn-vote' }, ['Vote Winner']);
          voteBtn.addEventListener('click', () => voteBattle(result.battleId, entry.position));
          return voteBtn;
        })()
      ]),
    ]);
    return card;
  });

  clearAndAppend(responses, el('div', { style: { display: 'contents' } }, cards));
  responses.textContent = '';
  cards.forEach(c => responses.appendChild(c));

  container.scrollIntoView({ behavior: 'smooth' });
}

async function voteBattle(battleId, position) {
  // Remove keyboard handler once vote is cast
  if (window._activeKeyHandler) {
    document.removeEventListener('keydown', window._activeKeyHandler);
    window._activeKeyHandler = null;
  }

  const result = await fetchJSON('/arena/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ battleId, winnerPosition: position })
  });

  if (!result) return;

  document.querySelectorAll('.btn-vote').forEach(btn => btn.disabled = true);
  document.querySelectorAll('.battle-response').forEach(el => {
    const label = el.querySelector('.response-label');
    const pos = parseInt(label.textContent.split(' ')[1]);
    if (pos === position) {
      el.style.borderColor = 'var(--accent-green)';
      const voteBtn = el.querySelector('.btn-vote');
      voteBtn.classList.add('winner');
      voteBtn.textContent = 'Winner!';
    }
  });

  // Auto-reveal after voting
  setTimeout(() => revealBattle(), 500);
  refreshDashboard();
}

async function revealBattle() {
  if (!currentBattleId) return;
  const result = await fetchJSON(`/arena/reveal/${currentBattleId}`);
  if (!result || !result.entries) return;

  const responseCards = document.querySelectorAll('#battle-responses .battle-response');
  result.entries.forEach(entry => {
    const card = responseCards[entry.position - 1];
    if (card) {
      card.classList.add('revealed');
      const label = card.querySelector('.response-label');
      label.textContent = '';
      label.appendChild(modelBadge(entry.model, entry.provider));
    }
  });

  document.getElementById('btn-reveal').style.display = 'none';
  document.getElementById('btn-copy-result').style.display = 'inline-block';
  document.getElementById('keyboard-hint').style.display = 'none';

  if (result.judgeReasoning) {
    const existing = document.getElementById('judge-panel');
    if (existing) existing.remove();

    const panel = el('div', { id: 'judge-panel', className: 'card', style: { marginTop: '16px' } }, [
      el('div', { className: 'card-title', style: { marginBottom: '8px' } }, [
        'Auto-Judge Analysis',
        result.judgeModel
          ? el('span', { className: 'stat-label', style: { marginLeft: '8px', fontWeight: 'normal' } }, [`via ${result.judgeModel}`])
          : null,
        result.inferredDomain
          ? el('span', { className: 'model-badge', style: { marginLeft: '8px' } }, [result.inferredDomain])
          : null,
      ]),
      el('div', { style: { color: 'var(--text-secondary)', lineHeight: '1.6', whiteSpace: 'pre-wrap', fontSize: '14px' } }, [result.judgeReasoning]),
    ]);

    document.getElementById('battle-results').appendChild(panel);
  }
};

function copyBattleResult() {
  const responseCards = document.querySelectorAll('#battle-responses .battle-response');
  const lines = [`## Battle #${currentBattleId}\n`];
  responseCards.forEach((card, i) => {
    const label = card.querySelector('.response-label');
    const body = card.querySelector('.response-body');
    const meta = card.querySelector('.response-meta');
    lines.push(`### ${label.textContent || `Response ${i + 1}`} ${meta ? `(${meta.textContent})` : ''}`);
    lines.push(body ? body.textContent : '');
    lines.push('');
  });
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const btn = document.getElementById('btn-copy-result');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
};

function renderRecentBattles(battles) {
  const container = document.getElementById('recent-battles');
  const stat = document.getElementById('stat-battles');
  stat.textContent = battles.length.toString();

  if (battles.length === 0) {
    clearAndAppend(container, el('div', { className: 'empty-state' }, [
      el('h3', {}, ['No battles yet']),
      el('p', {}, ['Start a battle above to see results here']),
    ]));
    return;
  }

  const rows = battles.slice(0, 10).map(b => {
    const winner = b.entries?.find(e => e.is_winner);
    const modelsDiv = el('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } });
    if (b.entries) {
      b.entries.forEach((e, i) => {
        if (i > 0) modelsDiv.appendChild(text(' vs '));
        modelsDiv.appendChild(modelBadge(e.model, e.provider));
      });
    }

    const promptText = (b.prompt || '').substring(0, 80) + ((b.prompt || '').length > 80 ? '...' : '');

    return el('div', { className: 'leaderboard-row' }, [
      el('div', { style: { flex: '1' } }, [
        el('div', { style: { fontSize: '14px', marginBottom: '4px' } }, [promptText]),
        modelsDiv,
      ]),
      el('div', { style: { textAlign: 'right' } }, [
        winner
          ? (() => { const b = modelBadge(winner.model, winner.provider); return el('span', {}, [b, text(' won')]); })()
          : el('span', { className: 'stat-label' }, [b.status || 'pending']),
      ]),
    ]);
  });

  clearAndAppend(container, el('div', {}, rows));
}

// --- Leaderboard ---

async function refreshLeaderboard() {
  const result = await fetchJSON('/arena/leaderboard');
  const container = document.getElementById('leaderboard-content');

  if (!result || !result.leaderboard || result.leaderboard.length === 0) {
    clearAndAppend(container, el('div', { className: 'empty-state' }, [
      el('h3', {}, ['No ratings yet']),
      el('p', {}, ['Run arena battles and vote to build your personal leaderboard']),
    ]));
    return;
  }

  const maxRating = Math.max(...result.leaderboard.map(m => m.rating));
  const minRating = Math.min(...result.leaderboard.map(m => m.rating));
  const range = maxRating - minRating || 1;

  const rows = result.leaderboard.map((m, i) => {
    const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const barWidth = ((m.rating - minRating + 100) / (range + 200)) * 100;
    const winRate = m.battles > 0 ? ((m.wins / m.battles) * 100).toFixed(0) : '0';

    return el('div', { className: 'leaderboard-row animate-in', style: { animationDelay: `${i * 0.05}s` } }, [
      el('span', { className: `leaderboard-rank ${rankClass}` }, [String(i + 1)]),
      modelBadge(m.model),
      el('div', { className: 'elo-bar' }, [
        el('div', { className: 'elo-fill', style: { width: `${barWidth}%` } })
      ]),
      el('span', { className: 'elo-value' }, [String(Math.round(m.rating))]),
      el('span', { className: 'win-rate' }, [`${winRate}% WR (${m.battles})`]),
    ]);
  });

  clearAndAppend(container, el('div', {}, rows));
}

// --- Requests Log ---

function renderRequests(requests) {
  const tbody = document.getElementById('requests-table');

  if (!requests || requests.length === 0) {
    clearAndAppend(tbody, el('tr', {}, [el('td', { colspan: '8', className: 'empty-state' }, ['No requests yet'])]));
    return;
  }

  const rows = requests.slice(0, 100).map(r => {
    const time = new Date(r.timestamp).toLocaleTimeString();
    return el('tr', {}, [
      el('td', {}, [time]),
      el('td', {}, [modelBadge(r.provider, r.provider)]),
      el('td', { style: { fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' } }, [truncModel(r.model)]),
      el('td', { title: r.routing_reason || '', style: { cursor: r.routing_reason ? 'help' : 'default' } }, [r.strategy || '']),
      el('td', {}, [(r.total_tokens || 0).toLocaleString()]),
      el('td', {}, [`${r.latency_ms || 0}ms`]),
      el('td', { className: costClass(r.cost_usd) }, [`$${(r.cost_usd || 0).toFixed(4)}`]),
      el('td', {}, [
        r.status === 'ok'
          ? el('span', { style: { color: 'var(--accent-green)' } }, ['OK'])
          : el('span', { style: { color: 'var(--accent-red)' } }, ['ERR'])
      ]),
    ]);
  });

  tbody.textContent = '';
  rows.forEach(r => tbody.appendChild(r));
}

// --- Utilities ---

function truncModel(model) {
  if (!model) return '\u2014';
  return model
    .replace('claude-opus-4-6', 'claude-opus-4.6')
    .replace('claude-sonnet-4-6', 'claude-sonnet-4.6')
    .replace('claude-opus-4-20250901', 'claude-opus-4')
    .replace('claude-sonnet-4-20250514', 'claude-sonnet-4')
    .replace('claude-haiku-4-5-20251001', 'claude-haiku-4.5')
    .replace('claude-3-5-haiku-20241022', 'claude-3.5-haiku')
    .replace('gemini-2.5-flash', 'gemini-2.5-flash')
    .replace('gemini-2.5-pro', 'gemini-2.5-pro')
    .replace('gemini-2.0-flash', 'gemini-2-flash')
    .replace('llama-3.3-70b-versatile', 'llama-3.3-70b')
    .replace('llama-3.1-8b-instant', 'llama-3.1-8b')
    .replace('mixtral-8x7b-32768', 'mixtral-8x7b');
}

function guessProvider(model) {
  if (!model) return '';
  if (model.startsWith('gpt') || model.startsWith('o1')) return 'openai';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('llama') || model.startsWith('mixtral')) return 'groq';
  return '';
}

function costClass(cost) {
  if (!cost || cost < 0.01) return 'cost-low';
  if (cost < 0.1) return 'cost-med';
  return 'cost-high';
}

// --- Init ---

document.getElementById('btn-battle').addEventListener('click', startBattle);
document.getElementById('btn-reveal').addEventListener('click', revealBattle);
document.getElementById('btn-copy-result').addEventListener('click', copyBattleResult);

refreshDashboard();
setInterval(refreshDashboard, 15000);
