const fs = require('fs');
const os = require('os');
const path = require('path');
const { anonId, scrubEmail } = require('./lib');

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

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
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || a.request_id.localeCompare(b.request_id));
}

module.exports = {
  scanTranscripts,
  anonId,
  scrubEmail,
};
