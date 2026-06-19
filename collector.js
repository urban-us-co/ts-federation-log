#!/usr/bin/env node
/**
 * ts-federation-log — local usage collector
 *
 * A tiny zero-dependency HTTP server that receives Claude usage snapshots
 * from the browser bookmarklet (see usage-logger.js) and appends them to a
 * newline-delimited JSON log (JSONL). One line per (user, org, timestamp).
 *
 * Designed so MULTIPLE users/orgs can write to the same log: every browser
 * POSTs to a single running collector instance, and appends are serialized
 * in-process (Node is single-threaded), so lines never interleave.
 *
 * Endpoints:
 *   GET  /ping   -> {ok:true}                     health check
 *   POST /usage  -> {ok:true, written:N}          append one or more records
 *   GET  /log    -> raw JSONL                      the full log (for the future UI)
 *   GET  /        -> tiny HTML status page         record count + last entry
 *
 * Config (env):
 *   PORT       default 8787
 *   LOG_FILE   default ./data/usage-log.jsonl
 *
 * Run:  node collector.js     (or: npm start)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { flatten, isValidRaw } = require('./lib');

const PORT = parseInt(process.env.PORT || '8787', 10);
const LOG_FILE = path.resolve(process.env.LOG_FILE || path.join(__dirname, 'data', 'usage-log.jsonl'));

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const cors = (res, origin) => {
  // Allow the bookmarklet running on claude.ai (or anywhere) to POST here.
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  // Chrome Private Network Access: a secure public site (claude.ai) reaching
  // localhost sends a PNA preflight; without this opt-in the request hangs.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const appendRecords = (records) => {
  const lines = records.map((r) => JSON.stringify(flatten(r))).join('\n') + '\n';
  fs.appendFileSync(LOG_FILE, lines); // sync => serialized within this process
  return records.length;
};

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  cors(res, origin);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/ping') {
    return json(res, 200, { ok: true, log_file: LOG_FILE });
  }

  if (req.method === 'GET' && url.pathname === '/log') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    return fs.existsSync(LOG_FILE) ? fs.createReadStream(LOG_FILE).pipe(res) : res.end('');
  }

  if (req.method === 'GET' && url.pathname === '/') {
    let count = 0, last = null;
    if (fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      count = lines.length;
      last = lines.length ? lines[lines.length - 1] : null;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><meta charset=utf-8><title>ts-federation-log</title>
      <body style="font:14px system-ui;max-width:720px;margin:40px auto;padding:0 16px">
      <h1>ts-federation-log collector</h1>
      <p><b>${count}</b> records in <code>${LOG_FILE}</code></p>
      <p>Last entry:</p><pre style="background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto">${
        last ? JSON.stringify(JSON.parse(last), null, 2).replace(/</g, '&lt;') : '(empty)'
      }</pre>
      <p>POST snapshots to <code>/usage</code> · raw log at <a href="/log">/log</a></p></body>`);
  }

  if (req.method === 'POST' && url.pathname === '/usage') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const records = Array.isArray(data) ? data : [data];
        const valid = records.filter(isValidRaw);
        if (!valid.length) return json(res, 400, { ok: false, error: 'no valid records (need raw + org_uuid)' });
        const written = appendRecords(valid);
        console.log(`[${new Date().toISOString()}] +${written} record(s) from ${valid[0].user_email || '?'}`);
        return json(res, 200, { ok: true, written });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ts-federation-log collector listening on http://127.0.0.1:${PORT}`);
  console.log(`  logging to ${LOG_FILE}`);
});
