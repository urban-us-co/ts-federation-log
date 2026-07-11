const assert = require('node:assert/strict');
const test = require('node:test');
const {
  anonId,
  categorize,
  priceUSD,
  redactLabel,
  rollupClosedHours,
  validateRows,
} = require('../session-lib');

test('priceUSD prices known model prefixes and returns null for unknown models', () => {
  const expensive = {
    model: 'claude-opus-4-20260701',
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 1_000_000,
    cache_creation_5m_tokens: 1_000_000,
    cache_creation_1h_tokens: 1_000_000,
  };
  assert.equal(priceUSD(expensive), 140.25);
  assert.equal(priceUSD({ ...expensive, model: 'claude-sonnet-4-1', cache_read_tokens: 0, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0 }), 18);
  assert.equal(priceUSD({ ...expensive, model: 'claude-haiku-4', cache_read_tokens: 0, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0 }), 6);
  // Fable 5: 10 input + 50 output + 1 cache-read + 12.5 cw5m + 20 cw1h per 1M each = 93.5
  assert.equal(priceUSD({ ...expensive, model: 'claude-fable-5' }), 93.5);
  // Genuinely unknown model that consumed tokens stays null (honestly unknown).
  assert.equal(priceUSD({ ...expensive, model: 'claude-unknown-9' }), null);
  // Unknown model with zero billable tokens (e.g. `<synthetic>`) costs $0, not null.
  assert.equal(priceUSD({ model: '<synthetic>', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0 }), 0);
});

test('redactLabel hashes namespaced labels and keeps bare labels', () => {
  assert.equal(redactLabel('anthropic-skills:x'), `x:${anonId('anthropic-skills:x')}`);
  assert.equal(redactLabel('loop'), 'loop');
  assert.equal(redactLabel(null), null);
});

test('categorize prefers skill over mcp over direct', () => {
  assert.deepEqual(categorize({ attribution_skill: 'loop', attribution_mcp_server: 'db', attribution_mcp_tool: 'query' }), {
    category: 'skill',
    label: 'loop',
  });
  assert.deepEqual(categorize({ attribution_mcp_server: 'db', attribution_mcp_tool: 'query' }), {
    category: 'mcp',
    label: 'mcp/db/query',
  });
  assert.deepEqual(categorize({}), { category: 'direct', label: 'direct' });
});

test('rollupClosedHours groups by public key, sums usage, and excludes current hour', () => {
  const base = {
    session_id: 'session-1',
    entrypoint: 'claude-desktop',
    query_source: 'main',
    agent_type: null,
    model: 'claude-sonnet-4',
    attribution_skill: 'anthropic-skills:x',
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_creation_tokens: 40,
    cache_creation_5m_tokens: 40,
    cache_creation_1h_tokens: 0,
  };
  const turns = [
    { ...base, timestamp: '2026-07-09T21:05:00.000Z', cost_usd: 0.001 },
    { ...base, timestamp: '2026-07-09T21:45:00.000Z', cost_usd: 0.002 },
    { ...base, timestamp: '2026-07-09T22:05:00.000Z', cost_usd: 0.003 },
  ];

  const rows = rollupClosedHours(turns, new Date('2026-07-09T22:15:00.000Z'), 'person@example.test');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts_hour, '2026-07-09T21:00:00Z');
  assert.equal(rows[0].turns, 2);
  assert.equal(rows[0].input_tokens, 20);
  assert.equal(rows[0].output_tokens, 40);
  assert.equal(rows[0].cache_read_tokens, 60);
  assert.equal(rows[0].cache_creation_tokens, 80);
  assert.equal(rows[0].cost_usd, 0.003);
  assert.equal(rows[0].label, `x:${anonId('anthropic-skills:x')}`);
  assert.equal(rows[0].user_id, anonId('person@example.test'));
});

test('validateRows reports emails and unhashed colon labels', () => {
  const violations = validateRows([
    { label: 'ok', user_name: 'person@example.test' },
    { label: 'anthropic-skills:x' },
  ]);

  assert.deepEqual(violations.map((v) => v.reason), ['email', 'unhashed-colon-label']);
});
