const assert = require('node:assert/strict');
const test = require('node:test');
const { summarize, isMechanical, isCoding, weekOf } = require('../offload');
const { priceUSD } = require('../session-lib');

const NOW = new Date('2026-11-04T12:00:00Z');

// Synthetic ledger rows; cost is priced the same way the real ledger is.
function row(over) {
  const r = {
    ts: '2026-11-03T10:00:00Z', source: 'cowork', account: 'a/b', session_id: 's1',
    task: 'sched:daily-x', task_kind: 'scheduled', title: 'Daily X', step: 'text',
    query_source: 'main', tool_names: [], model: 'claude-opus-5-5', tier: 'opus',
    input_tokens: 100, output_tokens: 200, cache_read_tokens: 50_000,
    cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0, quota: null, ...over,
  };
  return { ...r, cost_usd: priceUSD(r) };
}
const many = (n, over, sessions = 1) => Array.from({ length: n }, (_, i) => row({ session_id: `s${i % sessions}`, ...over }));

test('step classifiers', () => {
  assert.ok(isMechanical('text'));
  assert.ok(isMechanical('tools:Grep+Read'));
  assert.ok(!isMechanical('tools:Edit+Read'));
  assert.ok(isCoding('tools:Bash+Edit'));
  assert.equal(weekOf('2026-11-04T12:00:00Z'), '2026-11-02'); // Monday
});

test('mechanical short-output work on a top tier -> local-model candidate with full savings', () => {
  const s = summarize(many(25, { step: 'tools:Read+Grep', tool_names: ['Grep', 'Read'] }), { now: NOW });
  const c = s.candidates.find((x) => x.rule === 'local-model');
  assert.ok(c);
  assert.equal(c.est_target_cost_usd, 0);
  assert.equal(c.est_savings_usd, c.cost_usd);
});

test('read-like MCP calls -> script-it; top-tier subagents -> downshift to Haiku', () => {
  const rows = [
    ...many(25, { step: 'mcp:notion-search', output_tokens: 150 }),
    ...many(25, { step: 'subagent:Explore', query_source: 'subagent', output_tokens: 2000 }),
  ];
  const s = summarize(rows, { now: NOW });
  assert.ok(s.candidates.some((c) => c.rule === 'script-it' && c.step === 'mcp:notion-search'));
  const sub = s.candidates.find((c) => c.rule === 'downshift-subagent');
  assert.ok(sub && sub.target === 'claude-haiku-5-5' && sub.est_target_cost_usd < sub.cost_usd);
});

test('recurring top-tier scheduled task -> downshift-scheduled and other-account', () => {
  const s = summarize(many(30, { step: 'tools:Bash+Edit', tool_names: ['Bash', 'Edit'], output_tokens: 800 }, 5), { now: NOW });
  assert.ok(s.candidates.some((c) => c.rule === 'downshift-scheduled' && c.target === 'claude-sonnet-5-5'));
  const acct = s.candidates.find((c) => c.rule === 'other-account');
  assert.equal(acct.token_share, 1);
});

test('small buckets, haiku work and out-of-window rows produce no candidates', () => {
  const rows = [
    ...many(5, { step: 'text' }),
    ...many(25, { step: 'text', model: 'claude-haiku-5-5', tier: 'haiku', task: 'cowork:t', task_kind: 'interactive' }),
    ...many(25, { step: 'text', ts: '2026-08-01T00:00:00Z', task: 'cowork:old', task_kind: 'interactive' }),
  ];
  const s = summarize(rows, { now: NOW });
  assert.deepEqual(s.candidates.filter((c) => c.rule !== 'other-account' && c.rule !== 'downshift-scheduled'), []);
  assert.equal(s.totals.turns, 30); // the August rows are outside the 30-day window
  assert.ok(s.weekly.some((w) => w.week === '2026-07-27')); // ...but still in the weekly trend
});

test('script-it only for API fetches, never shell/browser/desktop servers', () => {
  const { isScriptable } = require('../offload');
  assert.ok(isScriptable('mcp:gmail/get_thread'));
  assert.ok(isScriptable('mcp:connector/notion-fetch'));
  assert.ok(isScriptable('mcp:notion-search'));
  assert.ok(!isScriptable('mcp:claude-in-chrome/find'));
  assert.ok(!isScriptable('mcp:workspace/bash'));
  assert.ok(!isScriptable('mcp:desktop-commander/read_file'));
  assert.ok(!isScriptable('mcp:connector/slack_send_message'));
});

test('limit events surface with their task', () => {
  const s = summarize([row({ quota: { status: 'rejected', rate_limit_type: 'five_hour', is_using_overage: true } })], { now: NOW });
  assert.deepEqual(s.limit_events.map((e) => [e.task, e.status, e.is_using_overage]), [['sched:daily-x', 'rejected', true]]);
});
