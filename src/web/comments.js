// Comments pinned to places on the dashboard (an account row, a journal, a
// schedule item or a single month in it), plus general suggestions.
//
// Stored in the feedback log (store.addFeedback): a top-level comment has an
// `anchor`; a reply has `parent`. The export turns the open ones into a
// Markdown brief that can be pasted back to Claude to make the improvements.

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (p) => (/^\d{4}-\d{2}$/.test(p || '') ? `${MON[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}` : '');
const KIND = { idea: 'Idea', problem: 'Something wrong', question: 'Question' };
const TAB = { ltd: 'Emperia Ltd', inc: 'Emperia VR Inc', schedules: 'Schedules', journals: 'Journals', activity: 'Activity', feedback: 'Comments' };
const OPEN = new Set(['new', 'planned']);

const clip = (v, max) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

/** Validate an anchor sent by the browser. Returns null for a general comment. */
function cleanAnchor(a) {
  if (!a || typeof a !== 'object' || !a.key) return null;
  return {
    key: clip(a.key, 200),
    label: clip(a.label, 300) || clip(a.key, 200),
    col: clip(a.col, 60) || null,
    tab: Object.prototype.hasOwnProperty.call(TAB, a.tab) ? a.tab : null,
    entity: ['ltd', 'inc'].includes(a.entity) ? a.entity : null,
  };
}

/** Top-level comments with their replies, newest first. */
function threads(all) {
  const replies = new Map();
  for (const f of all) {
    if (!f.parent) continue;
    if (!replies.has(f.parent)) replies.set(f.parent, []);
    replies.get(f.parent).push(f);
  }
  return all.filter((f) => !f.parent).map((f) => ({
    ...f,
    replies: (replies.get(f.id) || []).sort((a, b) => a.at.localeCompare(b.at)),
  }));
}

function where(t) {
  const a = t.anchor;
  if (!a) return 'General';
  return [a.label, a.col].filter(Boolean).join(' › ');
}

/** Markdown brief of comments, oldest first so the list reads in order. */
function toMarkdown(all, { status = 'open', appUrl = '' } = {}) {
  const list = threads(all)
    .filter((t) => (status === 'all' ? true : OPEN.has(t.status)))
    .sort((a, b) => a.at.localeCompare(b.at));
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const out = [
    `# Emperia close dashboard: ${status === 'all' ? 'all' : 'open'} comments`,
    '',
    `Exported ${stamp} UTC. ${list.length} comment${list.length === 1 ? '' : 's'}.${appUrl ? ` App: ${appUrl}` : ''}`,
    '',
    'Each comment says where on the dashboard it was left (page › item › column), the close month it was looking at, and who left it.',
    '',
  ];
  list.forEach((t, i) => {
    const a = t.anchor || {};
    out.push(`## ${i + 1}. ${KIND[t.kind] || 'Comment'}: ${where(t)}`);
    const meta = [
      a.tab ? `Page: ${TAB[a.tab]}` : null,
      t.period ? `Month: ${monthName(t.period)}` : null,
      `By ${t.by} on ${t.at.slice(0, 10)}`,
      `Status: ${t.status}`,
    ].filter(Boolean).join(' · ');
    out.push(meta, '');
    out.push(...String(t.text).split('\n').map((l) => `> ${l}`));
    for (const r of t.replies) out.push('', `Reply from ${r.by} (${r.at.slice(0, 10)}): ${r.text}`);
    if (t.reply) out.push('', `Admin note: ${t.reply}`);
    out.push('', `<sub>ref ${t.id}${a.key ? ` · anchor ${a.key}` : ''}</sub>`, '');
  });
  if (!list.length) out.push('_Nothing open._', '');
  return out.join('\n');
}

module.exports = { cleanAnchor, threads, toMarkdown, OPEN };
