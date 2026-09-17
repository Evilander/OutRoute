// SVG charts for the dashboard. Everything is built with createElementNS and
// textContent: model names come from upstream APIs and are never parsed as markup.
// Colour and type come from style.css classes, geometry from attributes, so the
// page's CSP (no inline styles) holds.

const PrismCharts = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs = {}, text) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function html(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function widthOf(container) {
    return Math.max(320, Math.floor(container.getBoundingClientRect().width) || 720);
  }

  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // Round tick values that cover [min, max].
  function ticks(min, max, target = 6) {
    const span = max - min || 1;
    const rough = span / target;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => span / s <= target) || magnitude * 10;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  const tooltip = {
    node: null,
    show(event, title, rows) {
      this.node = this.node || document.getElementById('tooltip');
      if (!this.node) return;
      this.node.replaceChildren(html('strong', '', title));
      for (const [label, value] of rows) {
        const row = html('div', 'tip-row');
        row.append(html('span', '', label), html('span', '', value));
        this.node.append(row);
      }
      this.node.hidden = false;
      const rect = event.target.getBoundingClientRect?.();
      const x = event.clientX ?? (rect ? rect.left + rect.width / 2 : 0);
      const y = event.clientY ?? (rect ? rect.top : 0);
      const box = this.node.getBoundingClientRect();
      const left = Math.min(window.innerWidth - box.width - 8, Math.max(8, x + 14));
      const top = y + box.height + 24 > window.innerHeight ? y - box.height - 12 : y + 16;
      this.node.style.left = `${left}px`;
      this.node.style.top = `${Math.max(8, top)}px`;
    },
    hide() {
      if (this.node) this.node.hidden = true;
    },
  };

  function attachTip(target, title, rows) {
    target.addEventListener('pointermove', event => tooltip.show(event, title, rows));
    target.addEventListener('pointerleave', () => tooltip.hide());
    target.addEventListener('focus', event => tooltip.show(event, title, rows));
    target.addEventListener('blur', () => tooltip.hide());
  }

  function empty(container, title, body) {
    const box = html('div', 'plot-empty');
    box.append(html('strong', '', title), document.createTextNode(` ${body}`));
    container.replaceChildren(box);
  }

  const fmtRating = value => String(Math.round(value));
  const fmtPercent = value => `${Math.round(value * 100)}%`;

  // Fig. 1: one row per model, a point at its rating and a bar across its interval.
  function forest(container, rows, { minGames = 5 } = {}) {
    if (!rows.length) return;
    const width = widthOf(container);
    // Narrow screens stack each row: name and numbers on one line, the interval
    // across the full width beneath it.
    const compact = width < 640;
    const labelWidth = compact ? 0 : 230;
    const valueWidth = compact ? 0 : 220;
    const rowHeight = compact ? 48 : 34;
    const top = 26;
    const height = top + rows.length * rowHeight + 8;
    const plotLeft = labelWidth + 12;
    const plotRight = width - valueWidth - 12;

    const low = Math.min(...rows.map(r => r.lo), 1500);
    const high = Math.max(...rows.map(r => r.hi), 1500);
    const pad = Math.max(20, (high - low) * 0.06);
    const min = low - pad;
    const max = high + pad;
    const x = value => plotLeft + ((value - min) / (max - min)) * (plotRight - plotLeft);

    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Model ratings with 95 percent intervals' });

    for (const tick of ticks(min, max, compact ? 4 : 7)) {
      root.append(svg('line', { class: 'grid-line', x1: x(tick), x2: x(tick), y1: top - 6, y2: height - 8 }));
      root.append(svg('text', { class: 'axis-text', x: x(tick), y: 12, 'text-anchor': 'middle' }, fmtRating(tick)));
    }
    if (!compact) {
      root.append(svg('text', { class: 'axis-text', x: plotRight + 24, y: 12 }, 'rating'));
      root.append(svg('text', { class: 'axis-text', x: plotRight + 96, y: 12 }, 'games'));
      root.append(svg('text', { class: 'axis-text', x: plotRight + 160, y: 12 }, 'P(best)'));
    }

    const leader = rows.find(r => r.rated);
    rows.forEach((row, index) => {
      const rowTop = top + index * rowHeight;
      const cy = compact ? rowTop + 34 : rowTop + rowHeight / 2;
      const lead = row === leader;
      const group = svg('g', { class: 'row', tabindex: 0, role: 'listitem' });
      group.append(svg('rect', { class: 'row-band', x: 0, y: rowTop, width, height: rowHeight }));
      if (compact) {
        group.append(svg('text', { class: `row-label${row.rated ? '' : ' is-muted'}`, x: 0, y: rowTop + 18 }, truncate(row.model, 26)));
        group.append(svg('text', { class: 'row-value', x: width, y: rowTop + 18, 'text-anchor': 'end' },
          row.rated ? `${fmtRating(row.rating)} ±${Math.round((row.hi - row.lo) / 2)} · ${row.battles} games` : `${row.battles} of ${minGames} games`));
      } else {
        group.append(svg('text', { class: `row-label${row.rated ? '' : ' is-muted'}`, x: labelWidth, y: cy + 4, 'text-anchor': 'end' }, truncate(row.model, 32)));
      }
      group.append(svg('line', { class: `whisker${lead ? ' is-lead' : ''}`, x1: x(row.lo), x2: x(row.hi), y1: cy, y2: cy }));
      group.append(svg('circle', { class: `point${lead ? ' is-lead' : ''}${row.rated ? '' : ' is-unrated'}`, cx: x(row.rating), cy, r: 5 }));

      if (!compact) {
        group.append(svg('text', { class: 'row-value', x: plotRight + 24, y: cy + 4 }, `${fmtRating(row.rating)} ±${Math.round((row.hi - row.lo) / 2)}`));
        group.append(svg('text', { class: 'row-value', x: plotRight + 96, y: cy + 4 }, row.rated ? String(row.battles) : `${row.battles} of ${minGames}`));
        group.append(svg('rect', { class: 'meter-track', x: plotRight + 160, y: cy - 3, width: 44, height: 6, rx: 3 }));
        if (row.pBest > 0) group.append(svg('rect', { class: 'meter-fill', x: plotRight + 160, y: cy - 3, width: Math.max(2, 44 * row.pBest), height: 6, rx: 3 }));
      }

      attachTip(group, row.model, [
        ['rating', fmtRating(row.rating)],
        ['95% interval', `${fmtRating(row.lo)} to ${fmtRating(row.hi)}`],
        ['won / lost / tied', `${row.wins} / ${row.losses} / ${row.ties}`],
        ['P(best)', fmtPercent(row.pBest)],
        ['status', row.rated ? 'rated' : `needs ${Math.max(0, minGames - row.battles)} more games`],
      ]);
      root.append(group);
    });

    container.replaceChildren(root);
  }

  // Fig. 2: price against rating. Frontier models are the accent; the rest recede.
  function frontier(container, rows) {
    const priced = rows.filter(r => r.rated && r.blendedCostPer1k !== null && r.blendedCostPer1k !== undefined);
    if (priced.length < 2) return false;

    const width = widthOf(container);
    const height = Math.round(Math.min(460, Math.max(300, width * 0.46)));
    const margin = { top: 16, right: 24, bottom: 44, left: 52 };

    // Free (local) models cannot sit on a log axis; they are pinned to its left edge.
    const paid = priced.filter(r => r.blendedCostPer1k > 0).map(r => r.blendedCostPer1k * 1000);
    const floor = paid.length ? Math.min(...paid) / 3 : 0.01;
    const price = r => (r.blendedCostPer1k > 0 ? r.blendedCostPer1k * 1000 : floor);
    const logMin = Math.log10(Math.min(...priced.map(price))) - 0.15;
    const logMax = Math.log10(Math.max(...priced.map(price))) + 0.15;
    const low = Math.min(...priced.map(r => r.lo));
    const high = Math.max(...priced.map(r => r.hi));
    const pad = Math.max(20, (high - low) * 0.08);

    const x = r => margin.left + ((Math.log10(price(r)) - logMin) / (logMax - logMin || 1)) * (width - margin.left - margin.right);
    const y = value => height - margin.bottom - ((value - (low - pad)) / (high - low + 2 * pad)) * (height - margin.top - margin.bottom);

    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Model price against rating' });

    for (const tick of ticks(low - pad, high + pad, 5)) {
      root.append(svg('line', { class: 'grid-line', x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick) }));
      root.append(svg('text', { class: 'axis-text', x: margin.left - 8, y: y(tick) + 3, 'text-anchor': 'end' }, fmtRating(tick)));
    }
    for (let exponent = Math.ceil(logMin); exponent <= Math.floor(logMax); exponent++) {
      const px = margin.left + ((exponent - logMin) / (logMax - logMin || 1)) * (width - margin.left - margin.right);
      root.append(svg('line', { class: 'grid-line', x1: px, x2: px, y1: margin.top, y2: height - margin.bottom }));
      root.append(svg('text', { class: 'axis-text', x: px, y: height - margin.bottom + 16, 'text-anchor': 'middle' }, `$${10 ** exponent >= 1 ? 10 ** exponent : (10 ** exponent).toFixed(-exponent)}`));
    }
    root.append(svg('text', { class: 'axis-text', x: width - margin.right, y: height - 8, 'text-anchor': 'end' }, 'USD per 1M tokens, blended 3:1 (log)'));
    root.append(svg('text', { class: 'axis-text', x: margin.left, y: 10 }, 'rating'));

    const onFrontier = priced.filter(r => r.onFrontier).sort((a, b) => price(a) - price(b));
    if (onFrontier.length > 1) {
      let path = '';
      onFrontier.forEach((r, i) => {
        path += i === 0 ? `M${x(r)},${y(r.rating)}` : ` H${x(r)} V${y(r.rating)}`;
      });
      root.append(svg('path', { class: 'frontier-line', d: path }));
    }

    // Muted points first so frontier points and their labels sit on top.
    for (const row of [...priced].sort((a, b) => Number(a.onFrontier) - Number(b.onFrontier))) {
      const cx = x(row);
      const lead = row.onFrontier;
      root.append(svg('line', { class: `whisker${lead ? ' is-lead' : ''}`, x1: cx, x2: cx, y1: y(row.lo), y2: y(row.hi) }));
      root.append(svg('circle', { class: `point${lead ? ' is-lead' : ''}`, cx, cy: y(row.rating), r: 5 }));
      // Frontier models are always named. With only a handful of points the rest
      // are too: the one that is off the frontier is often the one worth seeing.
      if (lead || priced.length <= 6) {
        const anchorEnd = cx > width - 170;
        root.append(svg('text', { class: 'point-label', x: cx + (anchorEnd ? -10 : 10), y: y(row.rating) - 8, 'text-anchor': anchorEnd ? 'end' : 'start' }, truncate(row.model, 26)));
      }
      const hit = svg('circle', { class: 'hit', cx, cy: y(row.rating), r: 14, tabindex: 0 });
      attachTip(hit, row.model, [
        ['rating', `${fmtRating(row.rating)} (${fmtRating(row.lo)} to ${fmtRating(row.hi)})`],
        ['price', row.blendedCostPer1k > 0 ? `$${(row.blendedCostPer1k * 1000).toFixed(2)} per 1M` : 'free (local)'],
        ['games', String(row.games)],
        ['frontier', row.onFrontier ? 'yes' : 'no: something is cheaper and rated higher'],
      ]);
      root.append(hit);
    }

    container.replaceChildren(root);
    return true;
  }

  // Fig. 3: horizontal bars, one hue. The largest spender takes the accent.
  function bars(container, rows, { format }) {
    if (!rows.length) return;
    const width = widthOf(container);
    const labelWidth = Math.min(220, width * 0.4);
    const rowHeight = 30;
    const height = rows.length * rowHeight + 8;
    const max = Math.max(...rows.map(r => r.value)) || 1;
    const plotWidth = width - labelWidth - 96;

    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Spend by model' });
    root.append(svg('line', { class: 'axis-line', x1: labelWidth + 12, x2: labelWidth + 12, y1: 0, y2: height }));
    rows.forEach((row, index) => {
      const cy = index * rowHeight + rowHeight / 2 + 4;
      const length = Math.max(2, (row.value / max) * plotWidth);
      const group = svg('g', { class: 'row', tabindex: 0 });
      group.append(svg('rect', { class: 'row-band', x: 0, y: cy - rowHeight / 2, width, height: rowHeight }));
      group.append(svg('text', { class: 'row-label', x: labelWidth, y: cy + 4, 'text-anchor': 'end' }, truncate(row.label, 28)));
      group.append(svg('path', {
        class: `bar${index === 0 ? ' is-lead' : ''}`,
        d: `M${labelWidth + 12},${cy - 7} h${Math.max(0, length - 4)} a4,4 0 0 1 4,4 v6 a4,4 0 0 1 -4,4 h${-Math.max(0, length - 4)} z`,
      }));
      group.append(svg('text', { class: 'row-value', x: labelWidth + 12 + length + 8, y: cy + 4 }, format(row.value)));
      attachTip(group, row.label, row.detail || [['value', format(row.value)]]);
      root.append(group);
    });
    container.replaceChildren(root);
  }

  return { forest, frontier, bars, empty, tooltip, html };
})();
