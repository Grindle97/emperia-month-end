'use strict';

// Emperia month-end close dashboard. No framework: state -> render().

const state = { me: null, period: null, view: null, tab: 'ltd', open: new Set(), busy: false };
const ENTITY = { ltd: { label: 'Emperia Ltd', ccy: 'GBP', sym: '£' }, inc: { label: 'Emperia VR Inc', ccy: 'USD', sym: '$' } };

// Status -> auditor's mark
const MARKS = {
  Reconciled: { mark: '✓', cls: 'Reconciled', word: 'Agreed' },
  Rounding: { mark: '≈', cls: 'Rounding', word: 'Rounding' },
  Explained: { mark: 'E', cls: 'Explained', word: 'Explained' },
  'Journal proposed': { mark: 'J', cls: 'Journal', word: 'Journal proposed' },
  Break: { mark: '!', cls: 'Break', word: 'Break' },
  'Needs input': { mark: '?', cls: 'Input', word: 'Needs input' },
  Review: { mark: '○', cls: 'Review', word: 'To review' },
  Reviewed: { mark: '✓', cls: 'Reviewed', word: 'Reviewed' },
};
const ORDER = ['Reconciled', 'Rounding', 'Reviewed', 'Explained', 'Journal proposed', 'Needs input', 'Break', 'Review'];

// ---------- helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function fmt(n, sym = '') {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  const s = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${sym}${s})` : `${sym}${s}`;
}
const can = (cap) => state.me && state.me.capabilities.includes(cap);
const monthName = (p) => {
  const [y, m] = p.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
};
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortMonth = (iso) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${shortMonth(iso)}`;
const who = (email) => (email ? email.split('@')[0] : '');

function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = 'toast'; }, error ? 6000 : 3000);
}

async function api(method, path, body) {
  const write = method !== 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    headers: write ? { 'Content-Type': 'application/json' } : {},
    body: write ? JSON.stringify(body || {}) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

async function act(fn, done) {
  if (state.busy) return;
  state.busy = true;
  try {
    state.view = await fn();
    state.schedules = null;
    if (state.tab === 'schedules') loadSchedules();
    if (done) toast(done);
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
    render();
  }
}

// ---------- period
function defaultPeriod() {
  const d = new Date();
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}
function periodOptions(saved) {
  const set = new Set(saved);
  const d = new Date();
  for (let i = 0; i < 4; i += 1) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    set.add(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  return [...set].sort().reverse();
}

async function loadPeriod(p) {
  state.period = p;
  state.open.clear();
  try {
    history.replaceState(null, '', `#${p}`);
  } catch { /* ignore */ }
  state.view = await api('GET', `/close/${p}`);
  state.schedules = null;
  state.activity = null;
  render();
  if (state.tab === 'schedules') loadSchedules();
  if (state.tab === 'activity') loadActivity();
}

// ---------- header
function renderHeader() {
  const sel = document.getElementById('period');
  const opts = periodOptions((state.view && state.view.periods) || []);
  sel.replaceChildren(...opts.map((p) => h('option', { value: p, selected: p === state.period }, monthName(p) + ((state.view && state.view.periods || []).includes(p) ? '' : ' (not run)'))));
  const run = document.getElementById('run');
  run.hidden = !can('run');
  run.disabled = state.busy;
  run.textContent = state.busy === 'run' ? 'Reading Xero…' : (state.view && state.view.run ? 'Re-run close' : 'Run close');
  const w = document.getElementById('who');
  w.replaceChildren(h('strong', {}, state.me.email), `${state.me.role}`);
}

function runClose() {
  if (state.busy) return;
  state.busy = 'run';
  render();
  toast('Reading Xero for both entities. This can take up to a minute.');
  api('POST', `/close/${state.period}/run`).then((v) => {
    state.view = v;
    toast(`Close run for ${monthName(state.period)}.`);
  }).catch((err) => toast(err.message, true)).finally(() => {
    state.busy = false;
    render();
  });
}

// ---------- tabs
function renderTabs() {
  const v = state.view;
  const tabs = [
    ['ltd', ENTITY.ltd.label, v && v.entities && v.entities.ltd ? v.entities.ltd.blockers.length : null],
    ['inc', ENTITY.inc.label, v && v.entities && v.entities.inc ? v.entities.inc.blockers.length : null],
    ['schedules', 'Schedules', null],
    ['journals', 'Journals', v && v.journals ? v.journals.filter((j) => !j.decision).length : null],
    ['activity', 'Activity', null],
    ['feedback', 'Feedback', state.feedback ? state.feedback.filter((f) => f.status === 'new').length : null],
  ];
  document.getElementById('tabs').replaceChildren(...tabs.map(([key, label, n]) => h('button', {
    class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(state.tab === key),
    onclick: () => { state.tab = key; render(); if (key === 'activity') loadActivity(); if (key === 'schedules') loadSchedules(); if (key === 'feedback') loadFeedback(); },
  }, label, n ? h('span', { class: 'count', 'aria-label': `${n} open` }, String(n)) : null)));
}

