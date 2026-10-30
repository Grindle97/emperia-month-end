// Claude, used in two places:
//   1. "Ask" on a journal (or the whole close): answers questions about the
//      journal with the account's reconciliation and schedule as context, and
//      can suggest replacement journal lines, which a person must apply.
//   2. Reading an uploaded bank statement to find the closing balance, which
//      a person must confirm before it is saved.
//
// Claude never posts anything and never changes data on its own: everything it
// returns is shown to a person first. Off unless ANTHROPIC_API_KEY is set (use
// a key for Emperia's workspace, not another client's).

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    client = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const configured = () => Boolean(process.env.ANTHROPIC_API_KEY);

function notConfigured() {
  return Object.assign(new Error('The assistant is off: set ANTHROPIC_API_KEY (an Emperia API key) to turn it on.'), { status: 503 });
}

const SYSTEM = `You are a careful month-end close assistant for Emperia, a two-entity group:
Emperia Ltd (UK, GBP, FRS 102) and Emperia VR Inc (US, USD, US GAAP). Inc owes Ltd an intercompany balance in USD; Ltd revalues it at the month-end rate.
You help the finance team review proposed journals and reconciliations before anything is posted to Xero.
Rules:
- Be concise and specific: name accounts, amounts and dates. Short paragraphs or a few bullets.
- Journals must balance (total debits = total credits). Use only account names from the chart of accounts provided.
- If the user asks for a change to the journal, or you think lines are missing or wrong, call suggest_journal_lines with the COMPLETE replacement set of lines. A person reviews and applies it; you are not posting anything.
- If something cannot be judged from the data given, say what to check and where (e.g. the supplier invoice, the bank statement, the contract).
- Never invent figures. Distinguish what the data shows from your suggestion.`;

const SUGGEST_TOOL = {
  name: 'suggest_journal_lines',
  description: 'Propose a complete replacement set of journal lines for the person to review and apply. Must balance.',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            account: { type: 'string', description: 'Exact account name from the chart of accounts' },
            description: { type: 'string' },
            debit: { type: 'number' },
            credit: { type: 'number' },
          },
          required: ['account', 'debit', 'credit'],
        },
      },
      why: { type: 'string', description: 'One or two sentences on what changed and why' },
    },
    required: ['lines', 'why'],
  },
};

function money(n) {
  return Number(n || 0).toFixed(2);
}

function contextText(ctx) {
  const parts = [];
  parts.push(`Close period: ${ctx.period}`);
  if (ctx.journal) {
    const j = ctx.journal;
    parts.push(`\nJOURNAL (${j.entity}, dated ${j.date}): ${j.narration}\nWhy proposed: ${j.reason}${j.posted ? '\nThis journal already appears to be reflected in Xero.' : ''}`);
    parts.push(j.lines.map((l) => `  ${l.account} | ${l.description || ''} | Dr ${money(l.debit)} | Cr ${money(l.credit)}`).join('\n'));
    if (j.originalLines) parts.push('Originally proposed lines:\n' + j.originalLines.map((l) => `  ${l.account} | Dr ${money(l.debit)} | Cr ${money(l.credit)}`).join('\n'));
  }
  for (const r of ctx.rows || []) {
    parts.push(`\nACCOUNT ${r.account} (${r.entity}): Xero ${money(r.xero)}, supporting ${r.supporting === null ? 'n/a' : money(r.supporting)}, difference ${r.difference === null ? 'n/a' : money(r.difference)}, status ${r.status}. ${r.comment || ''}`);
    const lines = r.detail && r.detail.lines;
    if (lines && lines.length && r.detail.register) {
      parts.push(`Schedule (${r.detail.register}):\n` + lines.slice(0, 40).map((l) => `  ${[l.supplier, l.customer, l.description, l.invoiceNumber].filter(Boolean).join(' ')} | ${l.start || ''}-${l.end || ''} | ${l.method} | released this month ${money(l.releasedThisMonth)} | balance ${money(l.balance)} | account ${l.expenseAccount || l.revenueAccount || ''}`).join('\n'));
    }
  }
  if (ctx.summary) parts.push(`\nCLOSE SUMMARY:\n${ctx.summary}`);
  if (ctx.chart && ctx.chart.length) parts.push(`\nCHART OF ACCOUNTS (${ctx.chartEntity}): ${ctx.chart.join('; ')}`);
  return parts.join('\n');
}

