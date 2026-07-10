const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { anonId, scrubEmail } = require('./lib');

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PRICING = [
  { prefix: 'claude-opus-4', input: 15, output: 75 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15 },
  { prefix: 'claude-sonnet-5', input: 3, output: 15 },
  { prefix: 'claude-haiku-4', input: 1, output: 5 },
];

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt transcript lines */ }
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

function turnFromGroup(requestId, rows, kind) {
  const messages = rows.map((r) => r.message || {});
  const usage = first(messages.map((m) => m.usage)) || {};
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
  };
}

function parseTranscript(file) {
  const kind = transcriptKind(file);
  const groups = new Map();
  for (const row of readJsonl(file)) {
    if (!row || row.type !== 'assistant') continue;
    const requestId = row.requestId || (row.message && row.message.id) || row.uuid;
    if (!requestId) continue;
    if (!groups.has(requestId)) groups.set(requestId, []);
    groups.get(requestId).push(row);
  }
  return [...groups.entries()].map(([requestId, rows]) => turnFromGroup(requestId, rows, kind));
}

function scanTranscripts(root = process.env.TS_PROJECTS_DIR || DEFAULT_PROJECTS_DIR) {
  return listFiles(root, (file) => file.endsWith('.jsonl') && !file.endsWith('.meta.json'))
    .flatMap(parseTranscript)
    .map((turn) => ({ ...turn, cost_usd: priceUSD(turn) }))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || a.request_id.localeCompare(b.request_id));
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
  if (!price) return null;
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
