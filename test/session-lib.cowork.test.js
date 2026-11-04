const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { scanCowork, scanAllSources, scanTranscripts, rollupClosedHours, validateRows } = require('../session-lib');

const coworkRoot = path.join(__dirname, 'fixtures', 'cowork');
const projectsRoot = path.join(__dirname, 'fixtures', 'projects');

test('scanCowork reads only .claude/projects transcripts (ignores audit.jsonl and outputs)', () => {
  const turns = scanCowork(coworkRoot);
  const ids = turns.map((t) => t.request_id).sort();
  assert.deepEqual(ids, ['req-cw-1', 'req-cw-2', 'req-cw-sub-1']);
});

test('scanCowork tags source, account/org, effort and server tool counts; dedupes by requestId', () => {
  const turns = scanCowork(coworkRoot);
  const t1 = turns.find((t) => t.request_id === 'req-cw-1');
  assert.equal(t1.source, 'cowork');
  assert.equal(t1.entrypoint, 'local-agent');
  assert.equal(t1.account_uuid, 'acct-1111');
  assert.equal(t1.org_uuid, 'org-2222');
  assert.equal(t1.effort, 'high');
  assert.equal(t1.requested_model, 'claude-opus-4-8');
  assert.equal(t1.output_tokens, 100); // usage repeated on 2 lines, counted once
  assert.deepEqual(t1.tool_names, ['Grep', 'Read']);
  assert.equal(t1.web_search_requests, 2);
  assert.equal(t1.web_fetch_requests, 1);
  assert.equal(t1.quota, null);
});

test('scanCowork keeps quota events and rolls subagents under the parent session', () => {
  const turns = scanCowork(coworkRoot);
  const q = turns.find((t) => t.request_id === 'req-cw-2');
  assert.deepEqual(q.quota, { status: 'allowed_warning', rate_limit_type: 'five_hour', resets_at: 1752100000, is_using_overage: false, overage_status: 'allowed' });
  const sub = turns.find((t) => t.request_id === 'req-cw-sub-1');
  assert.equal(sub.query_source, 'subagent');
  assert.equal(sub.agent_type, 'Explore');
  assert.equal(sub.session_id, 'cw-session-1');
  assert.equal(sub.account_uuid, 'acct-1111');
});

test('Claude Code turns keep their old shape and default source', () => {
  const turns = scanTranscripts(projectsRoot);
  assert.ok(turns.every((t) => t.source === 'claude-code' && t.account_uuid === null));
});

test('scanAllSources: explicit TS_PROJECTS_DIR alone never touches real Cowork data', () => {
  const only = scanAllSources({ TS_PROJECTS_DIR: projectsRoot });
  assert.ok(only.every((t) => t.source === 'claude-code'));
  const both = scanAllSources({ TS_PROJECTS_DIR: projectsRoot, TS_COWORK_DIR: coworkRoot });
  assert.equal(both.filter((t) => t.source === 'cowork').length, 3);
  const off = scanAllSources({ TS_COWORK_DIR: 'off', TS_PROJECTS_DIR: projectsRoot });
  assert.ok(off.every((t) => t.source === 'claude-code'));
});

test('Cowork turns roll up into valid public rows (no account uuid leaks)', () => {
  const rows = rollupClosedHours(scanCowork(coworkRoot), new Date('2026-07-09T23:00:00Z'), 'person@example.test');
  assert.ok(rows.length > 0);
  assert.deepEqual(validateRows(rows), []);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('acct-1111') && !text.includes('org-2222'));
  assert.ok(rows.every((r) => r.entrypoint === 'local-agent'));
});
