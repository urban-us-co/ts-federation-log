// offload.js — where usage goes + what could move elsewhere (2026-11 revival, P4).
//
// Input: private ledger rows (ledger.js). Output: a summary object with totals,
// weekly trend, top tasks/steps, limit events, and ranked offload CANDIDATES.
// Candidates are heuristics, not verdicts: every one carries the numbers and the
// rule that fired so a human can judge it. Thresholds live in RULES so they can
// be tuned against reality without touching the logic.

const { priceUSD } = require('./session-lib');

const RULES = {
  minTurns: 20, // ignore tiny buckets — not worth moving
  mechanicalMaxOutputPerTurn: 600, // short answers = reading/routing, not reasoning
  codingMinOutputPerTurn: 1500,
  minScheduledRuns: 3,
  topTiers: ['opus', 'fable'],
  mechanicalTools: ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'NotebookRead'],
  codingTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  readLikeMcp: /(^|[-_])(search|fetch|get|list|read|query|find)([-_]|$)/i,
  // Driving a shell, a browser or the desktop is interactive work, not an API
  // fetch a script could do up front — never a script-it candidate.
  interactiveMcpServers: /chrome|browser|desktop-commander|workspace|control-your-mac|cowork/i,
  downshiftTarget: 'claude-sonnet-5-5',
  subagentTarget: 'claude-haiku-5-5',
  accountMoveTop: 5,
};

const tokensOf = (r) => (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) +
  (r.cache_creation_5m_tokens || 0) + (r.cache_creation_1h_tokens || 0);

