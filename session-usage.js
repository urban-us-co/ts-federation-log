#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  categorize,
  publicDedupeKey,
  rollupClosedHours,
  scanAllSources,
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
  if (by === 'source') return turn.source || 'claude-code';
  if (by === 'account') {
    return turn.account_uuid ? `cowork:${turn.account_uuid.slice(0, 8)}/${(turn.org_uuid || '').slice(0, 8)}` : (turn.source || 'claude-code');
  }
  return cat.label || cat.category;
}

function fmtMoney(v) {
  return v == null ? 'unknown' : `$${v.toFixed(6)}`;
}

function report(opts) {
  const by = opts.by || 'skill';
  const turns = scanAllSources();
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
  const rows = rollupClosedHours(scanAllSources(), now);
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

// PRIVATE: per-turn ledger + summary (task/step labels in clear). Written to
// LEDGER_DIR (default ./local, gitignored) and never to data/.
function ledger(opts) {
  const { buildLedger, coworkSessionMeta } = require('./ledger');
  const { summarize } = require('./offload');
  const { coworkRootFor } = require('./session-lib');
  const dir = path.resolve(process.env.LEDGER_DIR || path.join(__dirname, 'local'));
  if (path.relative(path.join(__dirname, 'data'), dir).split(path.sep)[0] !== '..') {
    console.error('refusing to write the private ledger under data/ (public).');
    process.exit(2);
  }
  fs.mkdirSync(dir, { recursive: true });
  const meta = coworkSessionMeta(coworkRootFor());
  const rows = buildLedger(scanAllSources(), meta);
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const now = process.env.SESSION_USAGE_NOW ? new Date(process.env.SESSION_USAGE_NOW) : new Date();
  const summary = summarize(rows, { now, days: Number(opts.days) || 30 });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  // One row file per Dashboard dataset (uploaded by the refresh routine).
  const dashDir = path.join(dir, 'dashboard');
  fs.mkdirSync(dashDir, { recursive: true });
  for (const [id, rows] of Object.entries(require('./offload').dashboardFiles(summary))) {
    fs.writeFileSync(path.join(dashDir, `${id}.json`), JSON.stringify(rows) + '\n');
  }
  const labelled = rows.filter((r) => r.source !== 'cowork' || r.task_kind !== 'interactive' || !r.task.endsWith(':untitled')).length;
  console.log(`Ledger: ${rows.length} turn(s), ${labelled} with a task label -> ${dir}`);
  console.log(`Window ${summary.window_days}d: $${summary.totals.cost_usd} API-priced, ${summary.candidates.length} offload candidate(s).`);
  const top = opts.top === undefined ? 10 : Number(opts.top) || 0;
  for (const c of summary.candidates.slice(0, top)) {
    console.log(`  [${c.rule}] ${c.task}${c.step ? ` / ${c.step}` : ''} -> ${c.target}: $${c.cost_usd} -> $${c.est_target_cost_usd}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'report';
  const opts = parseOptions(argv.slice(1));
  if (cmd === 'report') return report(opts);
  if (cmd === 'import') return importRows();
  if (cmd === 'validate') return validateFile(opts._[0]);
  if (cmd === 'ledger') return ledger(opts);
  console.error('usage: node session-usage.js <report|import|validate|ledger> [options]');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { main, CAVEAT };