// ---------- entity view
function statusOf(row) {
  if (row.reviewed && !['Reconciled', 'Rounding', 'Explained'].includes(row.status)) return 'Reviewed';
  return row.status;
}

function strip(key, e) {
  const total = e.rows.length;
  const counts = ORDER.map((s) => [s, e.counts[s] || 0]).filter(([, n]) => n);
  const settled = total - e.blockers.length;
  const meter = h('div', { class: 'meter', role: 'img', 'aria-label': `${settled} of ${total} accounts settled` },
    counts.map(([s, n]) => {
      const seg = h('span', { class: `seg-${MARKS[s].cls}`, title: `${MARKS[s].word}: ${n}` });
      seg.style.width = `${(n / total) * 100}%`;
      return seg;
    }));
  let signBlock;
  if (e.signoff && !e.signoff.stale) {
    signBlock = h('span', { class: 'signed' }, `Signed off by ${who(e.signoff.by)}, ${when(e.signoff.at)}`);
  } else {
    signBlock = h('div', {},
      e.signoff && e.signoff.stale ? h('span', { class: 'stale' }, 'Figures changed since sign-off. ') : null,
      can('signoff') ? h('button', {
        class: 'btn btn-good', type: 'button', disabled: e.blockers.length > 0 || state.busy,
        title: e.blockers.length ? 'Clear the open items first' : '',
        onclick: () => act(() => api('POST', `/close/${state.period}/signoff`, { entity: key }), `${ENTITY[key].label} signed off.`),
      }, `Sign off ${ENTITY[key].label}`) : null);
  }
  return h('section', { class: 'strip', 'aria-label': 'Close progress' },
    h('div', { class: 'strip-head' },
      h('h1', { class: 'strip-title' }, `${ENTITY[key].label}, ${monthName(state.period)}`),
      h('span', { class: 'strip-sum' }, e.blockers.length ? `${settled} of ${total} accounts settled, ${e.blockers.length} open` : `All ${total} accounts settled`),
      signBlock),
    meter,
    h('div', { class: 'legend' }, counts.map(([s, n]) => h('span', {}, h('span', { class: `mark m-${MARKS[s].cls}`, 'aria-hidden': 'true' }, MARKS[s].mark), ' ', MARKS[s].word, h('b', {}, String(n))))),
    e.blockers.length ? h('ul', { class: 'open-list' }, groupBlockers(e.blockers).map(([need, accts]) => h('li', {},
      h('strong', {}, `${need} (${accts.length})`), `: ${accts.join(', ')}`))) : null);
}

function groupBlockers(blockers) {
  const m = new Map();
  for (const b of blockers) {
    if (!m.has(b.need)) m.set(b.need, []);
    m.get(b.need).push(b.account);
  }
  return [...m.entries()];
}

function icPanel() {
  const ic = state.view.intercompany;
  if (!ic) return null;
  const rateInput = h('input', { class: 'field', type: 'text', inputmode: 'decimal', value: ic.rate || '', 'aria-label': 'USD/GBP rate at month end' });
  return h('section', { 'aria-label': 'Intercompany' },
    h('h2', { class: 'section-title' }, 'Intercompany'),
    h('div', { class: 'ic' },
      h('div', {}, h('dl', {}, h('dt', {}, 'Inc owes Ltd'), h('dd', {}, fmt(ic.incUsd, '$')))),
      h('div', {}, h('dl', {}, h('dt', {}, 'Rate at month end (GBP per USD)'),
        can('input') ? h('dd', { class: 'rate' }, rateInput, h('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => act(() => api('PUT', `/close/${state.period}/fx`, { usdGbp: rateInput.value }), 'Rate saved and intercompany recalculated.'),
        }, 'Save')) : h('dd', {}, ic.rate || 'Not entered'))),
      h('div', {}, h('dl', {}, h('dt', {}, 'Should be in Ltd'), h('dd', {}, ic.expectedGbp !== undefined ? fmt(ic.expectedGbp, '£') : '–'))),
      h('div', {}, h('dl', {}, h('dt', {}, 'Ltd holds'), h('dd', {}, fmt(ic.ltdGbp, '£')))),
      h('div', {}, h('dl', {}, h('dt', {}, 'Difference'), h('dd', { class: Math.abs(ic.difference || 0) > 0.05 ? 'diff-bad' : '' }, ic.difference !== undefined ? fmt(-ic.difference, '£') : '–')))));
}