/**
 * @returns {Promise<{answer: string, suggestion: {lines, why}|null}>}
 */
async function ask(ctx, question, history = []) {
  const c = getClient();
  if (!c) throw notConfigured();
  const messages = [];
  messages.push({ role: 'user', content: `Context for this conversation:\n${contextText(ctx)}` });
  messages.push({ role: 'assistant', content: 'Understood. What would you like to check?' });
  for (const h of history.slice(-8)) {
    messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text || '(no text)' });
  }
  messages.push({ role: 'user', content: question });
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    ...(ctx.journal ? { tools: [SUGGEST_TOOL] } : {}),
    messages,
  });
  let answer = '';
  let suggestion = null;
  for (const b of res.content || []) {
    if (b.type === 'text') answer += b.text;
    if (b.type === 'tool_use' && b.name === 'suggest_journal_lines') suggestion = b.input;
  }
  if (suggestion) {
    suggestion.lines = (suggestion.lines || []).map((l) => ({
      account: String(l.account || ''), description: String(l.description || ''),
      debit: Math.round((Number(l.debit) || 0) * 100) / 100, credit: Math.round((Number(l.credit) || 0) * 100) / 100,
    }));
    const dr = suggestion.lines.reduce((t, l) => t + l.debit, 0);
    const cr = suggestion.lines.reduce((t, l) => t + l.credit, 0);
    suggestion.balanced = Math.abs(dr - cr) < 0.005;
    if (!answer) answer = suggestion.why || 'Suggested lines below.';
  }
  return { answer: answer.trim(), suggestion, model: MODEL };
}

const BALANCE_TOOL = {
  name: 'report_closing_balance',
  description: 'Report the closing balance shown on the bank statement.',
  input_schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      closingBalance: { type: 'number', description: 'Closing balance at the statement end date; negative if overdrawn or a card balance owed' },
      currency: { type: 'string' },
      statementDate: { type: 'string', description: 'YYYY-MM-DD of the closing balance' },
      accountHint: { type: 'string', description: 'Account name or last digits as printed' },
      note: { type: 'string', description: 'Anything the reviewer should check, e.g. date is not month end' },
    },
    required: ['found'],
  },
};

/**
 * Read a statement and return the closing balance it shows.
 * @param {{buffer: Buffer, mediaType: string, account: string, end: string, currency: string}} f
 */
async function readStatement(f) {
  const c = getClient();
  if (!c) throw notConfigured();
  let block;
  if (f.mediaType === 'application/pdf') {
    block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } };
  } else if (/^image\/(png|jpeg|gif|webp)$/.test(f.mediaType)) {
    block = { type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.buffer.toString('base64') } };
  } else {
    block = { type: 'text', text: `Statement file contents:\n${f.buffer.toString('utf-8').slice(0, 60000)}` };
  }
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: 'You read bank and card statements accurately. Report only what the statement shows.',
    tools: [BALANCE_TOOL],
    tool_choice: { type: 'tool', name: 'report_closing_balance' },
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: `This should be the statement for the Xero bank account "${f.account}" (${f.currency}). Report the closing balance at ${f.end}, or the latest closing balance shown if that date is not on it (and say so in note).` }],
    }],
  });
  const tool = (res.content || []).find((b) => b.type === 'tool_use');
  return tool ? tool.input : { found: false, note: 'No balance returned.' };
}

module.exports = { configured, ask, readStatement, MODEL, contextText };
