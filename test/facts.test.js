const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFacts, hashStep, toCsv, FACT_COLUMNS } = require('../facts');
const { isScriptable } = require('../score');
const { priceUSD } = require('../session-lib');

function row(over) {
  const r = {
    ts: '2026-11-03T10:15:00Z', source: 'cowork', account: 'aaaa/bbbb', session_id: 'sess-1',
    task: 'sched:daily-inbox-triage', task_kind: 'scheduled', title: 'Daily inbox triage', step: 'skill:anthropic-skills:deal-robot',
    model: 'claude-opus-5-5', tier: 'opus', input_tokens: 10, output_tokens: 100, cache_read_tokens: 1000,
    cache_creation_5m_tokens: 50, cache_creation_1h_tokens: 0, ...over,
  };
  return { ...r, cost_usd: priceUSD(r) };
}
const who = { tenant: 'aaaaaaaaaaaa', machine: 'bbbbbbbbbbbb' };

test('facts aggregate per hour x task x step x model and carry re-priced costs', () => {
  const rows = [row(), row({ ts: '2026-11-03T10:45:00Z' }), row({ ts: '2026-11-03T11:05:00Z', session_id: 'sess-2' })];
  const { facts, sessions } = buildFacts(rows, who, { labels: 'clear' });
  assert.equal(facts.length, 2);
  assert.equal(facts[0].ts_hour, '2026-11-03T10:00Z');
  assert.equal(facts[0].turns, 2);
  assert.equal(facts[0].tokens, 2 * 1160);
  assert.ok(facts[0].cost_sonnet > 0 && facts[0].cost_sonnet < facts[0].cost_usd);
  assert.ok(facts[0].cost_haiku < facts[0].cost_sonnet);
  assert.equal(facts[0].kind, 'scheduled');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].turns, 2);
  assert.equal(sessions[0].first_ts, '2026-11-03T10:15:00Z');
});

test('hashed policy hides task, skill, connector and account names but keeps rule-relevant shape', () => {
  const rows = [
    row(),
    row({ step: 'mcp:gmail/get_thread' }),
    row({ step: 'mcp:claude-in-chrome/find' }),
    row({ step: 'tools:Read+mcp__workspace__bash' }),
    row({ step: 'subagent:Explore', task: 'cowork:Board deck review', task_kind: 'interactive' }),
  ];
  const { facts, sessions } = buildFacts(rows, who, { labels: 'hashed', salt: 's3cret' });
  const text = JSON.stringify({ facts, sessions });
  for (const secret of ['daily-inbox-triage', 'deal-robot', 'gmail', 'get_thread', 'chrome', 'workspace', 'Board deck', 'aaaa/bbbb', 'sess-1']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  const steps = new Set(facts.map((f) => f.step));
  assert.ok([...steps].some((s) => /^mcp:x[0-9a-f]{12}\/read$/.test(s)));
  assert.ok([...steps].some((s) => /^mcp:x[0-9a-f]{12}\/interactive$/.test(s)));
  assert.ok(steps.has('tools:Read+mcp'));
  assert.ok(steps.has('subagent:Explore'));
  assert.ok(facts.every((f) => /^(sched|cowork|dispatch|code):x[0-9a-f]{12}$/.test(f.task)));
  // script-it still fires on a hashed read-like connector step, not on a browser one
  assert.ok(isScriptable(hashStep('mcp:gmail/get_thread', 's')));
  assert.ok(!isScriptable(hashStep('mcp:claude-in-chrome/find', 's')));
});

test('hashing is salted: same label, different person, different hash', () => {
  assert.notEqual(hashStep('skill:anthropic-skills:x', 'salt-a'), hashStep('skill:anthropic-skills:x', 'salt-b'));
  assert.equal(hashStep('skill:anthropic-skills:x', 'salt-a'), hashStep('skill:anthropic-skills:x', 'salt-a'));
});

test('CSV quotes commas and quotes, header first', () => {
  const csv = toCsv([{ ts_hour: 'h', task: 'cowork:a, "b"', turns: 1 }], FACT_COLUMNS);
  const [head, line] = csv.trim().split('\n');
  assert.equal(head, FACT_COLUMNS.join(','));
  assert.match(line, /"cowork:a, ""b"""/);
});