function entityView(key) {
  const v = state.view;
  const e = v.entities[key];
  if (!e) return h('p', { class: 'empty' }, 'No results for this entity.');
  const sym = ENTITY[key].sym;
  const body = [];
  for (const group of groupRows(e.rows)) {
    body.push(h('tr', { class: 'group' }, h('td', { colspan: 7 }, group.label)));
    for (const sec of group.sections) {
    if (group.sections.length > 1 || sec.label !== group.label) body.push(h('tr', { class: 'subgroup' }, h('td', { colspan: 7 }, sec.label)));
    for (const r of sec.rows) {
      const id = `${key}|${r.account}`;
      const st = statusOf(r);
      const m = MARKS[st] || MARKS.Review;
      const open = state.open.has(id);
      const diffBad = r.difference !== null && Math.abs(r.difference) > 1 && !['Explained', 'Reviewed'].includes(st);
      body.push(h('tr', {
        class: 'row', tabindex: '0', 'aria-expanded': String(open),
        onclick: () => toggle(id),
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(id); } },
      },
      h('td', { class: 'mark-col' }, h('span', { class: `mark m-${m.cls}`, title: m.word }, m.mark)),
      h('td', {}, h('span', { class: 'acct' }, r.account), r.code ? h('span', { class: 'acct-code' }, r.code) : null, h('span', { class: 'status-word' }, m.word)),
      h('td', { class: 'num' }, fmt(r.xero, sym)),
      h('td', { class: 'num' }, r.supporting !== null ? fmt(r.supporting, sym) : ''),
      h('td', { class: `num ${diffBad ? 'diff-bad' : 'diff-ok'}` }, r.difference !== null ? fmt(r.difference, sym) : ''),
      h('td', { class: 'num hide-sm' }, r.movement ? fmt(r.movement, sym) : '–'),
      h('td', { class: 'comment hide-sm' }, r.comment, r.reviewed ? h('span', { class: 'who-ticked' }, `Ticked by ${who(r.reviewed.by)}${r.reviewed.note ? `: ${r.reviewed.note}` : ''}`) : null)));
      if (open) body.push(h('tr', { class: 'detail' }, h('td', { colspan: 7 }, detail(key, r, sym))));
    }
    if (sec.rows.length > 1 && group.sections.length > 1) body.push(h('tr', { class: 'subtotal' }, h('td', {}), h('td', {}, `Total ${sec.label.toLowerCase()}`), h('td', { class: 'num' }, fmt(sec.total, sym)), h('td', { colspan: 4 })));
    }
    body.push(h('tr', { class: 'total' }, h('td', {}), h('td', {}, `Total ${group.label.toLowerCase()}`), h('td', { class: 'num' }, fmt(group.total, sym)), h('td', { colspan: 4 })));
  }
  return [
    v.run.demo ? null : null,
    strip(key, e),
    key === 'ltd' ? icPanel() : null,
    h('div', { class: 'toolbar' },
      h('span', { class: 'strip-sum' }, `Xero read ${when(v.run.ranAt)} by ${who(v.run.ranBy)}`),
      h('a', { class: 'btn btn-sm', href: `/api/close/${state.period}/pack/${key}` }, 'Download Excel pack')),
    h('table', { class: 'ledger' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'mark-col' }, h('span', { class: 'sr' }, 'Status')),
        h('th', {}, 'Account'),
        h('th', { class: 'num' }, `Xero (${ENTITY[key].ccy})`),
        h('th', { class: 'num' }, 'Supporting'),
        h('th', { class: 'num' }, 'Difference'),
        h('th', { class: 'num hide-sm' }, 'Moved in month'),
        h('th', { class: 'hide-sm' }, 'Comment'))),
      h('tbody', {}, body)),
    e.warnings && e.warnings.length ? h('ul', { class: 'notes' }, e.warnings.map((w) => h('li', {}, w))) : null,
  ];
}

// Balance sheet sections in Xero's order (mirrors src/recon/sections.js).
const SECTIONS = [
  ['bank', 'ASSET', 'Bank', ['BANK']],
  ['current-assets', 'ASSET', 'Current assets', ['CURRENT', 'PREPAYMENT', 'INVENTORY']],
  ['fixed-assets', 'ASSET', 'Fixed assets', ['FIXED']],
  ['noncurrent-assets', 'ASSET', 'Non-current assets', ['NONCURRENT']],
  ['current-liabilities', 'LIABILITY', 'Current liabilities', ['CURRLIAB', 'LIABILITY']],
  ['noncurrent-liabilities', 'LIABILITY', 'Non-current liabilities', ['TERMLIAB']],
  ['equity', 'EQUITY', 'Equity', ['EQUITY']],
];
function groupRows(rows) {
  const sectionOf = (r) => r.section || (r.rule === 'bank' ? 'bank' : (SECTIONS.find((s) => s[1] === r.class && s[3].includes(r.type)) || SECTIONS.find((s) => s[1] === r.class) || SECTIONS[1])[0]);
  const sum = (xs) => Math.round(xs.reduce((t, x) => t + (x.xero || 0), 0) * 100) / 100;
  return [['ASSET', 'Assets'], ['LIABILITY', 'Liabilities'], ['EQUITY', 'Equity']].map(([cls, label]) => {
    const sections = SECTIONS.filter((s) => s[1] === cls).map(([k, , l]) => {
      const rs = rows.filter((r) => r.class === cls && sectionOf(r) === k).sort((a, b) => a.account.localeCompare(b.account));
      return { label: l, rows: rs, total: sum(rs) };
    }).filter((s) => s.rows.length);
    return { label, sections, total: sections.reduce((t, s) => Math.round((t + s.total) * 100) / 100, 0) };
  }).filter((g) => g.sections.length);
}

