// offload.js — where usage goes + what could move elsewhere (2026-11 revival, P4).
//
// Input: private ledger rows (ledger.js). Output: a summary object with totals,
// weekly trend, top tasks/steps, limit events, and ranked offload CANDIDATES.
// Candidates are heuristics, not verdicts: every one carries the numbers and the
// rule that fired so a human can judge it. Thresholds live in RULES so they can
// be tuned against reality without touching the logic.

const { priceUSD } = require('./session-lib');

const {
  RULES, round, topKey, topTier, isMechanical, isScriptable, isCoding, candidates, savingsEstimate,
} = require('./score'); // shared with the Dashboard page

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

// Flat row files for the private Dashboard (one JSON array per dataset).
function dashboardFiles(summary) {
  const kindOf = (key) => key.split(':')[0];
  return {
    totals: [{ ...summary.totals, window_days: summary.window_days, since: summary.since.slice(0, 10), generated_at: summary.generated_at }],
    weekly: summary.weekly,
    tiers: summary.by_tier.map((t) => ({ tier: t.key, cost_usd: t.cost_usd, cost_share: t.cost_share, turns: t.turns, tokens: t.tokens })),
    tasks: summary.top_tasks.map((t) => ({
      task: t.key, kind: kindOf(t.key), title: t.title, sessions: t.sessions, turns: t.turns, cost_usd: t.cost_usd,
      cost_share: t.cost_share, output_per_turn: t.output_per_turn, main_tier: t.main_tier, main_step: t.main_step,
    })),
    steps: summary.top_steps.map((t) => ({
      step: t.key, sessions: t.sessions, turns: t.turns, cost_usd: t.cost_usd, cost_share: t.cost_share,
      output_per_turn: t.output_per_turn, main_tier: t.main_tier,
    })),
    candidates: summary.candidates.map((c, i) => ({
      id: `c${i + 1}`, rule: c.rule, target: c.target, task: c.task, step: c.step || '(whole task)', turns: c.turns,
      cost_usd: c.cost_usd, est_target_cost_usd: c.est_target_cost_usd, est_savings_usd: c.est_savings_usd,
      token_share: c.token_share ?? null, why: c.why,
    })),
  };
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

  const cands = candidates(byTask, byTaskStep, totalCost, totalTokens);
  let scheduledCost = 0;
  for (const [task, b] of byTask) if (task.startsWith('sched:')) scheduledCost += b.cost;

  return {
    generated_at: now.toISOString(),
    window_days: days,
    since,
    note: 'Costs are API list prices (what this usage would cost on the API). On a subscription seat, cash cost is the seat plus any extra-usage charges.',
    totals: {
      turns: windowRows.length, cost_usd: round(totalCost), tokens: totalTokens,
      sessions: new Set(windowRows.map((r) => r.session_id)).size,
      scheduled_cost_usd: round(scheduledCost),
      scheduled_share: totalCost ? round(scheduledCost / totalCost, 4) : 0,
      savings_estimate_usd: savingsEstimate(cands),
    },
    by_account: ranked(bySource, 20),
    by_tier: ranked(byTier, 10),
    weekly: [...weekly.values()].map((w) => ({ ...w, cost_usd: round(w.cost_usd) })).sort((a, b) => a.week.localeCompare(b.week) || a.source.localeCompare(b.source)),
    top_tasks: ranked(byTask, 40).map((t) => ({ ...t, title: taskTitle.get(t.key) || null })),
    top_steps: ranked(byStep, 40),
    limit_events: windowRows.filter((r) => r.quota).map((r) => ({ ts: r.ts, task: r.task, ...r.quota })),
    candidates: cands,
    rules: { ...RULES, readLikeMcp: String(RULES.readLikeMcp), interactiveMcpServers: String(RULES.interactiveMcpServers) },
  };
}

module.exports = { summarize, dashboardFiles, savingsEstimate, RULES, isMechanical, isCoding, isScriptable, weekOf, tokensOf };
