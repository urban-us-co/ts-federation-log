const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('project skill is installed under the Codex agents path', () => {
  assert.ok(fs.existsSync(path.join(root, '.agents/skills/log-usage/SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.agents/skills/log-usage/scripts/log_and_push.sh')));
});

test('setup docs reference the installed log-usage skill path', () => {
  const docs = [
    'README.md',
    'SETUP-ON-NEW-MACHINE.md',
    '.agents/skills/log-usage/SETUP-ON-NEW-MACHINE.md',
    '.agents/skills/log-usage/SKILL.md',
  ];

  for (const file of docs) {
    const text = read(file);
    assert.doesNotMatch(text, /\.claude\/skills\/log-(?:claude-)?usage/);
    assert.doesNotMatch(text, /log-claude-usage/);
  }
});

test('helper opens pull requests from the current skill name', () => {
  const helper = read('.agents/skills/log-usage/scripts/log_and_push.sh');
  assert.match(helper, /log-usage\\` skill/);
  assert.doesNotMatch(helper, /log-claude-usage/);
});
