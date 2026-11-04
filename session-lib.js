const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { anonId, scrubEmail } = require('./lib');

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Cowork sessions keep their own transcript tree per session:
// <root>/<account-uuid>/<org-uuid>/<session>/.claude/projects/**/*.jsonl
const DEFAULT_COWORK_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
const PRICING = [
  { prefix: 'claude-opus-4', input: 15, output: 75 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15 },
  { prefix: 'claude-sonnet-5', input: 3, output: 15 },
  { prefix: 'claude-haiku-4', input: 1, output: 5 },
  { prefix: 'claude-fable-5', input: 10, output: 50 },
];

// Streams the file in chunks instead of readFileSync(...,'utf8'): real transcripts
// reach ~700MB, past V8's max string length (ERR_STRING_TOO_LONG). Lines are
// filtered as Buffers by `keep` (a byte marker) so huge non-matching lines (tool
// results, images) are never decoded.
const CHUNK = 1 << 20;
function readJsonl(file, keep = null) {
  const out = [];
  const marker = keep ? Buffer.from(keep) : null;
  const take = (buf) => {
    if (!buf.length || (marker && buf.indexOf(marker) === -1)) return;
    const line = buf.toString('utf8');
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt transcript lines */ }
  };
  const fd = fs.openSync(file, 'r');
  try {
    let pending = [];
    const chunk = Buffer.allocUnsafe(CHUNK);
    let n;
    while ((n = fs.readSync(fd, chunk, 0, CHUNK, null)) > 0) {
      let start = 0;
      let nl;
      const view = chunk.subarray(0, n);
      while ((nl = view.indexOf(10, start)) !== -1) {
        const part = view.subarray(start, nl);
        take(pending.length ? Buffer.concat([...pending, part]) : part);
        pending = [];
        start = nl + 1;
      }
      if (start < n) pending.push(Buffer.from(view.subarray(start)));
    }
    if (pending.length) take(Buffer.concat(pending));
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function listFiles(dir, pred) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) out.push(...listFiles(file, pred));
    else if (pred(file)) out.push(file);
  }
  return out;
}

function first(values) {
  return values.find((v) => v !== undefined && v !== null) ?? null;
}

function contentBlocks(message) {
  const content = message && message.content;
  if (Array.isArray(content)) return content;
  return content ? [content] : [];
}

function usageTokens(usage) {
  usage = usage || {};
  const creation = usage.cache_creation || {};
  const rawCreation = usage.cache_creation_input_tokens || 0;
  const hasSplit = Object.prototype.hasOwnProperty.call(creation, 'ephemeral_5m_input_tokens') ||
    Object.prototype.hasOwnProperty.call(creation, 'ephemeral_1h_input_tokens');
  const cw5m = hasSplit ? (creation.ephemeral_5m_input_tokens || 0) : rawCreation;
  const cw1h = hasSplit ? (creation.ephemeral_1h_input_tokens || 0) : 0;
  return {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    cache_creation_tokens: rawCreation || cw5m + cw1h,
    cache_creation_5m_tokens: cw5m,
    cache_creation_1h_tokens: cw1h,
  };
}

function transcriptKind(file) {
  const dir = path.basename(path.dirname(file));
  if (dir !== 'subagents') return { query_source: 'main', parent_session_id: null, agent_type: null };

  const sessionDir = path.dirname(path.dirname(file));
  const metaFile = file.replace(/\.jsonl$/, '.meta.json');
  let meta = {};
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { meta = {}; }
  }
  return {
    query_source: 'subagent',
    parent_session_id: path.basename(sessionDir),
    agent_type: meta.agentType || null,
  };
}

// Cowork path parts: the account/org UUIDs are the only local signal of WHICH
// Cowork account did the work (needed to compare accounts / move work between them).
function coworkOrigin(file, coworkRoot) {
  if (!coworkRoot) return {};
  const rel = path.relative(coworkRoot, file).split(path.sep);
  if (rel.length < 4 || rel[0] === '..') return {};
  return { account_uuid: rel[0], org_uuid: rel[1], cowork_session: rel[2] };
}

// quotaLimits is stamped only on turns where a limit state was reported; keep the
// event, not the payload (upgradePaths etc. are noise).
function quotaEvent(rows) {
  const q = first(rows.map((r) => r.quotaLimits));
  if (!q) return null;
  return {
    status: q.status ?? null,
    rate_limit_type: q.rateLimitType ?? null,
    resets_at: q.resetsAt ?? null,
    is_using_overage: q.isUsingOverage ?? null,
    overage_status: q.overageStatus ?? null,
  };
}