function toggle(id) {
  if (state.open.has(id)) state.open.delete(id);
  else state.open.add(id);
  render();
}

// ---------- row detail
function detail(key, r, sym) {
  const left = [];
  const d = r.detail || {};
  if (d.register) {
    left.push(h('h4', {}, `${d.register.replace(/-/g, ' ').replace(/^eor/, 'EOR').replace(/^./, (c) => c.toUpperCase())} register`));
    left.push(h('table', { class: 'mini' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Period'), h('th', {}, 'Method'), h('th', { class: 'num' }, 'Released this month'), h('th', { class: 'num' }, 'Balance'))),
      h('tbody', {}, d.lines.length ? d.lines.map((l) => h('tr', {},
        h('td', {}, [l.supplier || l.customer || l.description, l.invoiceNumber].filter(Boolean).join(' · ')),
        h('td', { class: 'nowrap' }, l.start ? (l.start === l.end ? shortDate(l.start) : `${shortMonth(l.start)} – ${shortMonth(l.end)}`) : ''),
        h('td', {}, { static: 'Held', straight_line: 'Monthly', on_end_date: 'On end date' }[l.method] || l.method),
        h('td', { class: 'num' }, l.releasedThisMonth ? fmt(l.releasedThisMonth, sym) : ''),
        h('td', { class: 'num' }, fmt(l.balance, sym)))) : h('tr', {}, h('td', { colspan: 5 }, 'No items.'))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 4 }, 'Total per register'), h('td', { class: 'num' }, fmt(r.supporting, sym))))));
    if (d.notes && d.notes.length) left.push(h('ul', { class: 'notes' }, d.notes.map((n) => h('li', {}, n))));
    left.push(h('p', {}, h('button', { class: 'linkish', type: 'button', onclick: (ev) => { ev.stopPropagation(); openSchedule(key, d.register); } }, 'See it month by month')));
  } else if (d.byContact) {
    left.push(h('h4', {}, `Aged at ${state.view.entities[key].end}, by contact`));
    left.push(h('table', { class: 'mini' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Contact'), ['Current', '1-30 days', '31-60 days', '61-90 days', 'Older'].map((b) => h('th', { class: 'num' }, b)), h('th', { class: 'num' }, 'Total'))),
      h('tbody', {}, d.byContact.map((c) => h('tr', {}, h('td', {}, c.contact), ['Current', '1-30 days', '31-60 days', '61-90 days', 'Older'].map((b) => h('td', { class: 'num' }, c[b] ? fmt(c[b], sym) : '')), h('td', { class: 'num' }, fmt(c.total, sym))))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 6 }, 'Total'), h('td', { class: 'num' }, fmt(r.supporting, sym))))));
  } else if (d.unreconciled) {
    left.push(h('h4', {}, d.unreconciled.length ? `${d.unreconciled.length} unreconciled transaction(s) in Xero` : 'No unreconciled transactions in Xero'));
    if (d.unreconciled.length) {
      left.push(h('table', { class: 'mini' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Contact'), h('th', {}, 'Reference'), h('th', { class: 'num' }, 'Amount'))),
        h('tbody', {}, d.unreconciled.map((t) => h('tr', {}, h('td', {}, String(t.date || '').slice(0, 10)), h('td', {}, t.contact || ''), h('td', {}, t.reference || ''), h('td', { class: 'num' }, fmt(t.total, sym)))))));
    }
  } else {
    left.push(h('h4', {}, 'What to check'), h('p', { class: 'comment' }, r.comment || 'No schedule for this account yet.'));
  }
  return h('div', { class: 'detail-grid' }, h('div', {}, left), h('div', {}, actions(key, r, sym)));
}

