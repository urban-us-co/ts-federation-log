// score.js — offload-candidate rules, shared by Node (offload.js) and the private
// Dashboard page (uploaded as files/score.js, where it sets window.umScore).
// One implementation so the page and the ledger summary can't disagree.
// Plain ES2019, no requires: the Dashboard runs scripts without modules.
//
// A bucket is {turns, sessions (number or Set), cost, tokens, output,
// tiers: {tier: turns}, repriced: {model: cost}}.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.umScore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  const round = (v, n = 2) => Number((v || 0).toFixed(n));
  const topKey = (o) => {
    const e = Object.entries(o || {}).sort((a, b) => b[1] - a[1])[0];
    return e ? e[0] : null;
  };
  const topTier = (b) => topKey(b.tiers);
  const sessionCount = (b) => (typeof b.sessions === 'number' ? b.sessions : (b.sessions ? b.sessions.size : 0));

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

  // byTask: Map(task -> bucket); byTaskStep: Map(task + "\u0000" + step -> bucket).
  function candidates(byTask, byTaskStep, totalCost, totalTokens) {
    const out = [];
    const push = (c) => out.push(Object.assign({}, c, {
      cost_usd: round(c.cost_usd), est_target_cost_usd: round(c.est_target_cost_usd),
      est_savings_usd: round(c.cost_usd - c.est_target_cost_usd),
    }));

    for (const [key, b] of byTaskStep) {
      if (b.turns < RULES.minTurns) continue;
      const [task, step] = key.split('\u0000');
      const outPer = b.output / b.turns;
      const tier = topTier(b);
      const onTop = RULES.topTiers.includes(tier);
      const repriced = b.repriced || {};
      if (isMechanical(step) && outPer <= RULES.mechanicalMaxOutputPerTurn && tier !== 'haiku') {
        push({ rule: 'local-model', target: 'local gemma (llm CLI)', task, step, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: 0,
          why: `${b.turns} turns of ${step} averaging ${Math.round(outPer)} output tokens on ${tier} — reading/routing work a local model can do` });
      } else if (isScriptable(step) && outPer <= RULES.mechanicalMaxOutputPerTurn) {
        push({ rule: 'script-it', target: 'deterministic script (no model)', task, step, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: 0,
          why: `${b.turns} turns calling ${step.slice(4)} with short outputs — a fetch a script can do before the model runs` });
      } else if (step.startsWith('subagent:') && onTop) {
        push({ rule: 'downshift-subagent', target: RULES.subagentTarget, task, step, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: repriced[RULES.subagentTarget] || 0,
          why: `${step} runs on ${tier}; search/explore subagents rarely need the top tier` });
      } else if (isCoding(step) && onTop && outPer >= RULES.codingMinOutputPerTurn) {
        push({ rule: 'codex', target: 'Codex / cld-offload worker', task, step, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: 0,
          why: `${b.turns} heavy edit turns (${Math.round(outPer)} output/turn) on ${tier} — fits an offloaded coding worker` });
      }
    }

    for (const [task, b] of byTask) {
      if (!task.startsWith('sched:') || sessionCount(b) < RULES.minScheduledRuns) continue;
      if (RULES.topTiers.includes(topTier(b))) {
        push({ rule: 'downshift-scheduled', target: RULES.downshiftTarget, task, step: null, turns: b.turns, cost_usd: b.cost, est_target_cost_usd: (b.repriced || {})[RULES.downshiftTarget] || 0,
          why: `recurring task (${sessionCount(b)} runs) mostly on ${topTier(b)}; try it on Sonnet 5.5 and compare outputs` });
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

  // Candidates overlap: a whole-task downshift and a step inside the same task
  // both count that step's cost. Per task take the larger of the task-level
  // saving and the sum of its step-level savings, so the headline isn't inflated.
  function savingsEstimate(cands) {
    const perTask = new Map();
    for (const c of cands) {
      const t = perTask.get(c.task) || { whole: 0, steps: 0 };
      if (c.step === null) t.whole = Math.max(t.whole, c.est_savings_usd || 0);
      else t.steps += c.est_savings_usd || 0;
      perTask.set(c.task, t);
    }
    let total = 0;
    for (const t of perTask.values()) total += Math.max(t.whole, t.steps);
    return round(total);
  }

  return { RULES, round, topKey, topTier, sessionCount, isMechanical, isScriptable, isCoding, candidates, savingsEstimate };
}));