function weekOf(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

function bucket() {
  return { turns: 0, sessions: new Set(), cost: 0, tokens: 0, output: 0, tiers: {}, steps: {}, tools: {}, repriced: {} };
}

function add(b, r) {
  b.turns += 1;
  b.sessions.add(r.session_id);
  b.cost += r.cost_usd || 0;
  b.tokens += tokensOf(r);
  b.output += r.output_tokens || 0;
  b.tiers[r.tier] = (b.tiers[r.tier] || 0) + 1;
  b.steps[r.step] = (b.steps[r.step] || 0) + (r.cost_usd || 0);
  for (const t of r.tool_names || []) b.tools[t] = (b.tools[t] || 0) + 1;
  for (const target of [RULES.downshiftTarget, RULES.subagentTarget]) {
    b.repriced[target] = (b.repriced[target] || 0) + (priceUSD({ ...r, model: target }) || 0);
  }
}

const round = (v, n = 2) => Number((v || 0).toFixed(n));
const topKey = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
const topTier = (b) => topKey(b.tiers);

function finish(key, b, totalCost) {
  return {
    key,
    turns: b.turns,
    sessions: b.sessions.size,
    cost_usd: round(b.cost),
    cost_share: totalCost ? round(b.cost / totalCost, 4) : 0,
    tokens: b.tokens,
    output_per_turn: Math.round(b.output / Math.max(b.turns, 1)),
    main_tier: topTier(b),
    main_step: topKey(b.steps),
  };
}

function isMechanical(step) {
  if (step === 'text') return true;
  if (!step.startsWith('tools:')) return false;
  return step.slice(6).split('+').every((t) => RULES.mechanicalTools.includes(t));
}

// step = "mcp:<server>/<tool>" or "mcp:<tool>"
function isScriptable(step) {
  if (!step.startsWith('mcp:')) return false;
  const body = step.slice(4);
  const slash = body.indexOf('/');
  const server = slash === -1 ? '' : body.slice(0, slash);
  const tool = slash === -1 ? body : body.slice(slash + 1);
  return !RULES.interactiveMcpServers.test(server) && RULES.readLikeMcp.test(tool);
}

function isCoding(step) {
  return step.startsWith('tools:') && step.slice(6).split('+').some((t) => RULES.codingTools.includes(t));
}

function candidates(byTask, byTaskStep, totalCost, totalTokens) {
  const out = [];
  const push = (c) => out.push({ ...c, cost_usd: round(c.cost_usd), est_target_cost_usd: round(c.est_target_cost_usd), est_savings_usd: round(c.cost_usd - c.est_target_cost_usd) });

  for (const [key, b] of byTaskStep) {
    if (b.turns < RULES.minTurns) continue;
    const [task, step] = key.split('\u0000');
    const outPer = b.output / b.turns;
    const tier = topTier(b);
    const onTop = RULES.topTiers.includes(tier);
    if (isMechanical(step) && outPer <= RULES.mechanicalMaxOutputPerTurn && tier !== 'haiku') {
      push({ rule: 'local-model', target: 'local gemma (llm CLI)', task, step, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: 0,
        why: `${b.turns} turns of ${step} averaging ${Math.round(outPer)} output tokens on ${tier} — reading/routing work a local model can do` });
    } else if (isScriptable(step) && outPer <= RULES.mechanicalMaxOutputPerTurn) {
      push({ rule: 'script-it', target: 'deterministic script (no model)', task, step, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: 0,
        why: `${b.turns} turns calling ${step.slice(4)} with short outputs — a fetch a script can do before the model runs` });
    } else if (step.startsWith('subagent:') && onTop) {
      push({ rule: 'downshift-subagent', target: RULES.subagentTarget, task, step, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: b.repriced[RULES.subagentTarget],
        why: `${step} runs on ${tier}; search/explore subagents rarely need the top tier` });
    } else if (isCoding(step) && onTop && outPer >= RULES.codingMinOutputPerTurn) {
      push({ rule: 'codex', target: 'Codex / cld-offload worker', task, step, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: 0,
        why: `${b.turns} heavy edit turns (${Math.round(outPer)} output/turn) on ${tier} — fits an offloaded coding worker` });
    }
  }

  for (const [task, b] of byTask) {
    if (!task.startsWith('sched:') || b.sessions.size < RULES.minScheduledRuns) continue;
    if (RULES.topTiers.includes(topTier(b))) {
      push({ rule: 'downshift-scheduled', target: RULES.downshiftTarget, task, step: null, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: b.repriced[RULES.downshiftTarget],
        why: `recurring task (${b.sessions.size} runs) mostly on ${topTier(b)}; try it on Sonnet 5.5 and compare outputs` });
    }
  }

  // Limit headroom, not dollars: the biggest recurring tasks are the ones worth
  // running from another Cowork account.
  [...byTask].filter(([task]) => task.startsWith('sched:'))
    .sort((a, b) => b[1].tokens - a[1].tokens).slice(0, RULES.accountMoveTop)
    .forEach(([task, b]) => out.push({
      rule: 'other-account', target: 'second Cowork account', task, step: null, turns: b.turns,
      cost_usd: round(b.cost), est_target_cost_usd: round(b.cost), est_savings_usd: 0,
      token_share: totalTokens ? round(b.tokens / totalTokens, 4) : 0,
      why: `${round(100 * b.tokens / Math.max(totalTokens, 1), 1)}% of all tokens in the window; moving it frees that much limit on this account`,
    }));

  return out.sort((a, b) => b.est_savings_usd - a.est_savings_usd || (b.token_share || 0) - (a.token_share || 0));
}

function summarize(rows, { now = new Date(), days = 30 } = {}) {
  const since = new Date(now.getTime() - days * 86400e3).toISOString();
  const windowRows = rows.filter((r) => r.ts && r.ts >= since);

  const weekly = new Map();
  for (const r of rows) {
    if (!r.ts) continue;
    const k = `${weekOf(r.ts)}|${r.source}`;
    const w = weekly.get(k) || { week: weekOf(r.ts), source: r.source, cost_usd: 0, tokens: 0, turns: 0 };
    w.cost_usd += r.cost_usd || 0;
    w.tokens += tokensOf(r);
    w.turns += 1;
    weekly.set(k, w);
  }

  const byTask = new Map();
  const byStep = new Map();
  const byTaskStep = new Map();
  const bySource = new Map();
  const byTier = new Map();
  let totalCost = 0;
  let totalTokens = 0;
  for (const r of windowRows) {
    totalCost += r.cost_usd || 0;
    totalTokens += tokensOf(r);
    for (const [map, key] of [[byTask, r.task], [byStep, r.step], [byTaskStep, `${r.task}\u0000${r.step}`], [bySource, r.account], [byTier, r.tier]]) {
      if (!map.has(key)) map.set(key, bucket());
      add(map.get(key), r);
    }
  }

  const ranked = (map, n) => [...map].map(([k, b]) => finish(k, b, totalCost)).sort((a, b) => b.cost_usd - a.cost_usd).slice(0, n);
  const taskTitle = new Map(windowRows.filter((r) => r.title).map((r) => [r.task, r.title]));

  return {
    generated_at: now.toISOString(),
    window_days: days,
    since,
    note: 'Costs are API list prices (what this usage would cost on the API). On a subscription seat, cash cost is the seat plus any extra-usage charges.',
    totals: { turns: windowRows.length, cost_usd: round(totalCost), tokens: totalTokens, sessions: new Set(windowRows.map((r) => r.session_id)).size },
    by_account: ranked(bySource, 20),
    by_tier: ranked(byTier, 10),
    weekly: [...weekly.values()].map((w) => ({ ...w, cost_usd: round(w.cost_usd) })).sort((a, b) => a.week.localeCompare(b.week) || a.source.localeCompare(b.source)),
    top_tasks: ranked(byTask, 40).map((t) => ({ ...t, title: taskTitle.get(t.key) || null })),
    top_steps: ranked(byStep, 40),
    limit_events: windowRows.filter((r) => r.quota).map((r) => ({ ts: r.ts, task: r.task, ...r.quota })),
    candidates: candidates(byTask, byTaskStep, totalCost, totalTokens),
    rules: { ...RULES, readLikeMcp: String(RULES.readLikeMcp), interactiveMcpServers: String(RULES.interactiveMcpServers) },
  };
}

module.exports = { summarize, RULES, isMechanical, isCoding, isScriptable, weekOf, tokensOf };