function actions(key, r, sym) {
  const out = [];
  const period = state.period;
  if (r.rule === 'bank' && can('input')) {
    const inp = h('input', { type: 'text', inputmode: 'decimal', value: r.supporting ?? '', placeholder: '0.00', id: `stmt-${r.account}` });
    out.push(h('div', { class: 'action' },
      h('label', { for: `stmt-${r.account}` }, `Statement balance at ${state.view.entities[key].end}`),
      inp,
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: (ev) => { ev.stopPropagation(); act(() => api('PUT', `/close/${period}/statement`, { entity: key, account: r.account, amount: inp.value }), 'Statement balance saved.'); } }, 'Save balance'))));
  }
  const explainable = r.difference !== null && Math.abs(r.difference) > 0.05;
  if (explainable && can('explain')) {
    const ta = h('textarea', { id: `ex-${r.account}`, placeholder: 'What the difference is and what happens next' }, r.status === 'Explained' ? '' : '');
    out.push(h('div', { class: 'action' },
      h('label', { for: `ex-${r.account}` }, `Explain the ${fmt(r.difference, sym)} difference`),
      h('p', {}, 'Saved against this amount. If next month shows the same difference, it is carried forward for you to confirm.'),
      ta,
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: (ev) => { ev.stopPropagation(); act(() => api('POST', `/close/${period}/explain`, { entity: key, account: r.account, difference: r.difference, comment: ta.value }), 'Explanation saved.'); } }, 'Save explanation'))));
  }
  if (can('review') && !['Reconciled', 'Rounding'].includes(r.status)) {
    if (r.reviewed) {
      out.push(h('div', { class: 'action' },
        h('p', {}, `Ticked by ${r.reviewed.by}, ${when(r.reviewed.at)}${r.reviewed.note ? `: ${r.reviewed.note}` : ''}`),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: (ev) => { ev.stopPropagation(); act(() => api('POST', `/close/${period}/review`, { entity: key, account: r.account, undo: true }), 'Tick removed.'); } }, 'Remove tick')));
    } else {
      const note = h('input', { type: 'text', id: `rv-${r.account}`, placeholder: 'Optional note, e.g. agreed to FPS' });
      out.push(h('div', { class: 'action' },
        h('label', { for: `rv-${r.account}` }, 'Tick as reviewed'),
        h('p', {}, 'Records that you checked this balance. The tick drops off if the balance changes.'),
        note,
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn btn-sm btn-good', type: 'button', onclick: (ev) => { ev.stopPropagation(); act(() => api('POST', `/close/${period}/review`, { entity: key, account: r.account, note: note.value }), 'Ticked.'); } }, 'Tick'))));
    }
  }
  if (r.status === 'Journal proposed') {
    out.push(h('div', { class: 'action' }, h('p', {}, 'A journal is proposed to clear this.'),
      h('button', { class: 'linkish', type: 'button', onclick: (ev) => { ev.stopPropagation(); state.tab = 'journals'; render(); } }, 'Open journals')));
  }
  if (!out.length) out.push(h('p', { class: 'comment' }, r.comment || ''));
  return out;
}

// ---------- journals
function journalsView() {
  const js = state.view.journals || [];
  const items = [h('p', { class: 'phase-note' }, 'Approving records the decision and who made it. Nothing is posted to Xero yet: posting approved journals comes in a later phase.')];
  if (!js.length) items.push(h('div', { class: 'empty-state' }, h('h2', {}, 'No journals proposed'), h('p', {}, 'Everything with a register agrees to Xero for this month.')));
  for (const j of js) {
    const sym = ENTITY[j.entityKey].sym;
    const dr = j.lines.reduce((s, l) => s + l.debit, 0);
    const cr = j.lines.reduce((s, l) => s + l.credit, 0);
    const dec = j.decision;
    const note = h('input', { class: 'field', type: 'text', placeholder: 'Note (required to reject)', 'aria-label': 'Decision note' });
    items.push(h('article', { class: `journal ${dec ? dec.decision : ''}` },
      h('div', { class: 'journal-head' },
        h('h3', {}, j.narration),
        h('span', { class: 'comment' }, `${j.entity}, dated ${j.date}`)),
      h('p', { class: 'why' }, j.reason),
      h('table', { class: 'mini' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'Description'), h('th', { class: 'num' }, 'Debit'), h('th', { class: 'num' }, 'Credit'))),
        h('tbody', {}, j.lines.map((l) => h('tr', {}, h('td', {}, l.account), h('td', {}, l.description), h('td', { class: 'num' }, l.debit ? fmt(l.debit, sym) : ''), h('td', { class: 'num' }, l.credit ? fmt(l.credit, sym) : '')))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 2 }, 'Total'), h('td', { class: 'num' }, fmt(dr, sym)), h('td', { class: 'num' }, fmt(cr, sym))))),
      dec
        ? h('div', { class: 'journal-actions' },
          h('span', { class: `decision ${dec.decision}` }, `${dec.decision === 'approved' ? 'Approved' : 'Rejected'} by ${who(dec.by)}, ${when(dec.at)}${dec.note ? `: ${dec.note}` : ''}`),
          can('approve') ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => act(() => api('POST', `/close/${state.period}/journals/${j.id}`, { decision: 'undo' }), 'Decision withdrawn.') }, 'Withdraw decision') : null)
        : can('approve')
          ? h('div', { class: 'journal-actions' }, note,
            h('button', { class: 'btn btn-sm btn-good', type: 'button', onclick: () => act(() => api('POST', `/close/${state.period}/journals/${j.id}`, { decision: 'approved', note: note.value }), 'Journal approved.') }, 'Approve'),
            h('button', { class: 'btn btn-sm btn-bad', type: 'button', onclick: () => act(() => api('POST', `/close/${state.period}/journals/${j.id}`, { decision: 'rejected', note: note.value }), 'Journal rejected.') }, 'Reject'))
          : h('span', { class: 'comment' }, 'Waiting for an approver.')));
  }
  return items;
}