function turnFromGroup(requestId, rows, kind) {
  const messages = rows.map((r) => r.message || {});
  const usage = first(messages.map((m) => m.usage)) || {};
  const serverTools = usage.server_tool_use || {};
  const tools = new Set();
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block && block.type === 'tool_use' && block.name) tools.add(block.name);
    }
  }
  const sessionId = kind.parent_session_id || first(rows.map((r) => r.sessionId));
  return {
    request_id: requestId,
    message_id: first(messages.map((m) => m.id)),
    session_id: sessionId,
    transcript_session_id: first(rows.map((r) => r.sessionId)),
    timestamp: first(rows.map((r) => r.timestamp)),
    model: first(messages.map((m) => m.model)),
    entrypoint: first(rows.map((r) => r.entrypoint)),
    cwd: first(rows.map((r) => r.cwd)),
    git_branch: first(rows.map((r) => r.gitBranch)),
    version: first(rows.map((r) => r.version)),
    slug: first(rows.map((r) => r.slug)),
    query_source: kind.query_source,
    agent_type: kind.agent_type,
    attribution_skill: first(rows.map((r) => r.attributionSkill)),
    attribution_plugin: first(rows.map((r) => r.attributionPlugin)),
    attribution_mcp_server: first(rows.map((r) => r.attributionMcpServer)),
    attribution_mcp_tool: first(rows.map((r) => r.attributionMcpTool)),
    tool_names: [...tools].sort(),
    ...usageTokens(usage),
    // Fields below are additive (2026-11 revival) — used by the private ledger
    // and offload scoring; the public rollup ignores them.
    source: kind.source || 'claude-code',
    account_uuid: kind.account_uuid || null,
    org_uuid: kind.org_uuid || null,
    effort: first(rows.map((r) => r.effort)),
    requested_model: first(rows.map((r) => r.requestedModel)),
    advisor_model: first(rows.map((r) => r.advisorModel)),
    service_tier: usage.service_tier || null,
    web_search_requests: serverTools.web_search_requests || 0,
    web_fetch_requests: serverTools.web_fetch_requests || 0,
    is_api_error: rows.some((r) => r.isApiErrorMessage === true),
    quota: quotaEvent(rows),
  };
}

function parseTranscript(file, origin = {}) {
  const kind = { ...transcriptKind(file), ...origin };
  const groups = new Map();
  for (const row of readJsonl(file, '"assistant"')) {
    if (!row || row.type !== 'assistant') continue;
    const requestId = row.requestId || (row.message && row.message.id) || row.uuid;
    if (!requestId) continue;
    if (!groups.has(requestId)) groups.set(requestId, []);
    groups.get(requestId).push(row);
  }
  return [...groups.entries()].map(([requestId, rows]) => turnFromGroup(requestId, rows, kind));
}

function byTime(a, b) {
  return String(a.timestamp).localeCompare(String(b.timestamp)) || a.request_id.localeCompare(b.request_id);
}

function scanTranscripts(root = process.env.TS_PROJECTS_DIR || DEFAULT_PROJECTS_DIR) {
  return listFiles(root, (file) => file.endsWith('.jsonl') && !file.endsWith('.meta.json'))
    .flatMap((file) => parseTranscript(file))
    .map((turn) => ({ ...turn, cost_usd: priceUSD(turn) }))
    .sort(byTime);
}

// Walk only <acct>/<org>/<session>/.claude/projects — the Cowork root also holds
// GBs of outputs/uploads and an audit.jsonl per session that are NOT transcripts.
function coworkTranscriptFiles(root) {
  const out = [];
  const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => {
    try { return fs.statSync(path.join(d, n)).isDirectory(); } catch { return false; }
  }) : []);
  for (const acct of dirs(root)) {
    for (const org of dirs(path.join(root, acct))) {
      for (const session of dirs(path.join(root, acct, org))) {
        const projects = path.join(root, acct, org, session, '.claude', 'projects');
        out.push(...listFiles(projects, (file) => file.endsWith('.jsonl')));
      }
    }
  }
  return out;
}

function scanCowork(root = process.env.TS_COWORK_DIR || DEFAULT_COWORK_DIR) {
  return coworkTranscriptFiles(root)
    .flatMap((file) => parseTranscript(file, { source: 'cowork', ...coworkOrigin(file, root) }))
    .map((turn) => ({ ...turn, cost_usd: priceUSD(turn) }))
    .sort(byTime);
}

// All local sources. An explicit TS_PROJECTS_DIR without TS_COWORK_DIR means
// "scan only that tree" — keeps tests and ad-hoc runs from touching real Cowork data.
function scanAllSources(env = process.env) {
  const turns = scanTranscripts(env.TS_PROJECTS_DIR || DEFAULT_PROJECTS_DIR);
  const coworkRoot = env.TS_COWORK_DIR || (env.TS_PROJECTS_DIR ? null : DEFAULT_COWORK_DIR);
  if (coworkRoot && env.TS_COWORK_DIR !== 'off') turns.push(...scanCowork(coworkRoot));
  return turns.sort(byTime);
}

function resolveIdentity() {
  if (process.env.TS_FED_IDENTITY) return process.env.TS_FED_IDENTITY;
  try {
    const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (email) return email;
  } catch { /* fall through */ }
  const user = os.userInfo().username || 'unknown';
  return `${user}@${os.hostname()}`;
}

