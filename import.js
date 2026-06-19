#!/usr/bin/env node
/**
 * ts-federation-log — import downloaded usage snapshots
 *
 * The reliable path: the browser bookmarklet downloads a `usage-*.jsonl` file
 * (because Chrome blocks claude.ai -> localhost POSTs without a per-session
 * Local Network Access grant). This script ingests those files into the
 * central log, flattening + de-duping so re-imports are safe.
 *
 * Usage:
 *   node import.js                       # import all usage-*.jsonl from ~/Downloads
 *   node import.js path/to/file.jsonl    # import specific file(s)
 *   node import.js ~/Downloads/*.jsonl
 *
 * Config (env):
 *   LOG_FILE        default ./data/usage-log.jsonl
 *   DOWNLOADS_DIR   default ~/Downloads   (used when no files are passed)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { flatten, dedupeKey, isValidRaw } = require('./lib');

const LOG_FILE = path.resolve(process.env.LOG_FILE || path.join(__dirname, 'data', 'usage-log.jsonl'));
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads');

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// Resolve input files: explicit args, or auto-discover usage-*.jsonl in Downloads.
let inputs = process.argv.slice(2);
if (!inputs.length) {
  if (!fs.existsSync(DOWNLOADS_DIR)) { console.error(`No files passed and ${DOWNLOADS_DIR} missing.`); process.exit(1); }
  inputs = fs.readdirSync(DOWNLOADS_DIR)
    .filter((f) => /^usage-.*\.jsonl$/.test(f))
    .map((f) => path.join(DOWNLOADS_DIR, f));
  if (!inputs.length) { console.log(`No usage-*.jsonl files found in ${DOWNLOADS_DIR}.`); process.exit(0); }
}

// Load existing keys to avoid duplicate rows on re-import.
const seen = new Set();
if (fs.existsSync(LOG_FILE)) {
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { seen.add(dedupeKey(JSON.parse(line))); } catch { /* skip corrupt line */ }
  }
}

let added = 0, skipped = 0, bad = 0;
const out = [];
for (const file of inputs) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`! cannot read ${file}: ${e.message}`); continue; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { bad++; continue; }
    if (!isValidRaw(rec)) { bad++; continue; }
    const flat = flatten(rec);
    const key = dedupeKey(flat);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key); out.push(JSON.stringify(flat)); added++;
  }
}

if (out.length) fs.appendFileSync(LOG_FILE, out.join('\n') + '\n');
console.log(`Imported ${added} new record(s), skipped ${skipped} dup(s), ${bad} invalid. -> ${LOG_FILE}`);
