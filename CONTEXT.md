# ts-federation-log — CONTEXT

Living architecture + decisions doc. Update with every shipped change (owner rule:
nothing ships without an update to this file and the test suite). `README.md` stays
the public "how to join / how it works" page; this file is the working memory.

## Purpose

1. **Federation (public):** a shared hourly time series of how close each
   user/org is to their claude.ai limits (5-hour, weekly, Sonnet weekly, extra-usage
   spend). Several people contribute (Stonly, Roscel, Miela).
2. **Session usage (public, anonymized):** closed-hour token/cost rollups from local
   transcripts, broken down by model, entrypoint, skill, MCP tool, subagent.
3. **Revival goal (2026-11-04, Stonly):** see in granular detail *where usage goes*
   (session → task → step) and find *candidates to move* tasks or task steps to a
   local model, another Cowork account, or another platform. The granular view is
   **private**; only anonymized rollups go to the public repo.

## Architecture (as built, unchanged since 2026-07-10)

| piece | what it does |
|---|---|
| `lib.js` | `anonId` (sha256→12 hex), `scrubEmail`, `flatten` of a `/usage` payload, dedupe key |
| `import.js` | raw browser snapshot → anonymized rows appended to `data/usage-log.jsonl` |
| `collector.js` | optional local HTTP collector (`:8787`) for direct POST from the browser |
| `session-lib.js` | transcript scan engine: group lines by `requestId` (usage repeats per content block), subagent files rolled under parent session, pricing, redaction, closed-hour rollup, validation |
| `session-usage.js` | CLI: `report --by=skill|mcp|model|session` (local, clear labels) · `import` (public rollup) · `validate` |
| `dashboard.html` | zero-dep viewer, published on GitHub Pages (urban-us-co/ts-federation-log) |
| `.claude/skills/log-usage/` (+ copy in `.agents/`) | browser gather → `scripts/log_and_push.sh` (PII grep gate → commit → push or fork+PR) |
| `.claude/skills/log-session-usage/` | `log_and_push_sessions.sh` — import → validate → PII gate → commit/push |
| `test/` | `node --test` (parse, rollup, CLI, docs) |

Governing spec for the hourly browser task: `~/Projects/specs/specs/federation-usage-log-hourly.md`
(owner roscel; invariants: raw snapshot outside repo, append-only, PII gate, skip-is-reported).
Build spec for session usage: `specs/codex/2026-07-09-session-usage-metrics.md`.

Zero runtime dependencies, CommonJS, Node stdlib only — keep it so.

## Data sources (verified 2026-11-04 on Stonly's Mac)

- **claude.ai limits** — only via the logged-in browser (`/api/organizations/{org}/usage`).
  No local file holds the 5h/weekly %, so this half needs a browser run.
- **Claude Code** — `~/.claude/projects/<slug>/<session>.jsonl` (+ `subagents/`).
  `entrypoint` = `cli` or `claude-desktop` (Code tab). 119 project dirs.
  Scheduled tasks run here under the slug `-Users-stonly-Claude-Scheduled`.
- **Cowork** — `~/Library/Application Support/Claude/local-agent-mode-sessions/<account-uuid>/<org-uuid>/<session>/.claude/projects/session/*.jsonl`
  (+ `subagents/`). `entrypoint` = `local-agent`. **Not scanned by `session-lib.js`
  today** (it defaults to `~/.claude/projects`), so the public session log has never
  contained Cowork usage — the `claude-desktop` rows are the Code tab.
  The account/org UUIDs in the path are the natural key for "which Cowork account".
- **Extra per-turn fields seen in Cowork transcripts** (not used yet): `effort`,
  `perTurnEffort`, `requestedModel`, `advisorModel`, `usage.server_tool_use`,
  `usage.service_tier`, `usage.speed`, `usage.fallback_credit` (always null so far),
  and `quotaLimits` — stamped only on ~15 of 74.7K turns, carrying `status`,
  `rateLimitType`, `resetsAt`, `isUsingOverage`, `overageStatus`. Good for
  "when did I hit a limit / go into overage" events, not for a running %.
- **Codex** — `~/.codex/sessions` (already ingested by mlx-monitor's tracker).
- **Sibling tracker** — `Misc/llm-cli/mlx-monitor/usage_tracker.py` (Python) already
  scans Claude Code + Cowork + Codex into daily per-model CSVs with counterfactual
  pricing and model-fit heuristics. Same transcripts, coarser grain (day × model).

## State on 2026-11-04

- **origin/main is alive**: Roscel's node still logs hourly (Third Sphere org, last
  row 2026-11-04 17:21Z; her personal org stopped 2026-08-21).
- **Stonly's node stopped 2026-08-01** (both datasets). Local checkout is stuck at
  2026-07-22 and 985 commits behind origin; no code changed on origin since 07-10,
  only data.
