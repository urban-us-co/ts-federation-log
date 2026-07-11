# Detailed per-skill / per-task / per-tool usage metrics from local transcripts

- date: 2026-07-09
- repo: /Users/stonly/Projects/Third Sphere IT and Software Dev/ts-federation-log/.claude/worktrees/cowork-usage-metrics-9411f3
- branch: codex/session-usage-metrics
- base: main @ 054bdcb65f0e6b80d476ff03626e8cde56885b7e
- ledger: **commit-prefix** (`su-1:` … `su-5:`), one commit per task. No `bd`/beads in this repo — the task table below IS the ledger.
- spec: specs/codex/2026-07-09-session-usage-metrics.md

## Goal & definition of done

Add a second usage dataset to `ts-federation-log` derived from **local Claude
Code / Cowork session transcripts** (`~/.claude/projects/**/*.jsonl`), giving
token + computed-cost breakdowns by **skill, subagent task, MCP tool, model, and
session** — data the existing rate-limit log cannot provide. Two outputs from one
engine: (1) a **full-detail local CLI report** (private, never committed), and
(2) an **anonymized, bucketed, append-only public federation time-series**
(`data/session-usage-log.jsonl`).

Done means ALL of:
- [ ] All 5 tasks committed (`su-1:` … `su-5:` prefixes)
- [ ] Full verify passes: `node --test` (new tests + existing tests all green)
- [ ] Branch pushed: `git push -u origin codex/session-usage-metrics`
- [ ] New public dataset carries **no** raw emails and **no** un-hashed namespaced
      skill/tool/agent labels (enforced by `node session-usage.js validate`)
- [ ] Existing files under DO NOT TOUCH are unchanged (`data/usage-log.jsonl`,
      `lib.js`, `import.js`, `collector.js`, the `log-usage` skill)

## Context you need

### The existing pipeline (imitate its shape — do NOT modify it)

- `lib.js` — shared helpers. Exports `anonId(s)` (`sha256(s).slice(0,12)`, or null),
  `scrubEmail(s)`, `flatten(rec)`, `dedupeKey(r)`, `isValidRaw(r)`. **Reuse
  `anonId` and `scrubEmail` by `require('./lib')` — never reimplement or edit them.**
- `import.js` — the exemplar for our CLI: loads existing log keys into a `Set`,
  reads input, flattens, **dedupes by a stable key**, appends only new rows,
  respects `LOG_FILE` env. Copy this structure for `session-usage.js import`.
- `.claude/skills/log-usage/scripts/log_and_push.sh` — the exemplar for our helper:
  ingest → **grep the tracked log for leaked PII and abort if found** → commit →
  **direct-push if `gh api … .permissions.push == true`, else fork + PR**. Copy
  this structure for `scripts/log_and_push_sessions.sh`.
- `dashboard.html` — self-contained, zero-dependency viewer (indicator cards +
  time-series chart) that `fetch`es `data/usage-log.jsonl`. Add a sibling view for
  the new dataset in the same file, same vanilla-JS style.
- Code style: CommonJS (`require`/`module.exports`), no dependencies, terse
  comments that explain **why**. The whole repo has zero runtime deps — keep it so.

### The transcript data model (the new data source)

Path: `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl`, one JSON object per
line. Subagents: `~/.claude/projects/<slugified-cwd>/<sessionId>/subagents/agent-<id>.jsonl`
(+ `agent-<id>.meta.json` = `{"agentType": "...", "toolUseId": "...", "spawnDepth": N}`).

Relevant line shape (an **assistant** line):
```json
{"type":"assistant","requestId":"req_...","sessionId":"...","uuid":"...",
 "parentUuid":"...","timestamp":"2026-07-05T14:47:57.955Z","isSidechain":false,
 "entrypoint":"claude-desktop","cwd":"...","gitBranch":"...","version":"2.1.197",
 "slug":"...","attributionSkill":"anthropic-skills:mimo-offload",
 "attributionPlugin":"anthropic-skills","attributionMcpServer":"<serverId>",
 "attributionMcpTool":"execute_sql",
 "message":{"id":"msg_...","model":"claude-opus-4-8","role":"assistant",
   "content":[{"type":"tool_use","name":"Bash","input":{...}}],
   "usage":{"input_tokens":2,"output_tokens":2886,
     "cache_creation_input_tokens":5695,"cache_read_input_tokens":108857,
     "cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":5695}}}}
```