// ---------- activity
async function loadActivity() {
  try {
    const { activity } = await api('GET', `/close/${state.period}/activity`);
    state.activity = activity;
    render();
  } catch (err) { toast(err.message, true); }
}
const ACTION_WORDS = {
  run: 'ran the close', fx: 'set the rate', statement: 'entered a statement balance', explain: 'explained a difference',
  'explain-cleared': 'removed an explanation', review: 'ticked', 'review-undone': 'removed a tick', 'journal-approved': 'approved a journal',
  'journal-rejected': 'rejected a journal', 'journal-undo': 'withdrew a journal decision', signoff: 'signed off',
};
function activityView() {
  const a = state.activity;
  if (!a) return h('p', { class: 'loading' }, 'Loading…');
  if (!a.length) return h('p', { class: 'empty' }, 'Nothing recorded for this period yet.');
  return h('ul', { class: 'activity' }, a.map((x) => h('li', {},
    h('time', { datetime: x.at }, when(x.at)),
    h('span', {}, h('strong', {}, who(x.by)), ` ${ACTION_WORDS[x.action] || x.action}`,
      x.entity ? ` (${ENTITY[x.entity] ? ENTITY[x.entity].label : x.entity})` : '',
      x.account ? `: ${x.account}` : '', x.detail ? `. ${x.detail}` : ''))));
}

// ---------- main
function render() {
  renderHeader();
  renderTabs();
  const main = document.getElementById('main');
  const v = state.view;
  let content;
  if (!v) content = h('p', { class: 'loading' }, 'Loading…');
  else if (!v.run && ['ltd', 'inc'].includes(state.tab)) {
    content = h('div', { class: 'empty-state' },
      h('h2', {}, `${monthName(state.period)} hasn't been run yet`),
      h('p', {}, 'Running the close reads both Xero files and reconciles every balance sheet account. Nothing is changed in Xero.'),
      can('run') ? h('button', { class: 'btn btn-primary', type: 'button', disabled: state.busy, onclick: runClose }, state.busy === 'run' ? 'Reading Xero…' : `Run ${monthName(state.period)}`) : h('p', {}, 'Ask an admin or preparer to run it.'));
  } else if (state.tab === 'journals') content = v.run ? journalsView() : h('p', { class: 'empty' }, 'Run the close first.');
  else if (state.tab === 'activity') content = activityView();
  else if (state.tab === 'schedules') content = schedulesView();
  else if (state.tab === 'feedback') content = feedbackView();
  else content = entityView(state.tab);
  main.replaceChildren(...[content].flat(Infinity).filter(Boolean));
  if (v && v.run && v.run.demo && !document.querySelector('.demo-flag')) {
    document.querySelector('.tabs').before(h('div', { class: 'demo-flag' }, 'Demo mode: September 2026 balances from the reconciliation workbooks, not live Xero.'));
  }
}

// ---------- schedules (month by month, like the workbook tabs)
async function loadSchedules() {
  try {
    state.schedules = await api('GET', `/close/${state.period}/schedules`);
    render();
    if (state.scrollTo) {
      const el = document.getElementById(state.scrollTo);
      state.scrollTo = null;
      if (el) el.scrollIntoView({ block: 'start' });
    }
  } catch (err) { toast(err.message, true); }
}
function openSchedule(key, register) {
  state.tab = 'schedules';
  state.schedEntity = key;
  state.scrollTo = `sched-${key}-${register}`;
  render();
  loadSchedules();
}
const regTitle = (r) => r.register.replace(/-/g, ' ').replace(/^eor/, 'EOR').replace(/^./, (c) => c.toUpperCase());
const itemLabel = (it) => [it.supplier || it.customer || it.description, it.invoiceNumber].filter(Boolean).join(' · ');
const shortCol = (m) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

