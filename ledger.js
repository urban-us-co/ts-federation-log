// ledger.js — PRIVATE per-turn usage ledger (2026-11 revival, P3).
//
// Turns from session-lib's scan get two human labels so usage can be read as
// "which task, which step":
//   task  — what the session was for: a scheduled task id, a Cowork session
//           title, or a Claude Code project folder.
//   step  — what the turn was doing: a subagent, a skill, an MCP tool, or the
//           built-in tools it called.
// Everything here stays on this machine (gitignored `local/`) or goes to the
// private Dashboard as aggregates. Nothing from this file feeds the public log.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Cowork keeps one metadata file per session next to the session dirs:
// <root>/<acct>/<org>/local_<id>.json. `cliSessionId` is the transcript sessionId.
// Read ONLY the fields we label with — the file also holds the system prompt,
// the first message and the account email, which must never be copied.
const META_FIELDS = {
  title: 'title',
  scheduledTaskId: 'scheduled_task_id',
  sessionType: 'session_type',
  parentSessionId: 'parent_session_id',
  createdAt: 'created_at',
  effortOverride: 'effort_override',
};

function coworkSessionMeta(root) {
  const meta = new Map();
  if (!root || !fs.existsSync(root)) return meta;
  const dirs = (d) => fs.readdirSync(d).filter((n) => {
    try { return fs.statSync(path.join(d, n)).isDirectory(); } catch { return false; }
  });
  for (const acct of dirs(root)) {
    for (const org of dirs(path.join(root, acct))) {
      const orgDir = path.join(root, acct, org);
      for (const name of fs.readdirSync(orgDir)) {
        if (!/^local_.*\.json$/.test(name)) continue;
        let d;
        try { d = JSON.parse(fs.readFileSync(path.join(orgDir, name), 'utf8')); } catch { continue; }
        if (!d || !d.cliSessionId) continue;
        const row = {};
        for (const [from, to] of Object.entries(META_FIELDS)) row[to] = d[from] ?? null;
        meta.set(d.cliSessionId, row);
      }
    }
  }
  return meta;
}

const HOME = os.homedir();

// "~/Projects/Third Sphere Fundraise/x" style label from a Claude Code cwd.
function projectLabel(cwd) {
  if (!cwd) return 'unknown';
  const short = cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
  return short.split('/').slice(0, 5).join('/');
}

function taskOf(turn, meta) {
  if (turn.source === 'cowork') {
    const m = meta.get(turn.session_id) || {};
    if (m.scheduled_task_id) return { task: `sched:${m.scheduled_task_id}`, task_kind: 'scheduled', title: m.title || null };
    if (m.parent_session_id) return { task: `dispatch:${m.title || 'untitled'}`, task_kind: 'dispatched', title: m.title || null };
    return { task: `cowork:${m.title || 'untitled'}`, task_kind: 'interactive', title: m.title || null };
  }
  return { task: `code:${projectLabel(turn.cwd)}`, task_kind: 'code', title: null };
}

// The same MCP server shows up under several names ("Claude in Chrome" /
// "claude-in-chrome", "plugin:desktop-commander:desktop-commander" / "Desktop
// Commander") and connectors appear as bare UUIDs; fold them so steps group.
function serverLabel(server) {
  if (!server) return null;
  const s = String(server);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return 'connector';
  return s.split(':').pop().replace(/^claude\.ai\s+/i, '').trim().toLowerCase().replace(/\s+/g, '-');
}

function stepOf(turn) {
  if (turn.query_source === 'subagent') return `subagent:${turn.agent_type || 'unknown'}`;
  if (turn.attribution_skill) return `skill:${turn.attribution_skill}`;
  if (turn.attribution_mcp_server || turn.attribution_mcp_tool) {
    const server = serverLabel(turn.attribution_mcp_server);
    const tool = turn.attribution_mcp_tool || 'unknown';
    return server ? `mcp:${server}/${tool}` : `mcp:${tool}`;
  }
  return turn.tool_names && turn.tool_names.length ? `tools:${turn.tool_names.join('+')}` : 'text';
}

// Model tier, for "is this running on the top shelf?" questions.
function tierOf(model) {
  const m = String(model || '');
  if (/fable|mythos/.test(m)) return 'fable';
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  return 'other';
}

function toLedgerRow(turn, meta = new Map()) {
  const t = taskOf(turn, meta);
  return {
    ts: turn.timestamp,
    source: turn.source,
    account: turn.account_uuid ? `${turn.account_uuid.slice(0, 8)}/${(turn.org_uuid || '').slice(0, 8)}` : 'claude-code',
    session_id: turn.session_id,
    ...t,
    step: stepOf(turn),
    query_source: turn.query_source,
    agent_type: turn.agent_type,
    skill: turn.attribution_skill,
    mcp_tool: turn.attribution_mcp_tool,
    tool_names: turn.tool_names,
    model: turn.model,
    tier: tierOf(turn.model),
    effort: turn.effort,
    input_tokens: turn.input_tokens,
    output_tokens: turn.output_tokens,
    cache_read_tokens: turn.cache_read_tokens,
    cache_creation_5m_tokens: turn.cache_creation_5m_tokens,
    cache_creation_1h_tokens: turn.cache_creation_1h_tokens,
    web_search_requests: turn.web_search_requests,
    cost_usd: turn.cost_usd,
    quota: turn.quota,
    is_api_error: turn.is_api_error,
  };
}

function buildLedger(turns, meta) {
  return turns.map((t) => toLedgerRow(t, meta));
}

module.exports = { coworkSessionMeta, toLedgerRow, buildLedger, taskOf, stepOf, tierOf, projectLabel, serverLabel, META_FIELDS };
