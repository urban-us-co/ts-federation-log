const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanTranscripts } = require('../session-lib');

// Regression for ERR_STRING_TOO_LONG on ~700MB transcripts: the reader must stream
// and stitch lines across 1MB chunk boundaries, including a final line with no newline.
test('streamed reader handles multi-MB lines spanning chunks and a missing final newline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-stream-'));
  const proj = path.join(dir, 'p');
  fs.mkdirSync(proj);
  const assistant = (id, pad) => JSON.stringify({
    type: 'assistant', requestId: id, sessionId: 's', timestamp: '2026-07-09T21:00:00.000Z',
    message: { id, model: 'claude-haiku-4', content: [{ type: 'text', text: pad }], usage: { input_tokens: 1, output_tokens: 2 } },
  });
  const bigUser = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2_500_000) } });
  const body = [assistant('r1', 'a'), bigUser, assistant('r2', 'b'.repeat(1_500_000)), assistant('r3', 'c')].join('\n');
  fs.writeFileSync(path.join(proj, 's.jsonl'), body); // no trailing newline

  const turns = scanTranscripts(dir);
  assert.deepEqual(turns.map((t) => t.request_id), ['r1', 'r2', 'r3']);
  assert.ok(turns.every((t) => t.output_tokens === 2));
});