function scheduleTable(key, s) {
  const sym = ENTITY[key].sym;
  const cur = state.period;
  const colCls = (m) => `num${m === cur ? ' cur' : ''}${m === s.openMonth ? ' bf' : ''}${m > cur ? ' fut' : ''}`;
  const cell = (c, m) => {
    if (m === s.openMonth) return c.added ? fmt(c.added, sym) : '';
    const v = (c.added || 0) + (c.released || 0);
    return v ? fmt(v, sym) : '';
  };
  const items = s.items.filter((x) => x.live);
  const xero = s.xero[cur];
  const closing = s.totals.closing[cur];
  const diff = xero !== undefined && closing !== undefined ? Math.round((xero - closing) * 100) / 100 : null;
  return h('section', { class: 'sched', id: `sched-${key}-${s.register}` },
    h('div', { class: 'sched-head' },
      h('h2', { class: 'section-title' }, `${regTitle(s)}`, regTitle(s).toLowerCase() !== s.account.toLowerCase() ? h('span', { class: 'acct-code' }, s.account) : null),
      xero !== undefined ? h('span', { class: Math.abs(diff) > 1 ? 'diff-bad' : 'signed' },
        Math.abs(diff) <= 0.05 ? `Agrees to Xero at ${shortCol(cur)}` : Math.abs(diff) <= 1 ? `Agrees to Xero at ${shortCol(cur)}, ${fmt(diff, sym)} rounding` : `${fmt(diff, sym)} difference to Xero at ${shortCol(cur)}`) : null),
    h('div', { class: 'sched-scroll' },
      h('table', { class: 'mini sched-table' },
        h('thead', {}, h('tr', {},
          h('th', { class: 'stick' }, 'Item'),
          h('th', {}, 'Period'),
          s.months.map((m) => h('th', { class: colCls(m) }, m === s.openMonth ? `b/f ${shortCol(m)}` : shortCol(m))))),
        h('tbody', {}, items.length ? items.map((x) => h('tr', {},
          h('td', { class: 'stick' }, itemLabel(x.item), x.item.expenseAccount || x.item.revenueAccount ? h('span', { class: 'status-word' }, x.item.expenseAccount || x.item.revenueAccount) : null),
          h('td', { class: 'nowrap' }, x.item.start ? (x.item.start === x.item.end ? shortDate(x.item.start) : `${shortMonth(x.item.start)} – ${shortMonth(x.item.end)}`) : { static: 'Held' }[x.item.method] || ''),
          s.months.map((m) => h('td', { class: colCls(m) }, cell(x.cells[m], m))))) : h('tr', {}, h('td', { colspan: s.months.length + 2 }, 'Nothing on this schedule.'))),
        h('tfoot', {},
          [['Opening', 'opening'], ['Added', 'additions'], ['Released', 'releases'], ['Closing', 'closing']].map(([label, k]) => h('tr', { class: k === 'closing' ? 'closing' : '' },
            h('td', { class: 'stick' }, label), h('td', {}),
            s.months.map((m) => h('td', { class: colCls(m) }, (m === s.openMonth && k !== 'closing') || (k !== 'closing' && k !== 'opening' && !s.totals[k][m]) ? '' : fmt(s.totals[k][m], sym))))),
          h('tr', {}, h('td', { class: 'stick' }, 'Per Xero'), h('td', {}), s.months.map((m) => h('td', { class: colCls(m) }, s.xero[m] !== undefined ? fmt(s.xero[m], sym) : '')))))),
    s.notes.length ? h('ul', { class: 'notes' }, s.notes.map((n) => h('li', {}, n))) : null);
}

function schedulesView() {
  const sc = state.schedules;
  if (!sc) return h('p', { class: 'loading' }, 'Loading schedules…');
  const key = state.schedEntity || 'ltd';
  return [
    h('div', { class: 'seg-switch', role: 'group', 'aria-label': 'Entity' },
      ['ltd', 'inc'].map((k) => h('button', { type: 'button', class: `btn btn-sm${k === key ? ' on' : ''}`, 'aria-pressed': String(k === key), onclick: () => { state.schedEntity = k; render(); } }, ENTITY[k].label))),
    h('p', { class: 'phase-note' }, `Movements by month, with balances underneath. ${monthName(state.period)} is highlighted and checked against Xero; later months are the forecast from the schedule. Schedules start from the balances brought forward at 30 Sep 2026.`),
    sc.entities[key].filter((s) => s.items.some((x) => x.live) || Math.abs(s.xero[state.period] || 0) > 0.005).map((s) => scheduleTable(key, s)),
    (() => {
      const empty = sc.entities[key].filter((s) => !s.items.some((x) => x.live) && Math.abs(s.xero[state.period] || 0) <= 0.005);
      return empty.length ? h('p', { class: 'comment' }, `Nothing on ${empty.map(regTitle).join(', ').toLowerCase()} this month (nil in Xero too).`) : null;
    })(),
  ];
}

