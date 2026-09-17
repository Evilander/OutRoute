// Prism dashboard. No framework, no build step, no innerHTML: every string that
// reaches the page (prompts, model output, model names) goes in as text.

(() => {
  const { forest, frontier, bars, empty } = PrismCharts;

  const $ = id => document.getElementById(id);
  const REFRESH_MS = 15000;
  const MAX_MODELS = 4;

  const state = {
    config: null,
    tab: 'compare',
    battle: null,
    timer: null,
  };

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
    return node;
  }

  const token = {
    get() {
      try { return sessionStorage.getItem('prism-token') || ''; } catch { return ''; }
    },
    set(value) {
      try { sessionStorage.setItem('prism-token', value); } catch { /* kept in memory only */ }
      this.memory = value;
    },
    memory: '',
  };

  function authHeaders() {
    const value = token.get() || token.memory;
    return value ? { Authorization: `Bearer ${value}` } : {};
  }

  async function request(path, { method = 'GET', body, signal } = {}) {
    const response = await fetch(path, {
      method,
      signal,
      headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) {
      await askForToken('That token was not accepted.');
      return request(path, { method, body, signal });
    }
    return response;
  }

  async function api(path, options) {
    const response = await request(path, options);
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON error body */ }
    if (!response.ok) {
      const message = data?.error?.message || data?.error || `Request failed (${response.status})`;
      throw new Error(typeof message === 'string' ? message : `Request failed (${response.status})`);
    }
    return data;
  }

  // Reads a server-sent-event stream with fetch, because EventSource cannot send
  // an Authorization header.
  async function readEvents(path, onEvent, signal) {
    const response = await request(path, { signal });
    if (!response.ok || !response.body) throw new Error(`Stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try { onEvent(JSON.parse(payload)); } catch { /* keep-alive or malformed frame */ }
      }
    }
  }

  function askForToken(message = '') {
    return new Promise(resolve => {
      const dialog = $('auth-dialog');
      $('auth-error').textContent = message;
      $('auth-token').value = '';
      const onSubmit = () => {
        token.set($('auth-token').value.trim());
        $('auth-form').removeEventListener('submit', onSubmit);
        resolve();
      };
      $('auth-form').addEventListener('submit', onSubmit);
      if (!dialog.open) dialog.showModal();
    });
  }

  const fmt = {
    usd(value) {
      if (value === null || value === undefined) return 'unknown';
      if (value === 0) return '$0';
      // Single requests cost fractions of a cent; two decimals would round them all to the same thing.
      return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
    },
    perMillion(per1k) {
      if (per1k === null || per1k === undefined) return 'unknown';
      if (per1k === 0) return 'free';
      const value = per1k * 1000;
      return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
    },
    ms(value) {
      if (!value) return '0 ms';
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
    },
    count: value => Number(value || 0).toLocaleString('en-US'),
    plural: (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`,
    percent: value => `${Math.round(value * 100)}%`,
    time(value) {
      if (!value) return '';
      const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
      if (Number.isNaN(date.getTime())) return value;
      const sameDay = date.toDateString() === new Date().toDateString();
      return sameDay
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
    list(items) {
      if (items.length <= 1) return items.join('');
      return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
    },
  };

  function setBanner(message, isError = false) {
    const banner = $('banner');
    banner.hidden = !message;
    banner.textContent = message || '';
    banner.classList.toggle('is-error', isError);
  }

  function fillRows(tableId, rows, emptyText, columns) {
    const body = $(tableId).querySelector('tbody');
    if (!rows.length) {
      body.replaceChildren(h('tr', { class: 'empty-row' }, h('td', { colspan: columns, text: emptyText })));
      return;
    }
    body.replaceChildren(...rows);
  }

  // A sentence with some words emphasised: parts are strings or [string] for <strong>.
  function sentence(node, parts) {
    node.replaceChildren(...parts.map(part => (Array.isArray(part) ? h('strong', { text: part[0] }) : document.createTextNode(part))));
  }

  const TABS = ['compare', 'ratings', 'frontier', 'judge', 'traffic'];

  function showTab(name, { focus = false } = {}) {
    if (!TABS.includes(name)) name = 'compare';
    state.tab = name;
    for (const tab of TABS) {
      const button = $(`tabbtn-${tab}`);
      const selected = tab === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      $(`tab-${tab}`).hidden = !selected;
      if (selected && focus) button.focus();
    }
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
    refresh();
  }

  function initTabs() {
    for (const tab of TABS) {
      $(`tabbtn-${tab}`).addEventListener('click', () => showTab(tab));
    }
    document.querySelector('[role="tablist"]').addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      showTab(TABS[(TABS.indexOf(state.tab) + step + TABS.length) % TABS.length], { focus: true });
    });
    window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  }

  function initTheme() {
    const order = ['auto', 'light', 'dark'];
    const button = $('theme-toggle');
    const current = () => document.documentElement.dataset.theme || 'auto';
    const paint = () => { button.textContent = `theme: ${current()}`; };
    button.addEventListener('click', () => {
      const next = order[(order.indexOf(current()) + 1) % order.length];
      if (next === 'auto') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = next;
      try { next === 'auto' ? localStorage.removeItem('prism-theme') : localStorage.setItem('prism-theme', next); } catch { /* not persisted */ }
      paint();
    });
    paint();
  }

  async function loadStatus() {
    const [providers, judge, shadow] = await Promise.all([
      api('/api/providers'),
      api('/arena/judge').catch(() => null),
      api('/api/shadow').catch(() => null),
    ]);

    state.providers = providers.providers || [];
    const modelCount = state.providers.reduce((sum, p) => sum + p.models.length, 0);
    $('status-mode').textContent = state.config.demo ? 'demo mode' : '';
    $('status-mode').classList.toggle('is-demo', Boolean(state.config.demo));
    $('status-models').textContent = `${fmt.plural(modelCount, 'model')} · ${fmt.plural(state.providers.length, 'provider')}`;
    $('status-judge').textContent = judge?.judge?.model ? `judge ${judge.judge.model}` : 'no judge';
    $('status-shadow').textContent = shadow?.enabled ? `shadow ${fmt.percent(shadow.rate)}` : 'shadow off';
    return { judge, shadow };
  }

  function renderModelList() {
    const list = $('model-list');
    const previous = new Set([...list.querySelectorAll('input:checked')].map(input => input.value));
    const nodes = [];
    const models = [];

    for (const provider of state.providers) {
      if (!provider.models.length) continue;
      nodes.push(h('div', { class: 'model-group', text: provider.name }));
      // A large catalog (OpenRouter) is capped in the picker; the API accepts any id.
      for (const model of provider.models.slice(0, 40)) {
        models.push(model.id);
        const blended = model.costPer1kInput === null || model.costPer1kInput === undefined
          ? null
          : (model.costPer1kInput * 3 + (model.costPer1kOutput ?? 0)) / 4;
        nodes.push(h('label', { class: 'model-option' },
          h('input', { type: 'checkbox', name: 'model', value: model.id, checked: previous.has(model.id) }),
          h('span', { text: model.id, title: model.id }),
          h('span', { class: 'price', text: fmt.perMillion(blended) }),
        ));
      }
    }

    const signature = models.join('|');
    if (signature === state.modelSignature) return;
    state.modelSignature = signature;
    list.replaceChildren(...nodes);

    if (previous.size === 0) {
      // Start with one model from each of the first few providers: a varied first comparison.
      const seen = new Set();
      for (const input of list.querySelectorAll('input')) {
        const provider = state.providers.find(p => p.models.some(m => m.id === input.value))?.name;
        if (seen.size >= 3) break;
        if (state.providers.length > 1 && seen.has(provider)) continue;
        input.checked = true;
        seen.add(state.providers.length > 1 ? provider : input.value);
      }
    }
    syncModelLimit();
  }

  function selectedModels() {
    return [...$('model-list').querySelectorAll('input:checked')].map(input => input.value);
  }

  function syncModelLimit() {
    const chosen = selectedModels();
    for (const input of $('model-list').querySelectorAll('input')) {
      input.disabled = !input.checked && chosen.length >= MAX_MODELS;
    }
    $('models-hint').textContent = `${chosen.length} selected · pick 2 to ${MAX_MODELS}`;
    $('run').disabled = chosen.length < 2 || Boolean(state.battle?.running);
  }

  function responseCard(combatant) {
    const body = h('div', { class: 'response-body cursor' });
    const identity = h('span', { class: 'response-identity' });
    const meta = h('span', { text: 'waiting' });
    const vote = h('button', { class: 'button', type: 'button', disabled: true, text: `${combatant.position} is better` });
    vote.addEventListener('click', () => castVote({ winnerPosition: combatant.position }));
    const card = h('article', { class: 'response', 'data-position': combatant.position },
      h('header', { class: 'response-head' },
        h('span', { class: 'response-label', text: `Response ${combatant.position}` }),
        identity,
      ),
      body,
      h('footer', { class: 'response-foot' }, meta, vote),
    );
    return { card, body, identity, meta, vote, combatant, text: '', failed: false };
  }

  async function runComparison(event) {
    event.preventDefault();
    const prompt = $('prompt').value.trim();
    const models = selectedModels();
    if (!prompt) {
      $('compose-status').textContent = 'Write a prompt first.';
      $('prompt').focus();
      return;
    }
    if (models.length < 2) return;

    state.battle?.abort?.abort();
    const abort = new AbortController();
    state.battle = { running: true, voted: false, abort, cards: [], battleId: null };
    syncModelLimit();
    $('compose-status').textContent = 'Starting…';
    $('verdict').hidden = true;
    $('battle-actions').hidden = false;
    $('vote-tie').disabled = true;
    $('battle-title').textContent = 'Which response is better?';

    try {
      const session = await api('/arena/session', {
        method: 'POST',
        body: { prompt, models, taskType: $('task-type').value || undefined },
      });
      const battle = state.battle;
      battle.battleId = session.battleId;
      battle.cards = session.combatants.map(responseCard);
      $('responses').replaceChildren(...battle.cards.map(c => c.card));
      $('battle').hidden = false;
      $('compose-status').textContent = `Streaming ${battle.cards.length} responses…`;

      await Promise.all(battle.cards.map(card => streamInto(session.sessionId, card, abort.signal)));
      const finalized = await api(`/arena/session/${session.sessionId}/finalize`, { method: 'POST' });
      battle.battleId = finalized.battleId ?? battle.battleId;
      battle.running = false;

      const votable = battle.cards.filter(c => !c.failed);
      if (votable.length < 2) {
        $('compose-status').textContent = 'Fewer than two models answered, so there is nothing to compare.';
        $('battle-actions').hidden = true;
      } else {
        for (const card of votable) card.vote.disabled = false;
        $('vote-tie').disabled = false;
        $('compose-status').textContent = 'Done. Pick the response you would rather have received.';
      }
    } catch (error) {
      if (error.name !== 'AbortError') $('compose-status').textContent = error.message;
      if (state.battle) state.battle.running = false;
    }
    syncModelLimit();
    loadHistory().catch(() => {});
  }

  async function streamInto(sessionId, card, signal) {
    try {
      await readEvents(`/arena/stream/${sessionId}/${card.combatant.id}`, event => {
        if (event.type === 'delta') {
          card.text += event.content;
          card.body.textContent = card.text;
        } else if (event.type === 'done') {
          card.meta.textContent = fmt.ms(event.latencyMs);
        } else if (event.type === 'error') {
          card.failed = true;
          card.body.classList.add('is-error');
          card.body.textContent = `This model failed to answer. ${event.message || ''}`.trim();
          card.meta.textContent = 'failed';
        }
      }, signal);
    } catch (error) {
      if (error.name === 'AbortError') return;
      card.failed = true;
      card.body.classList.add('is-error');
      card.body.textContent = 'The stream was interrupted.';
      card.meta.textContent = 'failed';
    }
    card.body.classList.remove('cursor');
    if (!card.failed && !card.text) {
      card.failed = true;
      card.body.classList.add('is-error');
      card.body.textContent = 'This model returned an empty response.';
    }
  }

  async function castVote(body) {
    const battle = state.battle;
    if (!battle || battle.running || battle.voted || !battle.battleId) return;
    battle.voted = true;
    for (const card of battle.cards) card.vote.disabled = true;
    $('vote-tie').disabled = true;
    try {
      await api('/arena/vote', { method: 'POST', body: { battleId: battle.battleId, ...body } });
      await reveal(battle, false);
    } catch (error) {
      battle.voted = false;
      $('compose-status').textContent = error.message;
      for (const card of battle.cards) card.vote.disabled = card.failed;
      $('vote-tie').disabled = false;
    }
  }

  async function reveal(battle, forfeit) {
    const data = await api(`/arena/reveal/${battle.battleId}${forfeit ? '?forfeit=1' : ''}`);
    battle.voted = true;
    for (const entry of data.entries) {
      const card = battle.cards.find(c => c.combatant.position === entry.position);
      if (!card) continue;
      card.identity.textContent = entry.model;
      card.identity.title = `${entry.provider} / ${entry.model}`;
      card.card.classList.toggle('is-winner', Boolean(entry.isWinner));
      const parts = [fmt.ms(entry.latencyMs)];
      if (entry.costUsd !== undefined && entry.costUsd !== null) parts.push(fmt.usd(entry.costUsd));
      card.meta.textContent = parts.join(' · ');
      card.vote.hidden = true;
    }
    $('battle-actions').hidden = true;
    $('battle-title').textContent = forfeit ? 'Revealed without a vote' : 'Recorded';
    showVerdict(battle, data, 0);
    loadHistory().catch(() => {});
  }

  // The judge rules in the background; ask a few times, then stop.
  function showVerdict(battle, data, attempt) {
    const verdict = $('verdict');
    const judged = data.judgeModel ? { model: data.judgeModel, reasoning: data.judgeReasoning, winner: data.winnerModel } : null;
    verdict.hidden = false;
    if (judged) {
      const winner = judged.winner || judged.winnerModel;
      verdict.replaceChildren(
        h('strong', { text: `Judge (${judged.model}): ` }),
        document.createTextNode(winner ? `preferred ${winner}. ` : 'found no consistent winner, which is recorded as a tie. '),
        document.createTextNode((judged.reasoning || '').slice(0, 600)),
      );
      return;
    }
    verdict.textContent = attempt < 5 ? 'Waiting for the judge’s verdict…' : 'The judge has not ruled on this comparison.';
    if (attempt >= 5 || state.battle !== battle) return;
    setTimeout(async () => {
      if (state.battle !== battle) return;
      try {
        showVerdict(battle, await api(`/arena/reveal/${battle.battleId}`), attempt + 1);
      } catch { /* leave the waiting note */ }
    }, 3000);
  }

  function initCompare() {
    $('compose').addEventListener('submit', runComparison);
    $('model-list').addEventListener('change', syncModelLimit);
    $('vote-tie').addEventListener('click', () => castVote({ tie: true }));
    $('forfeit').addEventListener('click', () => {
      const battle = state.battle;
      if (battle && !battle.running && !battle.voted && battle.battleId) reveal(battle, true).catch(error => { $('compose-status').textContent = error.message; });
    });

    // One listener for the page's lifetime; it looks at whatever battle is current.
    document.addEventListener('keydown', event => {
      if (state.tab !== 'compare' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (/^(input|textarea|select)$/i.test(event.target.tagName) || $('auth-dialog').open) return;
      const battle = state.battle;
      if (!battle || battle.running || battle.voted) return;
      if (event.key.toLowerCase() === 't') return castVote({ tie: true });
      const card = battle.cards.find(c => String(c.combatant.position) === event.key && !c.failed);
      if (card) castVote({ winnerPosition: card.combatant.position });
    });
  }

  async function loadHistory() {
    const data = await api('/arena/battles?limit=15');
    const rows = (data.battles || []).map(battle => {
      const winner = (battle.entries || []).find(e => e.isWinner);
      // Shadow and eval battles are never put to a vote; only the judge rules on them.
      const outcome = battle.status === 'voted'
        ? (winner?.model ? `you picked ${winner.model}` : 'you called a tie')
        : battle.status === 'revealed' ? 'revealed, no vote'
          : (battle.origin || 'arena') === 'arena' ? 'awaiting your vote' : 'judge only';
      return h('tr', {},
        h('td', { text: fmt.time(battle.timestamp) }),
        h('td', { class: 'prompt', text: battle.prompt, title: battle.prompt }),
        h('td', { text: battle.taskType || '' }),
        h('td', { text: battle.origin || 'arena' }),
        h('td', { text: outcome }),
      );
    });
    fillRows('history-table', rows, 'No comparisons yet.', 5);
  }

  function taskLabel(task) {
    return task ? `${task} tasks` : 'your work overall';
  }

  async function loadRatings() {
    const task = $('ratings-task').value;
    const source = $('ratings-source').value;
    const data = await api(`/arena/leaderboard?source=${source}${task ? `&taskType=${task}` : ''}`);
    const rows = data.leaderboard || [];
    const minGames = data.minGames ?? 5;
    const rated = rows.filter(r => r.rated);
    const finding = $('ratings-finding');
    $('ratings-count').textContent = `${fmt.count(data.comparisons ?? 0)} comparisons`;

    if (!rows.length) {
      sentence(finding, ['No comparisons yet for ', [taskLabel(task)], '.']);
      empty($('ratings-plot'), 'Nothing to plot.', 'Run a few comparisons on the Compare tab, or turn on shadow evaluation and let your traffic do it.');
      return;
    }

    if (rated.length < 2) {
      sentence(finding, ['Not enough evidence yet. A model needs ', [`${minGames} games`], ' before Prism will rank it or route on it.']);
    } else {
      const leader = rated[0];
      const close = rated.slice(1).filter(r => r.hi >= leader.lo);
      if (leader.pBest >= 0.9 || close.length === 0) {
        sentence(finding, [[leader.model], ` is very likely your best model for ${taskLabel(task)} (P = ${leader.pBest.toFixed(2)}).`]);
      } else {
        sentence(finding, [
          'No clear leader for ', [taskLabel(task)], '. ', [leader.model], ` is ahead (P = ${leader.pBest.toFixed(2)}), but `,
          [fmt.list(close.slice(0, 3).map(r => r.model))], ` ${close.length === 1 ? 'is' : 'are'} inside its interval. More comparisons between them would settle it.`,
        ]);
      }
    }
    forest($('ratings-plot'), rows, { minGames });
  }

  async function loadFrontier() {
    const task = $('frontier-task').value;
    const data = await api(`/api/frontier${task ? `?taskType=${task}` : ''}`);
    const rows = data.models || data.frontier || [];
    const finding = $('frontier-finding');

    const drawn = frontier($('frontier-plot'), rows);
    if (!drawn) {
      sentence(finding, ['This needs at least ', ['two rated models with known prices'], '.']);
      empty($('frontier-plot'), 'Nothing to plot yet.', 'Once two models have enough games, this shows what each rating point costs you.');
    } else {
      const rated = rows.filter(r => r.rated && r.blendedCostPer1k !== null && r.blendedCostPer1k !== undefined);
      const leader = [...rated].sort((a, b) => b.rating - a.rating)[0];
      const cheapest = rated.filter(r => r.onFrontier).sort((a, b) => a.blendedCostPer1k - b.blendedCostPer1k)[0];
      // Paying more for nothing is the finding people can act on today, so it leads.
      const overpriced = rated
        .filter(r => !r.onFrontier && leader && r.blendedCostPer1k > leader.blendedCostPer1k && leader.blendedCostPer1k > 0)
        .sort((a, b) => b.blendedCostPer1k - a.blendedCostPer1k)[0];
      if (overpriced) {
        const times = overpriced.blendedCostPer1k / leader.blendedCostPer1k;
        sentence(finding, [
          [leader.model], ' rates highest. ', [overpriced.model], ` costs ${times >= 2 ? `${Math.round(times)} times` : `${Math.round((times - 1) * 100)}% more than`}${times >= 2 ? ' as much' : ' it'} and does not rate higher.`,
        ]);
      } else if (leader && cheapest && cheapest !== leader) {
        const ratio = cheapest.blendedCostPer1k > 0 ? leader.blendedCostPer1k / cheapest.blendedCostPer1k : Infinity;
        const price = ratio === Infinity ? 'is free to run' : `costs ${ratio >= 2 ? `1/${Math.round(ratio)}` : `${Math.round(100 / ratio)}%`} as much`;
        const gap = Math.round(leader.rating - cheapest.rating);
        const overlaps = cheapest.hi >= leader.lo;
        sentence(finding, [
          [leader.model], ' rates highest. ', [cheapest.model], ` ${price} and rates ${gap} points lower`,
          overlaps ? ', a gap the data cannot yet distinguish from zero.' : ', and that gap is outside the intervals.',
        ]);
      } else if (leader) {
        sentence(finding, [[leader.model], ' rates highest and nothing cheaper is on the frontier.']);
      }
    }

    const tableRows = [...rows].sort((a, b) => b.rating - a.rating).map(r => h('tr', {},
      h('td', { text: r.model }),
      h('td', { text: r.provider }),
      h('td', { class: 'num', text: r.rated ? String(Math.round(r.rating)) : 'unrated' }),
      h('td', { class: 'num', text: r.rated ? `${Math.round(r.lo)} to ${Math.round(r.hi)}` : '' }),
      h('td', { class: 'num', text: String(r.games ?? 0) }),
      h('td', { class: 'num', text: fmt.perMillion(r.costPer1kInput) }),
      h('td', { class: 'num', text: fmt.perMillion(r.costPer1kOutput) }),
      h('td', { text: r.onFrontier ? 'yes' : '' }),
    ));
    fillRows('frontier-table', tableRows, 'No models in the routing pool.', 8);
  }

  function tile(label, value, note, tone) {
    const noteNode = h('div', { class: 'tile-note' });
    if (tone) noteNode.append(h('span', { class: tone, text: note }));
    else noteNode.textContent = note;
    return h('div', { class: 'tile' },
      h('div', { class: 'tile-label', text: label }),
      h('div', { class: `tile-value${value === null ? ' is-empty' : ''}`, text: value === null ? 'n/a' : value }),
      noteNode,
    );
  }

  function kappaBand(kappa) {
    if (kappa >= 0.81) return ['almost perfect agreement', 'good'];
    if (kappa >= 0.61) return ['substantial agreement', 'good'];
    if (kappa >= 0.41) return ['moderate agreement', 'warn'];
    if (kappa >= 0.21) return ['fair agreement', 'warn'];
    return ['little better than chance', 'bad'];
  }

  async function loadJudge() {
    const data = await api('/arena/judge');
    const agreement = data.agreement || { pairs: 0, agreement: null, kappa: null };
    const consistency = data.consistency || [];
    const pairs = consistency.reduce((sum, c) => sum + c.pairs, 0);
    const consistent = consistency.reduce((sum, c) => sum + (c.consistent || 0), 0);
    const length = data.lengthBias || null;

    const tiles = [];
    tiles.push(agreement.pairs >= 10
      ? tile('Agrees with you', fmt.percent(agreement.agreement), `on ${agreement.pairs} pairs you both ruled on`)
      : tile('Agrees with you', null, `${agreement.pairs} shared pairs so far. Ten are needed before this means anything.`));
    if (agreement.pairs >= 10 && agreement.kappa !== null) {
      const [band, tone] = kappaBand(agreement.kappa);
      tiles.push(tile('Cohen’s kappa', agreement.kappa.toFixed(2), band, tone));
    } else {
      tiles.push(tile('Cohen’s kappa', null, 'Agreement corrected for chance.'));
    }
    tiles.push(pairs > 0
      ? tile('Survives a position swap', fmt.percent(consistent / pairs), `${pairs} pairs judged with positions swapped. Disagreements are recorded as ties.`)
      : tile('Survives a position swap', null, 'No judged pairs yet.'));
    if (length && length.judged > 0) {
      const rate = length.pickedLonger / length.judged;
      // Better answers are often longer, so some lean is expected; the warning is for a judge that almost never picks the shorter one.
      tiles.push(tile('Picked the longer response', fmt.percent(rate), `of ${length.judged} decided pairs. Better answers are often longer, so some lean is normal. A share near 100% means length itself is winning.`, rate > 0.85 ? 'warn' : undefined));
    } else {
      tiles.push(tile('Picked the longer response', null, 'No decided pairs yet.'));
    }
    $('judge-tiles').replaceChildren(...tiles);

    const notes = $('judge-notes');
    const judge = data.judge || {};
    notes.replaceChildren(
      h('dl', {},
        h('dt', { text: 'default judge' }), h('dd', { text: judge.model ? `${judge.provider} / ${judge.model}` : 'none available' }),
      ),
      h('p', { text: 'For each comparison Prism picks a judge from a provider that has no model in it, asks it twice with the responses in opposite order, and keeps the verdict only when both answers agree. When you have voted on a comparison, your verdict is the one the ratings use.' }),
    );
  }

  async function loadTraffic() {
    const [stats, requests, status] = await Promise.all([api('/api/stats'), api('/api/requests?limit=50'), loadStatus()]);
    const totals = stats.totals || {};
    const byModel = stats.by_model || [];
    const total = totals.total_requests || 0;
    const weighted = byModel.reduce((sum, m) => sum + (m.avg_latency || 0) * m.total_requests, 0);

    $('traffic-tiles').replaceChildren(
      tile('Requests', fmt.count(total), 'through the proxy'),
      tile('Spend', fmt.usd(totals.total_cost || 0), `${fmt.count((totals.total_input_tokens || 0) + (totals.total_output_tokens || 0))} tokens`),
      tile('Average latency', total ? fmt.ms(weighted / total) : null, 'weighted by request count'),
      tile('Errors', total ? fmt.percent((totals.errors || 0) / total) : null, `${fmt.count(totals.errors || 0)} failed calls, including ones that failed over`, totals.errors ? 'warn' : undefined),
    );

    const spend = byModel.filter(m => m.total_cost > 0).sort((a, b) => b.total_cost - a.total_cost).slice(0, 10)
      .map(m => ({
        label: m.model,
        value: m.total_cost,
        detail: [['spend', fmt.usd(m.total_cost)], ['requests', fmt.count(m.total_requests)], ['avg latency', fmt.ms(m.avg_latency)]],
      }));
    if (spend.length) bars($('spend-plot'), spend, { format: fmt.usd });
    else empty($('spend-plot'), 'No spend recorded.', 'Requests sent through the proxy show up here.');

    const shadow = status.shadow;
    $('shadow-panel').replaceChildren(shadow?.enabled
      ? h('dl', {},
        h('dt', { text: 'sampling' }), h('dd', { text: `${fmt.percent(shadow.rate)} of requests` }),
        h('dt', { text: 'spent today' }), h('dd', { text: `${fmt.usd(shadow.spentTodayUsd)} of ${fmt.usd(shadow.budgetUsd)}` }),
        h('dt', { text: 'comparisons today' }), h('dd', { text: `${shadow.battlesToday} run, ${shadow.judgedToday} judged` }),
      )
      : h('p', { text: 'Off. Set SHADOW_RATE to replay a share of real requests to a second model and have the judge compare them. That is how ratings build without you voting on everything.' }));

    $('providers').replaceChildren(...(state.providers || []).map(p => {
      const failing = (p.health?.consecutive_failures || 0) >= 3;
      const tone = failing ? 'bad' : p.health?.status === 'healthy' ? 'good' : p.health?.status === 'degraded' ? 'warn' : '';
      return h('li', {},
        h('span', { text: `${p.name} · ${fmt.plural(p.models.length, 'model')}` }),
        h('span', { class: `state ${tone}`, text: failing ? 'routed around' : (p.health?.status || 'unknown') }),
      );
    }));

    const rows = (requests.requests || []).map(r => h('tr', {},
      h('td', { text: fmt.time(r.timestamp) }),
      h('td', { text: r.model, title: `${r.provider} / ${r.model}` }),
      h('td', { text: r.strategy }),
      h('td', { class: 'wrap', text: r.status === 'ok' ? (r.routing_reason || '') : (r.error_message || 'failed') }),
      h('td', { class: 'num', text: fmt.count(r.total_tokens) }),
      h('td', { class: 'num', text: fmt.ms(r.latency_ms) }),
      h('td', { class: 'num', text: fmt.usd(r.cost_usd) }),
      h('td', {}, h('span', { class: `state ${r.status === 'ok' ? 'good' : 'bad'}`, text: r.status })),
    ));
    fillRows('requests-table', rows, 'No requests yet. Point an OpenAI-compatible client at /v1.', 8);
  }

  const LOADERS = {
    compare: async () => { await loadStatus(); renderModelList(); await loadHistory(); },
    ratings: () => Promise.all([loadRatings(), loadStatus()]),
    frontier: () => Promise.all([loadFrontier(), loadStatus()]),
    judge: () => Promise.all([loadJudge(), loadStatus()]),
    traffic: loadTraffic,
  };

  // A hidden tab still renders once; it just stops polling until it is looked at again.
  // Only the newest call schedules the next one, so quick tab switches cannot stack timers.
  async function refresh() {
    clearTimeout(state.timer);
    const generation = (state.generation = (state.generation || 0) + 1);
    try {
      await LOADERS[state.tab]();
      setBanner(state.config.demo ? 'Demo mode: these are built-in mock models. Add an API key to .env to compare real ones.' : '');
    } catch (error) {
      setBanner(`Could not load this view: ${error.message}`, true);
    }
    if (generation === state.generation && !document.hidden) state.timer = setTimeout(refresh, REFRESH_MS);
  }

  async function boot() {
    initTheme();
    const config = await fetch('/api/config').then(r => r.json());
    state.config = config;
    $('version').textContent = config.version || '';

    for (const id of ['task-type', 'ratings-task', 'frontier-task']) {
      const select = $(id);
      if (id !== 'task-type') select.append(h('option', { value: '', text: 'Overall' }));
      for (const task of config.taskTypes || []) select.append(h('option', { value: task, text: task }));
    }
    for (const id of ['ratings-task', 'ratings-source', 'frontier-task']) $(id).addEventListener('change', refresh);

    if (config.authRequired && !token.get()) await askForToken();

    initTabs();
    initCompare();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.tab !== 'compare') refresh(); }, 200);
    });
    showTab(location.hash.slice(1) || 'compare');
  }

  boot().catch(error => setBanner(`Prism could not start: ${error.message}`, true));
})();
