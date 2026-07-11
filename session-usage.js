#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  categorize,
  publicDedupeKey,
  rollupClosedHours,
  scanTranscripts,
  validateRows,
} = require('./session-lib');

const LOG_FILE = path.resolve(process.env.SESSION_LOG_FILE || path.join(__dirname, 'data', 'session-usage-log.jsonl'));
const CAVEAT = 'Caveat: token usage is per turn, not per tool; built-in tool tokens cannot be split within a turn.';

function parseOptions(args) {
  const opts = { _: [] };
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [k, v = true] = arg.slice(2).split('=');
      opts[k] = v;
    } else opts._.push(arg);
  }
  return opts;
}

function groupKey(turn, by) {
  const cat = categorize(turn);
  if (by === 'skill') return cat.category === 'skill' ? cat.label : cat.category;
  if (by === 'mcp') return cat.category === 'mcp' ? cat.label : cat.category;
  if (by === 'model') return turn.model || 'unknown';
  if (by === 'session') return turn.session_id || 'unknown';
  return cat.label || cat.category;
}

function fmtMoney(v) {
  return v == null ? 'unknown' : `$${v.toFixed(6)}`;
}

function report(opts) {
  const by = opts.by || 'skill';
  const turns = scanTranscripts();
  const groups = new Map();
  for (const turn of turns) {
    const key = groupKey(turn, by);
    if (!groups.has(key)) groups.set(key, { label: key, turns: 0, input: 0, output: 0, cost: 0, unknownCost: false });
    const row = groups.get(key);
    row.turns += 1;
    row.input += turn.input_tokens || 0;
    row.output += turn.output_tokens || 0;
    if (turn.cost_usd == null) row.unknownCost = true;
    else row.cost += turn.cost_usd;
  }

  console.log(`Session usage report by ${by}`);
  console.log(CAVEAT);
  console.log('label\tturns\tinput_tokens\toutput_tokens\tcost_usd');
  for (const row of [...groups.values()].sort((a, b) => b.output - a.output || a.label.localeCompare(b.label))) {
    console.log(`${row.label}\t${row.turns}\t${row.input}\t${row.output}\t${row.unknownCost ? 'unknown' : fmtMoney(row.cost)}`);
  }
  if (!groups.size) console.log('(no turns found)');
}

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function importRows() {
  const logFile = LOG_FILE;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const existing = readRows(logFile);
  const seen = new Set(existing.map(publicDedupeKey));
  const now = process.env.SESSION_USAGE_NOW ? new Date(process.env.SESSION_USAGE_NOW) : new Date();
  const rows = rollupClosedHours(scanTranscripts(), now);
  const violations = validateRows(rows);
  if (violations.length) {
    console.error(`Validation failed for ${violations.length} row(s).`);
    for (const v of violations) console.error(`${v.index}: ${v.field} ${v.reason}`);
    process.exit(2);
  }

  let added = 0, skipped = 0;
  const out = [];
  for (const row of rows) {
    const key = publicDedupeKey(row);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    out.push(JSON.stringify(row));
    added++;
  }
  if (out.length) fs.appendFileSync(logFile, out.join('\n') + '\n');
  else if (!fs.existsSync(logFile)) fs.closeSync(fs.openSync(logFile, 'a'));
  console.log(`Imported ${added} new row(s), skipped ${skipped} dup(s). -> ${logFile}`);
}

function validateFile(file) {
  if (!file) {
    console.error('usage: node session-usage.js validate <file>');
    process.exit(1);
  }
  const rows = readRows(path.resolve(file));
  const violations = validateRows(rows);
  if (violations.length) {
    for (const v of violations) console.error(`${v.index}: ${v.field} ${v.reason}`);
    process.exit(2);
  }
  console.log(`Validated ${rows.length} row(s).`);
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'report';
  const opts = parseOptions(argv.slice(1));
  if (cmd === 'report') return report(opts);
  if (cmd === 'import') return importRows();
  if (cmd === 'validate') return validateFile(opts._[0]);
  console.error('usage: node session-usage.js <report|import|validate> [options]');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { main, CAVEAT };
