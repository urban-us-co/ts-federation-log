// facts.js — filterable rows for the private Dashboard (2026-11, multitenant).
//
// The page filters by date, time of day, session type, person and account, so it
// needs rows at a fine grain instead of fixed-window totals:
//   facts    — one row per UTC hour × person × machine × account × session type ×
//              task × step × model, with tokens by class, API-priced cost and the
//              same tokens re-priced on the two downshift targets.
//   sessions — one row per session × UTC day (distinct-session counts can't be
//              summed from facts, so the page counts these instead).
// Labels follow the person's policy: "clear" (your own machines) or "hashed"
// (anyone else). Hashing is an HMAC with that person's own secret salt, so task
// names can't be recovered by guessing and hashing likely names.

const crypto = require('crypto');
const { priceUSD } = require('./session-lib');
const { RULES } = require('./score');

const KIND_PREFIX = { scheduled: 'sched', interactive: 'cowork', dispatched: 'dispatch', code: 'code' };

function hmacLabel(salt, value) {
  return 'x' + crypto.createHmac('sha256', String(salt)).update(String(value)).digest('hex').slice(0, 12);
}

function isMcpToolName(t) {
  return /^mcp__/.test(t);
}

// Rule-relevant shape survives hashing: an MCP step keeps whether it reads,
// acts, or drives a shell/browser, so script-it still works on hashed rows.
function mcpClass(step) {
  const body = step.slice(4);
  const slash = body.indexOf('/');
  const server = slash === -1 ? '' : body.slice(0, slash);
  const tool = slash === -1 ? body : body.slice(slash + 1);
  if (RULES.interactiveMcpServers.test(server)) return { server, cls: 'interactive' };
  return { server, cls: RULES.readLikeMcp.test(tool) ? 'read' : 'act' };
}

function hashStep(step, salt) {
  if (!step) return step;
  if (step === 'text') return step;
  if (step.startsWith('tools:')) {
    // Built-in tool names are generic; connector tool names reveal integrations.
    const tools = step.slice(6).split('+').map((t) => (isMcpToolName(t) ? 'mcp' : t));
    return `tools:${[...new Set(tools)].sort().join('+')}`;
  }
  if (step.startsWith('subagent:')) {
    const type = step.slice(9);
    return type.includes(':') ? `subagent:${hmacLabel(salt, type)}` : step;
  }
  if (step.startsWith('skill:')) return `skill:${hmacLabel(salt, step.slice(6))}`;
  if (step.startsWith('mcp:')) {
    const { server, cls } = mcpClass(step);
    return `mcp:${hmacLabel(salt, server || 'unknown')}/${cls}`;
  }
  return hmacLabel(salt, step);
}

function hashTask(task, kind, salt) {
  const prefix = KIND_PREFIX[kind] || 'task';
  return `${prefix}:${hmacLabel(salt, task)}`;
}

// policy: {labels: 'clear'|'hashed', salt}
function privatize(row, policy) {
  if (!policy || policy.labels !== 'hashed') return row;
  if (!policy.salt) throw new Error('hashed labels need a salt');
  return {
    ...row,
    task: hashTask(row.task, row.task_kind, policy.salt),
    step: hashStep(row.step, policy.salt),
    account: hmacLabel(policy.salt, row.account),
    title: null,
  };
}

const hourOf = (ts) => `${String(ts).slice(0, 13)}:00Z`;
const dayOf = (ts) => String(ts).slice(0, 10);
const r6 = (v) => Number((v || 0).toFixed(6));

// ledgerRows: ledger.js rows (clear labels). who: {tenant, machine}.
function buildFacts(ledgerRows, who, policy) {
  const facts = new Map();
  const sessions = new Map();
  for (const raw of ledgerRows) {
    if (!raw.ts) continue;
    const r = privatize(raw, policy);
    const kind = raw.task_kind || 'code';
    const cw = (r.cache_creation_5m_tokens || 0) + (r.cache_creation_1h_tokens || 0);
    const tokens = (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + cw;
    const fk = [hourOf(r.ts), r.account, kind, r.task, r.step, r.model].join('\u0000');
    let f = facts.get(fk);
    if (!f) {
      f = {
        ts_hour: hourOf(r.ts), tenant: who.tenant, machine: who.machine, account: r.account, kind,
        task: r.task, step: r.step, model: r.model || 'unknown', tier: r.tier,
        turns: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0,
        cost_usd: 0, cost_sonnet: 0, cost_haiku: 0,
      };
      facts.set(fk, f);
    }
    f.turns += 1;
    f.input += r.input_tokens || 0;
    f.output += r.output_tokens || 0;
    f.cache_read += r.cache_read_tokens || 0;
    f.cache_write += cw;
    f.tokens += tokens;
    f.cost_usd += r.cost_usd || 0;
    f.cost_sonnet += priceUSD({ ...raw, model: RULES.downshiftTarget }) || 0;
    f.cost_haiku += priceUSD({ ...raw, model: RULES.subagentTarget }) || 0;

    const sid = policy && policy.labels === 'hashed' ? hmacLabel(policy.salt, raw.session_id) : hmacLabel('session', raw.session_id);
    const sk = [dayOf(r.ts), sid].join('\u0000');
    let s = sessions.get(sk);
    if (!s) {
      s = { day: dayOf(r.ts), tenant: who.tenant, machine: who.machine, account: r.account, kind, task: r.task, session: sid,
        turns: 0, tokens: 0, cost_usd: 0, first_ts: r.ts, last_ts: r.ts };
      sessions.set(sk, s);
    }
    s.turns += 1;
    s.tokens += tokens;
    s.cost_usd += r.cost_usd || 0;
    if (r.ts < s.first_ts) s.first_ts = r.ts;
    if (r.ts > s.last_ts) s.last_ts = r.ts;
  }
  const fin = (o) => ({ ...o, cost_usd: r6(o.cost_usd), ...(o.cost_sonnet !== undefined ? { cost_sonnet: r6(o.cost_sonnet), cost_haiku: r6(o.cost_haiku) } : {}) });
  return {
    facts: [...facts.values()].map(fin).sort((a, b) => a.ts_hour.localeCompare(b.ts_hour)),
    sessions: [...sessions.values()].map(fin).sort((a, b) => a.day.localeCompare(b.day)),
  };
}

const FACT_COLUMNS = ['ts_hour', 'tenant', 'machine', 'account', 'kind', 'task', 'step', 'model', 'tier', 'turns', 'input', 'output', 'cache_read', 'cache_write', 'tokens', 'cost_usd', 'cost_sonnet', 'cost_haiku'];
const SESSION_COLUMNS = ['day', 'tenant', 'machine', 'account', 'kind', 'task', 'session', 'turns', 'tokens', 'cost_usd', 'first_ts', 'last_ts'];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

function splitByDay(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const d = String(r[key]).slice(0, 10);
    if (!out.has(d)) out.set(d, []);
    out.get(d).push(r);
  }
  return out;
}

module.exports = { buildFacts, privatize, hashStep, hashTask, hmacLabel, toCsv, splitByDay, FACT_COLUMNS, SESSION_COLUMNS, KIND_PREFIX };
