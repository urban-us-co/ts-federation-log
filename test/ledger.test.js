const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { scanCowork, scanTranscripts } = require('../session-lib');
const { coworkSessionMeta, buildLedger, stepOf, tierOf } = require('../ledger');

const coworkRoot = path.join(__dirname, 'fixtures', 'cowork');
const projectsRoot = path.join(__dirname, 'fixtures', 'projects');

test('coworkSessionMeta keeps only labelling fields, never prompts or email', () => {
  const meta = coworkSessionMeta(coworkRoot);
  const m = meta.get('cw-session-1');
  assert.deepEqual(Object.keys(m).sort(), ['created_at', 'effort_override', 'parent_session_id', 'scheduled_task_id', 'session_type', 'title']);
  assert.equal(m.scheduled_task_id, 'daily-inbox-triage');
  const text = JSON.stringify([...meta.values()]);
  assert.ok(!/SECRET|person@example|Person/.test(text));
});

test('ledger labels Cowork turns with the scheduled task and steps with subagent/skill/tools', () => {
  const rows = buildLedger(scanCowork(coworkRoot), coworkSessionMeta(coworkRoot));
  assert.ok(rows.every((r) => r.task === 'sched:daily-inbox-triage' && r.task_kind === 'scheduled'));
  assert.equal(rows.find((r) => r.query_source === 'subagent').step, 'subagent:Explore');
  assert.equal(rows.find((r) => r.skill).step, 'skill:anthropic-skills:deal-robot');
  assert.equal(rows.find((r) => r.model.startsWith('claude-sonnet')).step, 'text');
  assert.ok(rows.every((r) => r.account === 'acct-111/org-2222'));
});

test('Claude Code turns are labelled by project folder; tiers map from model ids', () => {
  const rows = buildLedger(scanTranscripts(projectsRoot));
  assert.ok(rows.every((r) => r.task === 'code:/tmp/project' && r.task_kind === 'code'));
  assert.equal(stepOf({ tool_names: ['Read', 'Grep'], query_source: 'main' }), 'tools:Read+Grep');
  assert.equal(stepOf({ tool_names: [], query_source: 'main', attribution_mcp_tool: 'notion-search' }), 'mcp:notion-search');
  const { serverLabel } = require('../ledger');
  assert.deepEqual(['Claude in Chrome', 'claude-in-chrome', 'plugin:desktop-commander:desktop-commander', 'Desktop Commander',
    'claude.ai Gmail', '180b5cb0-536a-46ea-b979-22c19ec683cc'].map(serverLabel),
  ['claude-in-chrome', 'claude-in-chrome', 'desktop-commander', 'desktop-commander', 'gmail', 'connector']);
  assert.deepEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', '<synthetic>'].map(tierOf),
    ['fable', 'opus', 'sonnet', 'haiku', 'other']);
});

test('CLI ledger writes private files outside data/ and refuses data/', () => {
  const root = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const env = { ...process.env, TS_PROJECTS_DIR: projectsRoot, TS_COWORK_DIR: coworkRoot, LEDGER_DIR: tmp, SESSION_USAGE_NOW: '2026-07-10T00:00:00Z' };
  const res = spawnSync(process.execPath, [path.join(root, 'session-usage.js'), 'ledger'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Ledger: 6 turn\(s\)/);
  const lines = fs.readFileSync(path.join(tmp, 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 6);
  const summary = JSON.parse(fs.readFileSync(path.join(tmp, 'summary.json'), 'utf8'));
  assert.equal(summary.totals.turns, 6);

  const bad = spawnSync(process.execPath, [path.join(root, 'session-usage.js'), 'ledger'], {
    cwd: root, env: { ...env, LEDGER_DIR: path.join(root, 'data', 'x') }, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.ok(!fs.existsSync(path.join(root, 'data', 'x')));
});