function priceUSD(turn) {
  const price = PRICING.find((row) => String(turn.model || '').startsWith(row.prefix));
  if (!price) {
    // Unpriced model with no billable tokens (e.g. `<synthetic>` turns) costs $0;
    // a genuinely unpriced model that DID consume tokens stays null (honestly unknown).
    const billable =
      (turn.input_tokens || 0) + (turn.output_tokens || 0) +
      (turn.cache_read_tokens || 0) + (turn.cache_creation_5m_tokens || 0) +
      (turn.cache_creation_1h_tokens || 0);
    return billable === 0 ? 0 : null;
  }
  const total =
    (turn.input_tokens || 0) * price.input +
    (turn.output_tokens || 0) * price.output +
    (turn.cache_read_tokens || 0) * 0.1 * price.input +
    (turn.cache_creation_5m_tokens || 0) * 1.25 * price.input +
    (turn.cache_creation_1h_tokens || 0) * 2 * price.input;
  return total / 1e6;
}

function redactLabel(name) {
  if (!name) return null;
  const label = String(name);
  return label.includes(':') ? `x:${anonId(label)}` : label;
}

function categorize(turn) {
  if (turn.attribution_skill) return { category: 'skill', label: turn.attribution_skill };
  if (turn.attribution_mcp_server || turn.attribution_mcp_tool) {
    return { category: 'mcp', label: `mcp/${turn.attribution_mcp_server || 'unknown'}/${turn.attribution_mcp_tool || 'unknown'}` };
  }
  return { category: 'direct', label: 'direct' };
}

function hour(ts) {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace('.000Z', 'Z');
}

function publicLabel(turn, cat) {
  if (cat.category === 'mcp') {
    return `mcp/${anonId(turn.attribution_mcp_server || 'unknown')}/${anonId(turn.attribution_mcp_tool || 'unknown')}`;
  }
  return redactLabel(cat.label);
}

function toPublicRow(turn, identity = resolveIdentity()) {
  const cat = categorize(turn);
  return {
    ts_hour: hour(turn.timestamp),
    recorded_by: 'session-scan',
    user_id: anonId(identity),
    session_id: anonId(turn.session_id),
    entrypoint: turn.entrypoint || null,
    query_source: turn.query_source || 'main',
    agent_type: redactLabel(turn.agent_type),
    model: turn.model || null,
    category: cat.category,
    label: publicLabel(turn, cat),
    input_tokens: turn.input_tokens || 0,
    output_tokens: turn.output_tokens || 0,
    cache_read_tokens: turn.cache_read_tokens || 0,
    cache_creation_tokens: turn.cache_creation_tokens || 0,
    cost_usd: turn.cost_usd,
    turns: 1,
  };
}

function publicDedupeKey(row) {
  return [
    row.user_id,
    row.session_id,
    row.ts_hour,
    row.entrypoint,
    row.query_source,
    row.agent_type,
    row.model,
    row.category,
    row.label,
  ].join('|');
}

function rollupClosedHours(turns, now = new Date(), identity = resolveIdentity()) {
  const currentHour = hour(now);
  const groups = new Map();
  for (const turn of turns) {
    const row = toPublicRow(turn, identity);
    if (!row.ts_hour || row.ts_hour >= currentHour) continue;
    const key = publicDedupeKey(row);
    if (!groups.has(key)) groups.set(key, { ...row });
    else {
      const prev = groups.get(key);
      prev.input_tokens += row.input_tokens;
      prev.output_tokens += row.output_tokens;
      prev.cache_read_tokens += row.cache_read_tokens;
      prev.cache_creation_tokens += row.cache_creation_tokens;
      prev.cost_usd = prev.cost_usd == null || row.cost_usd == null ? null : prev.cost_usd + row.cost_usd;
      prev.turns += 1;
    }
  }
  return [...groups.values()]
    .map((row) => ({ ...row, cost_usd: row.cost_usd == null ? null : Number(row.cost_usd.toFixed(6)) }))
    .sort((a, b) => publicDedupeKey(a).localeCompare(publicDedupeKey(b)));
}

function validateRows(rows) {
  const violations = [];
  rows.forEach((row, i) => {
    const text = JSON.stringify(row);
    if (/[\w.+-]+@[\w.-]+\.\w+/.test(text)) violations.push({ index: i, field: '*', reason: 'email' });
    if (row.label && row.label.includes(':') && !String(row.label).startsWith('x:')) {
      violations.push({ index: i, field: 'label', reason: 'unhashed-colon-label' });
    }
    if (row.agent_type && row.agent_type.includes(':') && !String(row.agent_type).startsWith('x:')) {
      violations.push({ index: i, field: 'agent_type', reason: 'unhashed-colon-label' });
    }
    if (row.category === 'mcp' && !/^mcp\/[0-9a-f]{12}\/[0-9a-f]{12}$/.test(String(row.label))) {
      violations.push({ index: i, field: 'label', reason: 'unhashed-mcp-label' });
    }
  });
  return violations;
}

module.exports = {
  PRICING,
  scanTranscripts,
  scanCowork,
  scanAllSources,
  resolveIdentity,
  priceUSD,
  redactLabel,
  categorize,
  toPublicRow,
  rollupClosedHours,
  validateRows,
  publicDedupeKey,
  anonId,
  scrubEmail,
};