Critical facts (verified on this machine):
1. **Token usage is per-API-turn and duplicated across lines.** One turn =
   one `requestId` (== `message.id`), but it is split across multiple JSONL lines
   (one per content block), and the **identical `usage` object is repeated on each**.
   You MUST **dedupe by `requestId`** — count each turn's `usage` exactly once —
   or you multi-count (~2.6× on this machine). Handle both layouts: some builds put
   all content blocks on one line, others one block per line. So: group all
   assistant lines by `requestId`; take `usage`/`model`/`timestamp`/attribution from
   the group (they are consistent — use the first non-null); **union `tool_use`
   names across every line in the group**.
2. **Attribution is stamped by the harness** on the turn: `attributionSkill`,
   `attributionPlugin`, `attributionMcpServer`, `attributionMcpTool`. At most one
   skill and one MCP tool per turn; turns with no active skill/MCP have none.
3. **The hard ceiling:** a turn may emit several `tool_use` blocks, and `usage` is
   for the whole turn — so built-in tools (Read/Bash/Edit) can be **counted** but
   their tokens **cannot be split** within a turn. Say so in report output.
4. **Subagent (Task) tokens live in their own files**, not the parent turn (the
   parent only records an `async_launched` result). Parse each
   `subagents/agent-*.jsonl` the same way; tag `query_source:"subagent"` and
   `agent_type` from the sibling `.meta.json`; roll them under the **parent
   `sessionId`** (the dir name above `subagents/`).
5. **`entrypoint`** distinguishes Cowork (`claude-desktop`) from CLI (`cli`).
6. **No cost is stored** — compute it (see Pricing).

### Reconciled AGENTS.md rules (`~/.codex/AGENTS.md`)

The user's global Codex rules require: understand architecture before acting; keep a
context/doc file updated with every change; **"nothing ships without an update to our
context and test suite."** Resolution, folded into this spec: every functional task
ships its own tests (`test/**`), and `su-5` updates `README.md` (this project's
context doc). No conflict with this spec. Where the two ever disagree, **this spec
wins**.

### Identity (so the new dataset can join the existing one)

Transcripts contain no claude.ai account id. Resolve a stable identity ONCE per run:
`process.env.TS_FED_IDENTITY` → else `git config user.email` (of the CWD) → else
`${os.userInfo().username}@${os.hostname()}`. `user_id = anonId(identity)`. Document
that setting `TS_FED_IDENTITY` to your claude.ai email makes `user_id` match
`usage-log.jsonl`.

### Pricing (USD per **million** tokens — bake into `PRICING`)

Match by model-id **prefix** (tolerate date suffixes). `input` also prices cache:
cache-read = 0.1×input; cache-write-5m = 1.25×input; cache-write-1h = 2×input.

| prefix | input | output |
|---|---|---|
| `claude-opus-4` | 15 | 75 |
| `claude-sonnet-4`, `claude-sonnet-5` | 3 | 15 |
| `claude-haiku-4` | 1 | 5 |
| anything else (incl. `claude-fable-5`) | — | — → `cost_usd: null` |

Per-turn cost (USD) =
`(input_tokens*in + output_tokens*out + cache_read*0.1*in + cw5m*1.25*in + cw1h*2*in)/1e6`
where `cw5m`/`cw1h` come from `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`
when present, else treat all `cache_creation_input_tokens` as 5m. Unknown model →
`cost_usd: null` (never guess).

### Redaction (public dataset only — local report keeps everything in clear)

- `redactLabel(name)`: falsy → null; **contains `:`** (namespaced/plugin — e.g.
  `anthropic-skills:deal-robot`, `c-review:c-review-worker`) → `"x:"+anonId(name)`
  (opaque but stable, so per-skill trends survive without leaking the name); **bare**
  (e.g. `loop`, `handoff`, `Explore`, `general-purpose`) → keep as-is (public/built-in).
