const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { scanTranscripts } = require('../session-lib');

const fixtureRoot = path.join(__dirname, 'fixtures', 'projects');

test('scanTranscripts dedupes assistant blocks by requestId and unions tool uses', () => {
  const turns = scanTranscripts(fixtureRoot);
  const mainTurns = turns.filter((turn) => turn.query_source === 'main');

  assert.equal(mainTurns.length, 2);
  assert.deepEqual(mainTurns.map((turn) => turn.request_id), ['req-main-1', 'req-main-2']);
  assert.equal(mainTurns.reduce((sum, turn) => sum + turn.output_tokens, 0), 700);

  const first = mainTurns[0];
  assert.equal(first.model, 'claude-opus-4-8');
  assert.equal(first.entrypoint, 'claude-desktop');
  assert.deepEqual(first.tool_names, ['Bash', 'Read']);
  assert.equal(first.attribution_skill, 'anthropic-skills:deal-robot');
  assert.equal(first.attribution_plugin, 'anthropic-skills');
  assert.equal(first.attribution_mcp_server, null);
  assert.equal(first.attribution_mcp_tool, null);
});

test('scanTranscripts tags subagent turns and rolls them under parent sessionId', () => {
  const turns = scanTranscripts(fixtureRoot);
  const subagent = turns.find((turn) => turn.query_source === 'subagent');

  assert.ok(subagent);
  assert.equal(subagent.session_id, 'session-main');
  assert.equal(subagent.transcript_session_id, 'agent-session-1');
  assert.equal(subagent.agent_type, 'general-purpose');
  assert.equal(subagent.model, 'claude-sonnet-4-20260701');
  assert.deepEqual(subagent.tool_names, ['Edit']);
  assert.equal(subagent.attribution_mcp_server, 'github');
  assert.equal(subagent.attribution_mcp_tool, 'create_issue');
});
