const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Point the module at a scratch repo layout BEFORE requiring it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-sync-'));
process.env.LEDGER_DIR = path.join(tmp, 'local');
process.env.TENANTS_DIR = path.join(tmp, 'tenants');
const sync = require('../sync');
const { priceUSD } = require('../session-lib');

function row(over) {
  const r = {
    ts: '2026-11-02T10:15:00Z', source: 'cowork', account: 'aaaa/bbbb', session_id: 's1',
    task: 'sched:daily-inbox-triage', task_kind: 'scheduled', step: 'text', model: 'claude-opus-5-5', tier: 'opus',
    input_tokens: 10, output_tokens: 100, cache_read_tokens: 0, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0, ...over,
  };
  return { ...r, cost_usd: priceUSD(r) };
}
const NOW = new Date('2026-11-04T12:00:00Z');

const fp = sync.initRecipient();
const privPem = fs.readFileSync(path.join(tmp, 'local', 'recipient.key.pem'), 'utf8');

test('envelope round-trips, binds its header, and refuses the wrong key', () => {
  const pub = fs.readFileSync(path.join(tmp, 'tenants', 'recipient.pub.pem'), 'utf8');
  const env = sync.encrypt({ hello: 'world' }, pub, { tenant: 'aaaaaaaaaaaa', machine: 'bbbbbbbbbbbb', day: '2026-11-01' });
  assert.equal(sync.checkEnvelopeText(JSON.stringify(env)), null);
  assert.deepEqual(sync.decrypt(env, privPem), { hello: 'world' });
  assert.throws(() => sync.decrypt({ ...env, day: '2026-11-02' }, privPem)); // header tampered
  const other = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.throws(() => sync.decrypt(env, other.privateKey));
  assert.ok(!JSON.stringify(env).includes('world'));
});

test('initRecipient never replaces an existing key', () => {
  assert.throws(() => sync.initRecipient(), /already exists/);
});

test('push writes closed days only, once, and refuses an unpinned key', () => {
  const tenant = sync.initTenant({ identity: 'other@example.test', name: 'Other', labels: 'hashed', fingerprint: fp });
  const rows = [row(), row({ ts: '2026-11-03T09:00:00Z' }), row({ ts: '2026-11-04T08:00:00Z' })];
  const first = sync.push({ ledgerRows: rows, tenant, now: NOW });
  assert.deepEqual(first.map((f) => path.basename(f)), ['2026-11-02.enc', '2026-11-03.enc']);
  assert.deepEqual(sync.push({ ledgerRows: rows, tenant, now: NOW }), []);
  for (const f of first) assert.equal(sync.checkEnvelopeText(fs.readFileSync(f, 'utf8')), null);
  const text = first.map((f) => fs.readFileSync(f, 'utf8')).join('');
  assert.ok(!text.includes('daily-inbox-triage') && !text.includes('example.test'));
  assert.throws(() => sync.push({ ledgerRows: rows, tenant: { ...tenant, recipient_fingerprint: 'f'.repeat(64) }, now: NOW }), /not the one pinned/);
});

test('collect merges other machines (hashed) with own local rows (clear), skipping own envelopes', () => {
  const other = JSON.parse(fs.readFileSync(path.join(tmp, 'local', 'tenant.json'), 'utf8'));
  // Now act as the collector on a different identity.
  const me = { tenant: 'cccccccccccc', machine: 'dddddddddddd', display_name: 'Me', labels: 'clear', salt: 'x', recipient_fingerprint: fp };
  const out = sync.collect({ ledgerRows: [row({ ts: '2026-11-04T09:00:00Z', task: 'sched:mine' })], tenant: me, privPem, now: NOW });
  assert.deepEqual(out.problems, []);
  const tenants = new Set(out.facts.map((f) => f.tenant));
  assert.deepEqual([...tenants].sort(), [other.tenant, 'cccccccccccc'].sort());
  assert.ok(out.facts.some((f) => f.task === 'sched:mine'));
  assert.ok(out.facts.filter((f) => f.tenant === other.tenant).every((f) => /^sched:x[0-9a-f]{12}$/.test(f.task)));
  const t = out.tenants.find((x) => x.tenant === other.tenant);
  assert.equal(t.display_name, 'Other');
  assert.equal(t.days, 2);
  // the other machine's own view: its envelopes are skipped (its local ledger wins)
  const own = sync.collect({ ledgerRows: [], tenant: other, privPem, now: NOW });
  assert.equal(own.facts.length, 0);
});

test('verify rejects anything that is not a bare envelope', () => {
  assert.match(sync.checkEnvelopeText('{"facts":[]}'), /unexpected fields/);
  assert.match(sync.checkEnvelopeText('not json'), /not JSON/);
});