- MCP is always hashed (tool names reveal integrations and aren't namespaced):
  public `label = "mcp/"+anonId(server)+"/"+anonId(tool)`.
- `model` and `entrypoint` are NOT sensitive — keep in clear.

## File map

| Path | Action | What goes there |
|---|---|---|
| `session-lib.js` | create | Engine: `scanTranscripts`, `resolveIdentity`, `priceUSD`/`PRICING`, `categorize`, `redactLabel`, `toPublicRow`, `rollupClosedHours`, `validateRows`. Reuses `anonId`/`scrubEmail` from `./lib`. |
| `session-usage.js` | create | CLI: `report` (local full), `import` (public bucketed append), `validate <file>`. |
| `data/session-usage-log.jsonl` | create | New tracked public time-series. Start **empty** (0 bytes). |
| `test/session-lib.parse.test.js` | create | su-1 tests (parsing/dedup/subagents). |
| `test/session-lib.rollup.test.js` | create | su-2 tests (pricing/redaction/rollup/validate). |
| `test/session-usage.cli.test.js` | create | su-3 tests (CLI report/import/validate via `child_process`). |
| `test/fixtures/projects/**` | create | Tiny synthetic transcript tree (main + one subagents dir) for tests. |
| `.claude/skills/log-session-usage/SKILL.md` | create | Headless skill doc. |
| `.claude/skills/log-session-usage/scripts/log_and_push_sessions.sh` | create | ingest→validate→commit→push/PR helper. |
| `dashboard.html` | modify | Add token/cost view for the new dataset. |
| `README.md` | modify | Document the dataset, the tool, and the privacy posture. |
| `.gitignore` | modify/create | Ignore local session-usage state/dumps. |

Allowed globs (you may ONLY touch files matching these):
`session-lib.js`, `session-usage.js`, `data/session-usage-log.jsonl`, `test/**`,
`.claude/skills/log-session-usage/**`, `dashboard.html`, `README.md`, `.gitignore`,
`specs/codex/**`

## DO NOT TOUCH

- `data/usage-log.jsonl` — the existing public log; **never** read-modify-write it.
- `lib.js`, `import.js`, `collector.js` — reuse by `require`, never edit.
- `.claude/skills/log-usage/**`, `.agents/**` — the existing skill (and its copy).
- `package.json` — no new scripts/deps; run via `node session-usage.js …`.
- `test/log-usage-docs.test.js` — existing test; must keep passing, do not edit.
- `.github/**`, any lockfile, `usage-logger*.js` / `*.bookmarklet.txt` (gitignored).

## Constraints & conventions

- **No new dependencies.** Node stdlib only (`fs`, `os`, `path`, `crypto`,
  `child_process` for CLI tests). CommonJS. Match `lib.js`/`import.js` style.
- Parse `process.argv` by hand (like `import.js`); no arg-parser lib.
- **Determinism:** `scanTranscripts` takes a `root` (opt/`TS_PROJECTS_DIR` env, default
  `~/.claude/projects`); `rollupClosedHours` takes `now` as a param; `import` writes to
  `SESSION_LOG_FILE` env (default `data/session-usage-log.jsonl`). Tests point these at
  fixtures / tmp files — never the real `~/.claude` or the tracked log.
- Tests use `node --test` + `node:assert` only.

## Task breakdown

Work in order. `su-4` and `su-5` both depend on `su-3` and may be done in either order.

| Task | Title | Depends | Acceptance criteria | Est LOC | Files |
|---|---|---|---|---|---|
| su-1 | Transcript scan + turn engine | — | `node --test test/session-lib.parse.test.js` green: scanning `test/fixtures/projects` yields one record per unique `requestId` (not per line), with correct summed `output_tokens`, `model`, `entrypoint`, unioned `tool_names`, and attribution fields; subagent turns appear tagged `query_source:"subagent"` + `agent_type`, rolled under the parent `sessionId`. | ~150 | `session-lib.js`, `test/session-lib.parse.test.js`, `test/fixtures/projects/**` |
| su-2 | Pricing + redaction + closed-hour rollup | su-1 | `node --test test/session-lib.rollup.test.js` green: `priceUSD` matches a known opus/sonnet/haiku turn and returns `null` for `claude-fable-5`; `redactLabel` hashes `anthropic-skills:x` (→ `x:`-prefixed) and keeps bare `loop`; `categorize` picks skill>mcp>direct; `rollupClosedHours` groups by the dedupe key, sums tokens/cost, counts turns, and **excludes the current hour**; `validateRows` returns a violation for a row containing an email or an un-hashed `:` label. | ~130 | `session-lib.js` (modify), `test/session-lib.rollup.test.js` |
| su-3 | `session-usage.js` CLI | su-2 | `node --test test/session-usage.cli.test.js` green (spawns the CLI with `TS_PROJECTS_DIR`/`SESSION_LOG_FILE` at fixtures/tmp): `report --by=skill` prints a non-empty table incl. the per-turn-not-per-tool caveat; `import` appends bucketed closed-hour rows and a **second `import` adds 0 rows**; every appended row passes `validate`. | ~160 | `session-usage.js`, `test/session-usage.cli.test.js` |
| su-4 | `log-session-usage` skill + helper | su-3 | `bash -n scripts/log_and_push_sessions.sh` clean; helper runs `node session-usage.js import` then `node session-usage.js validate <log>` and **aborts the commit** if validate fails or an `@email` is grep-found; then commits `log: session-usage snapshot <ts>` and does the direct-push-or-PR dance (mirroring `log_and_push.sh`). `SKILL.md` explains it needs **no browser** (reads local files) and can reuse the existing hourly `/schedule`. | ~120 | `.claude/skills/log-session-usage/SKILL.md`, `.claude/skills/log-session-usage/scripts/log_and_push_sessions.sh` |
| su-5 | Dashboard view + README + .gitignore + data file | su-3 | `node --test` (ALL tests) green; `dashboard.html` gains a token/cost-over-time view that `fetch`es `data/session-usage-log.jsonl` with a Cowork/CLI (`entrypoint`) toggle and degrades gracefully on an empty file; `README.md` documents the new dataset, the local `report` tool, and the local-full/public-bucketed privacy split; `.gitignore` ignores local session-usage state/dumps; `data/session-usage-log.jsonl` exists (empty). | ~120 | `dashboard.html`, `README.md`, `.gitignore`, `data/session-usage-log.jsonl` |

### Public row schema (`data/session-usage-log.jsonl`) — produced by `toPublicRow`+`rollupClosedHours`

```json
{"ts_hour":"2026-07-09T21:00:00Z","recorded_by":"session-scan",
 "user_id":"<anonId>","session_id":"<anonId(sessionId)>","entrypoint":"claude-desktop",
 "query_source":"main","agent_type":null,"model":"claude-opus-4-8",
 "category":"skill","label":"x:ab12cd34ef56",
 "input_tokens":123,"output_tokens":456,"cache_read_tokens":789,
 "cache_creation_tokens":10,"cost_usd":0.0421,"turns":7}
```
Dedupe key (append-only, immutable once the hour closes):
`[user_id,session_id,ts_hour,entrypoint,query_source,agent_type,model,category,label].join('|')`.
`import` loads existing keys into a `Set` (like `import.js`) and appends only new rows;
`rollupClosedHours(turns, now)` emits **only** buckets whose hour `< floor(now,'hour')`.

## Verify

Cheap (after every task, before committing):
```bash
for f in session-lib.js session-usage.js; do [ -f "$f" ] && node --check "$f"; done
```

Full (once, before declaring done):
```bash
node --test
```

## Working protocol (commit-prefix ledger — no bd)

1. Read this spec end to end.
2. Take the next task in `su-N` order (su-4/su-5 after su-3).
3. Implement exactly its row — nothing more, no drive-by refactors.
4. Run the **cheap** verify, then the task's own test file. Both green before committing.
5. `git add <only the files this task's row names> && git commit -m "su-N: <summary>"`.
   One task = one commit (small follow-up fixes: same `su-N:` prefix). **Never**
   `git add -A`/`git add .`.
6. Move to the next task.
7. Blocked and cannot proceed as specified → STOP and report what/why (do not invent an
   approach, do not touch DO NOT TOUCH files).

## End condition

All 5 tasks committed → run the FULL verify (`node --test`) → green →
`git push -u origin codex/session-usage-metrics` → **STOP**. Do NOT open a pull
request, do NOT merge — the reviewer (Claude) handles PR + final review.
