#!/usr/bin/env node
// sync.js — encrypted multitenant sync of private usage detail through this
// PUBLIC repo (2026-11).
//
// Each machine encrypts its own closed UTC days of dashboard rows to ONE
// recipient public key (tenants/recipient.pub.pem, the dashboard owner's) and
// commits them as tenants/<tenant>/<machine>/<YYYY-MM-DD>.enc. Only the holder of
// the private key (local/recipient.key.pem, never committed) can read them, so
// contributors share no secret. A day file is written once and never rewritten
// (append-only, small diffs). Each machine pins the recipient key's fingerprint
// at setup, so a swapped key in the repo stops its pushes instead of silently
// encrypting to someone else.
//
// Envelope: RSA-OAEP-SHA256 wraps a random AES-256-GCM key; the plaintext is
// gzip(JSON); the header (v, kid, tenant, machine, day) is bound as AAD.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { anonId } = require('./lib');
const { buildFacts, splitByDay, toCsv, FACT_COLUMNS, SESSION_COLUMNS } = require('./facts');

const ROOT = __dirname;
const LOCAL = path.resolve(process.env.LEDGER_DIR || path.join(ROOT, 'local'));
const TENANTS = path.resolve(process.env.TENANTS_DIR || path.join(ROOT, 'tenants'));
const PUB = () => path.join(TENANTS, 'recipient.pub.pem');
const PRIV = () => path.join(LOCAL, 'recipient.key.pem');
const TENANT_FILE = () => path.join(LOCAL, 'tenant.json');
const ID_RE = /^[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function fingerprint(pubPem) {
  const der = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function header(env) {
  return JSON.stringify({ v: env.v, kid: env.kid, tenant: env.tenant, machine: env.machine, day: env.day });
}

function encrypt(obj, pubPem, meta) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const env = { v: 1, alg: 'RSA-OAEP-256+A256GCM', kid: fingerprint(pubPem), tenant: meta.tenant, machine: meta.machine, day: meta.day };
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(header(env)));
  const data = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))), cipher.final()]);
  const wrapped = crypto.publicEncrypt({ key: pubPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { ...env, key: wrapped.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(env, privPem) {
  const key = crypto.privateDecrypt({ key: privPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(env.key, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAAD(Buffer.from(header(env)));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]);
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

// Structural check of a committed file: an envelope and nothing else.
function checkEnvelopeText(text, where = '') {
  let env;
  try { env = JSON.parse(text); } catch { return `${where}: not JSON`; }
  const keys = Object.keys(env).sort().join(',');
  if (keys !== 'alg,data,day,iv,key,kid,machine,tag,tenant,v') return `${where}: unexpected fields ${keys}`;
  if (env.v !== 1 || env.alg !== 'RSA-OAEP-256+A256GCM') return `${where}: unknown format`;
  if (!ID_RE.test(env.tenant) || !ID_RE.test(env.machine) || !DAY_RE.test(env.day) || !/^[0-9a-f]{64}$/.test(env.kid)) return `${where}: bad header`;
  for (const k of ['key', 'iv', 'tag', 'data']) if (!/^[A-Za-z0-9+/=]+$/.test(env[k])) return `${where}: ${k} not base64`;
  return null;
}

function readTenant() {
  if (!fs.existsSync(TENANT_FILE())) throw new Error(`no ${TENANT_FILE()} — run: node sync.js init-tenant`);
  return JSON.parse(fs.readFileSync(TENANT_FILE(), 'utf8'));
}

function initTenant({ identity, name, labels, fingerprint: pin }) {
  if (!identity) throw new Error('--identity is required');
  if (!['clear', 'hashed'].includes(labels)) throw new Error('--labels must be clear or hashed');
  if (!pin || !/^[0-9a-f]{64}$/.test(pin)) throw new Error('--fingerprint (64 hex) of the recipient key is required');
  const existing = fs.existsSync(TENANT_FILE()) ? JSON.parse(fs.readFileSync(TENANT_FILE(), 'utf8')) : {};
  const t = {
    tenant: anonId(identity),
    // Keep the machine id and salt across re-runs: changing either splits history.
    machine: existing.machine || crypto.randomBytes(6).toString('hex'),
    salt: existing.salt || crypto.randomBytes(32).toString('hex'),
    display_name: name || existing.display_name || null,
    labels,
    recipient_fingerprint: pin,
  };
  fs.mkdirSync(LOCAL, { recursive: true });
  fs.writeFileSync(TENANT_FILE(), JSON.stringify(t, null, 2) + '\n', { mode: 0o600 });
  return t;
}

function initRecipient() {
  if (fs.existsSync(PRIV())) throw new Error(`${PRIV()} already exists — refusing to replace the key every contributor encrypts to`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.mkdirSync(LOCAL, { recursive: true });
  fs.mkdirSync(TENANTS, { recursive: true });
  fs.writeFileSync(PRIV(), privateKey, { mode: 0o600 });
  fs.writeFileSync(PUB(), publicKey);
  return fingerprint(publicKey);
}

function readLedger(file = path.join(LOCAL, 'ledger.jsonl')) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Write envelopes for closed UTC days that have no file yet. Returns written paths.
function push({ ledgerRows = readLedger(), tenant = readTenant(), now = new Date() } = {}) {
  const pubPem = fs.readFileSync(PUB(), 'utf8');
  const fp = fingerprint(pubPem);
  if (fp !== tenant.recipient_fingerprint) {
    throw new Error(`recipient key in the repo (${fp.slice(0, 16)}…) is not the one pinned at setup (${String(tenant.recipient_fingerprint).slice(0, 16)}…) — not pushing`);
  }
  const who = { tenant: tenant.tenant, machine: tenant.machine };
  const { facts, sessions } = buildFacts(ledgerRows, who, { labels: tenant.labels, salt: tenant.salt });
  const today = now.toISOString().slice(0, 10);
  const fByDay = splitByDay(facts, 'ts_hour');
  const sByDay = splitByDay(sessions, 'day');
  const dir = path.join(TENANTS, tenant.tenant, tenant.machine);
  const written = [];
  for (const day of [...new Set([...fByDay.keys(), ...sByDay.keys()])].sort()) {
    if (day >= today) continue; // only closed days: a day file is final once written
    const file = path.join(dir, `${day}.enc`);
    if (fs.existsSync(file)) continue;
    const body = {
      tenant: { tenant: tenant.tenant, machine: tenant.machine, display_name: tenant.display_name, labels: tenant.labels },
      facts: fByDay.get(day) || [],
      sessions: sByDay.get(day) || [],
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(encrypt(body, pubPem, { tenant: tenant.tenant, machine: tenant.machine, day })) + '\n');
    written.push(file);
  }
  return written;
}

function envelopeFiles() {
  const out = [];
  if (!fs.existsSync(TENANTS)) return out;
  for (const t of fs.readdirSync(TENANTS)) {
    const td = path.join(TENANTS, t);
    if (!ID_RE.test(t) || !fs.statSync(td).isDirectory()) continue;
    for (const m of fs.readdirSync(td)) {
      const md = path.join(td, m);
      if (!ID_RE.test(m) || !fs.statSync(md).isDirectory()) continue;
      for (const f of fs.readdirSync(md)) if (/^\d{4}-\d{2}-\d{2}\.enc$/.test(f)) out.push(path.join(md, f));
    }
  }
  return out.sort();
}

// Collector: own rows from the local ledger (fresh, clear labels, today included)
// + every other machine's decrypted days.
function collect({ ledgerRows = readLedger(), tenant = readTenant(), privPem = fs.readFileSync(PRIV(), 'utf8'), now = new Date() } = {}) {
  const own = buildFacts(ledgerRows, { tenant: tenant.tenant, machine: tenant.machine }, { labels: 'clear' });
  const facts = [...own.facts];
  const sessions = [...own.sessions];
  const tenants = new Map([[`${tenant.tenant}/${tenant.machine}`, {
    tenant: tenant.tenant, machine: tenant.machine, display_name: tenant.display_name, labels: 'clear', days: 0, last_day: null, own: true,
  }]]);
  const problems = [];
  const myKid = fingerprint(crypto.createPublicKey(privPem).export({ type: 'spki', format: 'pem' }));
  for (const file of envelopeFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const bad = checkEnvelopeText(text, path.relative(ROOT, file));
    if (bad) { problems.push(bad); continue; }
    const env = JSON.parse(text);
    if (env.machine === tenant.machine && env.tenant === tenant.tenant) continue; // local is authoritative
    if (env.kid !== myKid) { problems.push(`${path.relative(ROOT, file)}: encrypted to another key`); continue; }
    let body;
    try { body = decrypt(env, privPem); } catch (e) { problems.push(`${path.relative(ROOT, file)}: ${e.message}`); continue; }
    facts.push(...(body.facts || []));
    sessions.push(...(body.sessions || []));
    const k = `${env.tenant}/${env.machine}`;
    const t = tenants.get(k) || { tenant: env.tenant, machine: env.machine, display_name: null, labels: null, days: 0, last_day: null, own: false };
    t.display_name = (body.tenant && body.tenant.display_name) || t.display_name;
    t.labels = (body.tenant && body.tenant.labels) || t.labels;
    t.days += 1;
    if (!t.last_day || env.day > t.last_day) t.last_day = env.day;
    tenants.set(k, t);
  }
  const mine = tenants.get(`${tenant.tenant}/${tenant.machine}`);
  const ownDays = new Set(own.facts.map((f) => f.ts_hour.slice(0, 10)));
  mine.days = ownDays.size;
  mine.last_day = [...ownDays].sort().pop() || null;
  facts.sort((a, b) => a.ts_hour.localeCompare(b.ts_hour));
  sessions.sort((a, b) => a.day.localeCompare(b.day));
  return { facts, sessions, tenants: [...tenants.values()].map((t) => ({ ...t, generated_at: now.toISOString() })), problems };
}

function writeDashboard(out, dir = path.join(LOCAL, 'dashboard')) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'facts.csv'), toCsv(out.facts, FACT_COLUMNS));
  fs.writeFileSync(path.join(dir, 'sessions.csv'), toCsv(out.sessions, SESSION_COLUMNS));
  fs.writeFileSync(path.join(dir, 'tenants.json'), JSON.stringify(out.tenants) + '\n');
}

function parseArgs(argv) {
  const o = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) { const [k, v = true] = a.slice(2).split('='); o[k] = v; } else o._.push(a);
  }
  return o;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const o = parseArgs(argv.slice(1));
  try {
    if (cmd === 'init-recipient') {
      console.log(`recipient key created; fingerprint ${initRecipient()} (commit ${path.relative(ROOT, PUB())}, keep ${path.relative(ROOT, PRIV())} private and backed up)`);
    } else if (cmd === 'fingerprint') {
      console.log(fingerprint(fs.readFileSync(PUB(), 'utf8')));
    } else if (cmd === 'init-tenant') {
      const t = initTenant({ identity: o.identity || process.env.TS_FED_IDENTITY, name: o.name, labels: o.labels || 'hashed', fingerprint: o.fingerprint });
      console.log(`tenant ${t.tenant} machine ${t.machine} labels ${t.labels} -> ${TENANT_FILE()}`);
    } else if (cmd === 'push') {
      const written = push();
      console.log(`encrypted ${written.length} closed day(s) -> ${path.relative(ROOT, TENANTS)}`);
      for (const f of written) console.log(path.relative(ROOT, f));
    } else if (cmd === 'collect') {
      const out = collect();
      writeDashboard(out);
      console.log(`collected ${out.facts.length} fact row(s), ${out.sessions.length} session-day row(s) from ${out.tenants.length} machine(s)`);
      for (const p of out.problems) console.error(`skip: ${p}`);
    } else if (cmd === 'verify') {
      const bad = o._.map((f) => checkEnvelopeText(fs.readFileSync(f, 'utf8'), f)).filter(Boolean);
      for (const b of bad) console.error(b);
      if (bad.length) process.exit(2);
      console.log(`verified ${o._.length} envelope(s)`);
    } else {
      console.error('usage: node sync.js <init-recipient|fingerprint|init-tenant|push|collect|verify> [options]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
}

if (require.main === module) main();

module.exports = { encrypt, decrypt, fingerprint, checkEnvelopeText, initTenant, initRecipient, push, collect, writeDashboard, envelopeFiles };
