const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { CAVEAT } = require('../session-usage');
const { validateRows } = require('../session-lib');

const root = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'projects');
const cli = path.join(root, 'session-usage.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      TS_PROJECTS_DIR: fixtureRoot,
      TS_FED_IDENTITY: 'person@example.test',
      SESSION_USAGE_NOW: '2026-07-09T22:15:00.000Z',
      ...env,
    },
    encoding: 'utf8',
  });
}

test('report --by=skill prints table and caveat', () => {
  const res = run(['report', '--by=skill']);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Session usage report by skill/);
  assert.match(res.stdout, new RegExp(CAVEAT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(res.stdout, /anthropic-skills:deal-robot\t1\t10\t500/);
  assert.match(res.stdout, /direct\t1\t4\t200/);
});

test('import appends closed-hour public rows once and validate accepts them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-usage-cli-'));
  const log = path.join(tmp, 'session-usage-log.jsonl');

  const first = run(['import'], { SESSION_LOG_FILE: log });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Imported 3 new row\(s\), skipped 0 dup\(s\)/);

  const second = run(['import'], { SESSION_LOG_FILE: log });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Imported 0 new row\(s\), skipped 3 dup\(s\)/);

  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.deepEqual(validateRows(rows), []);
  assert.ok(rows.every((row) => row.ts_hour === '2026-07-09T21:00:00Z'));

  const valid = run(['validate', log], { SESSION_LOG_FILE: log });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Validated 3 row\(s\)\./);
});