// ---------- feedback
async function loadFeedback() {
  try { state.feedback = (await api('GET', '/feedback')).feedback; render(); } catch (err) { toast(err.message, true); }
}
function contextNow() {
  const tab = { ltd: ENTITY.ltd.label, inc: ENTITY.inc.label }[state.tab] || state.tab;
  const open = [...state.open].map((x) => x.split('|')[1]);
  return `${monthName(state.period)} · ${tab}${open.length ? ` · ${open.join(', ')}` : ''}`;
}
function openFeedback() {
  const dlg = document.getElementById('feedback-dialog');
  const ctx = contextNow();
  const kind = h('select', { id: 'fb-kind', class: 'field' }, h('option', { value: 'idea' }, 'Idea or improvement'), h('option', { value: 'problem' }, 'Something looks wrong'), h('option', { value: 'question' }, 'Question'));
  const ta = h('textarea', { id: 'fb-text', class: 'field', rows: '6', placeholder: 'What would make this better? Be as specific as you like: an account, a number, a step that was awkward.' });
  const send = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send suggestion');
  const form = h('form', { method: 'dialog', class: 'fb-form', onsubmit: async (ev) => {
    ev.preventDefault();
    if (!ta.value.trim()) { ta.focus(); return; }
    send.disabled = true;
    try {
      await api('POST', '/feedback', { kind: kind.value, text: ta.value, context: ctx });
      dlg.close();
      toast('Thanks, suggestion sent.');
      loadFeedback();
    } catch (err) { toast(err.message, true); send.disabled = false; }
  } },
  h('h2', {}, 'Suggest an improvement'),
  h('p', { class: 'comment' }, `Sent with where you are: ${ctx}`),
  h('label', { for: 'fb-kind' }, 'Type'), kind,
  h('label', { for: 'fb-text' }, 'Suggestion'), ta,
  h('div', { class: 'row-btns' }, send, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')));
  dlg.replaceChildren(form);
  dlg.showModal();
  ta.focus();
}
const FB_KIND = { idea: 'Idea', problem: 'Something wrong', question: 'Question' };
function feedbackView() {
  const fb = state.feedback;
  if (!fb) return h('p', { class: 'loading' }, 'Loading…');
  const head = h('div', { class: 'toolbar toolbar-left' }, h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: openFeedback }, 'Suggest an improvement'));
  if (!fb.length) return [head, h('div', { class: 'empty-state' }, h('h2', {}, 'No suggestions yet'), h('p', {}, 'Anything that slowed you down this month, or that the old workbook did better, is worth noting.'))];
  return [head, h('ul', { class: 'activity feedback-list' }, fb.map((f) => h('li', {},
    h('div', {}, h('time', { datetime: f.at }, when(f.at)), h('span', { class: `fb-status s-${f.status}` }, f.status)),
    h('div', {},
      h('p', { class: 'fb-text' }, h('strong', {}, `${who(f.by)} · ${FB_KIND[f.kind] || f.kind}`), ` ${f.text}`),
      f.context ? h('span', { class: 'status-word' }, f.context) : null,
      f.reply ? h('p', { class: 'comment' }, `Reply: ${f.reply}`) : null,
      can('admin') ? h('div', { class: 'row-btns' }, ['planned', 'done', 'declined'].filter((s) => s !== f.status).map((s) => h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
          const reply = s === 'declined' ? (prompt('Short reason (optional)') || '') : '';
          try { state.feedback = (await api('POST', `/feedback/${f.id}`, { status: s, reply })).feedback; render(); } catch (err) { toast(err.message, true); }
        },
      }, { planned: 'Mark planned', done: 'Mark done', declined: 'Decline' }[s]))) : null))))];
}

async function init() {
  try {
    state.me = await api('GET', '/me');
  } catch (err) {
    document.getElementById('main').replaceChildren(h('p', { class: 'empty' }, err.message));
    return;
  }
  document.getElementById('period').addEventListener('change', (ev) => loadPeriod(ev.target.value));
  document.getElementById('run').addEventListener('click', runClose);
  document.getElementById('suggest').addEventListener('click', openFeedback);
  api('GET', '/feedback').then((r) => { state.feedback = r.feedback; renderTabs(); }).catch(() => {});
  const fromHash = location.hash.slice(1);
  const { periods } = await api('GET', '/periods');
  const start = /^\d{4}-\d{2}$/.test(fromHash) ? fromHash : (periods[0] || defaultPeriod());
  await loadPeriod(start);
}

init();