- **Local repo was damaged** (missing commit `6cae750`, blob `e05f28f`, dead
  worktree) — repaired in P0; now at origin/main `89cf832`. Branch
  `codex/session-usage-metrics` is gone upstream (merged as PR #1; safe to delete).
- **No federation scheduled task exists** in Cowork's scheduler or `~/.claude/scheduled-tasks`.
- README text says "Codex.ai" where it means "Claude.ai" (stray find-and-replace).
- Pricing table in `session-lib.js` is stale: `claude-opus-4` priced at 15/75 (older
  Opus list price), no entries for `claude-opus-5*` or `claude-haiku-5*` → those
  turns get `cost_usd: null`. VERIFY current list prices before changing.

## Revival plan (decided 2026-11-04)

| phase | what | status |
|---|---|---|
| P0 | Repair checkout: `git fetch --refetch`, ff to origin/main, prune dead worktree | ✅ 2026-11-04 (fsck clean, 12/12 tests) |
| P1 | `session-lib.js` scans Cowork too (`scanCowork`, `scanAllSources`); streaming reader; extra per-turn fields; `report --by=source|account` | ✅ 2026-11-04 (19/19 tests) — not committed yet |
| P2 | Pricing refresh (opus-5*, haiku-5*, current Opus list price) — VERIFY on the pricing page; until then most turns report `cost_usd: null` | next |
| P3 | Private per-turn ledger (`session-usage.js ledger` → gitignored `local/`), task attribution (scheduled-task id from cwd/slug, Cowork session title if readable), step = tools/MCP/subagent | |
| P4 | Offload-candidate scorer + tests: high input/cache-read with small output, repetitive scheduled tasks, mechanical tool patterns, subagents on top-tier models → suggested target (local gemma / Haiku-Sonnet / other account / Codex) | |
| P5 | Private claude.ai **Dashboard** artifact fed with aggregates from the ledger (task/skill labels, no prompt text) | |
| P6 | Scheduling: launchd hourly sweep (import + ledger + validate + push); Cowork scheduled task every **4h** for the browser limits snapshot; refresh README ("Codex.ai" typo), update the governing spec's cadence note with its owner (roscel) | |

Design rules carried forward: append-only public log, PII gate before every commit,
local labels never leave the Mac except as Dashboard aggregates, zero runtime deps.

### P1 as built

- `scanCowork(root)` walks only `<acct>/<org>/<session>/.claude/projects/**` —
  skips `audit.jsonl`, `outputs/`, `uploads/` (the Cowork root is 9.1 GB, mostly non-transcript).
- `scanAllSources(env)`: Claude Code + Cowork. Hermetic rule: an explicit
  `TS_PROJECTS_DIR` without `TS_COWORK_DIR` scans only that tree; `TS_COWORK_DIR=off`
  disables Cowork. `report` and `import` now use it.
- New per-turn fields (private use; public rollup unchanged): `source`,
  `account_uuid`, `org_uuid`, `effort`, `requested_model`, `advisor_model`,
  `service_tier`, `web_search_requests`, `web_fetch_requests`, `is_api_error`, `quota`.
- `readJsonl` streams 1 MB chunks and filters lines as Buffers on `"assistant"` —
  fixes `ERR_STRING_TOO_LONG` on a 699 MB Claude Code transcript (likely why the old
  scan stopped working). Full real scan: 122,287 turns (85,124 Cowork, 37,163 Claude
  Code) in 6.7 s; one Cowork account (`aade0427/57d1656a`) on this Mac.
- Dry-run public import (to /tmp, not the tracked log) produced 21,611 valid rows —
  ~9× the current file. **Not written.** Publishing Cowork rows is a separate OK.
- Tests: `test/session-lib.cowork.test.js` (6), `test/session-lib.stream.test.js` (1),
  fixtures under `test/fixtures/cowork/` incl. decoy audit/output files.

## Decisions log

- 2026-07-09 — session usage built by Codex worker per spec; public rows hash
  namespaced skills and all MCP labels; local report keeps clear labels.
- 2026-11-04 — revival decisions (Stonly): **background sweep** (launchd reading
  transcripts) instead of an in-session log step — every session is covered with no
  token cost; **browser limits snapshot every 4h** (hourly is what Roscel's node and
  the spec use); **extend the Node engine here** — mlx-monitor's Python tracker stays
  as is and may read the ledger later; **private view = private claude.ai Dashboard**
  (aggregated task/skill labels get uploaded there; raw prompts never).
- 2026-11-04 — reading other sessions' raw transcript/audit content from a shell
  was blocked by the auto-mode classifier; structure/key inspection and the
  aggregate report were allowed. Cowork session titles/scheduled-task ids (for P3)
  need a permission rule or a metadata-only read.
