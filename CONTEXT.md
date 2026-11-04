# ts-federation-log — CONTEXT

Living architecture + decisions doc. Update with every shipped change (owner rule:
nothing ships without an update to this file and the test suite). `README.md` stays
the public "how to join / how it works" page; this file is the working memory.
This repo is **public**: keep account ids, task titles and dollar figures from a
person's ledger out of this file.

## Purpose

1. **Federation (public):** a shared time series of how close each user/org is to
   their claude.ai limits (5-hour, weekly, Sonnet weekly, extra-usage spend).
   Several people contribute.
2. **Session usage (public, anonymized):** closed-hour token/cost rollups from local
   Claude Code **and Cowork** transcripts, by model, entrypoint, skill, MCP tool,
   subagent.
3. **Where usage goes (private, added 2026-11):** a per-turn ledger labelled by
   task (scheduled task / Cowork session / Claude Code project) and step (subagent /
   skill / connector tool / built-in tools), plus ranked **offload candidates**:
   work that could move to a local model, a script, a cheaper model, a Codex worker
   or another Cowork account. Never committed; shown on a private claude.ai
   Dashboard as aggregates.

## Architecture

| piece | what it does |
|---|---|
| `lib.js` | `anonId` (sha256→12 hex), `scrubEmail`, `flatten` of a `/usage` payload, dedupe key |
| `import.js` | raw browser snapshot → anonymized rows appended to `data/usage-log.jsonl` |
| `collector.js` | optional local HTTP collector (`:8787`) for direct POST from the browser |
| `session-lib.js` | transcript engine: streaming reader, group lines by `requestId`, subagents rolled under the parent session, Claude Code + Cowork scan, pricing, redaction, closed-hour rollup, validation |
| `ledger.js` | PRIVATE: Cowork session metadata (labelling fields only) → per-turn `task`/`step`/`tier` labels |
| `score.js` | offload rules (`RULES`, `candidates`, `savingsEstimate`), UMD: used by `offload.js` in Node AND uploaded as the Dashboard's `files/score.js` — one implementation |
| `offload.js` | PRIVATE: `summarize` (fixed-window summary for the CLI), `dashboardFiles` (v1 files, kept for the CLI) |
| `facts.js` | PRIVATE: `buildFacts` → hour-grain fact rows + session-day rows; label policy `clear`/`hashed` (HMAC with the person's own salt; MCP steps keep `read`/`act`/`interactive` so rules still work) |
| `sync.js` | multitenant: `push` (encrypt closed days to `tenants/<tenant>/<machine>/<day>.enc`), `collect` (owner decrypts + merges), `init-recipient`, `init-tenant`, `fingerprint`, `verify` |
| `session-usage.js` | CLI: `report --by=skill|mcp|model|session|source|account` · `import` (public) · `validate` · `ledger` (private → `local/`) |
| `dashboard.html` | public zero-dep viewer (GitHub Pages) |
| `.claude/skills/log-usage/` (+ `.agents/` copy) | browser gather → `scripts/log_and_push.sh` (PII gate → commit → push or fork+PR) |
| `.claude/skills/log-session-usage/` | `log_and_push_sessions.sh` (import → validate → staged-file gate → envelope verify → PII gate → push), `scripts/sweep.sh` (hourly), `scripts/onboard.sh`, `SETUP-NEW-MACHINE.md`, `com.thirdsphere.federation-sweep.plist` |
| `tenants/` (public, encrypted) | `recipient.pub.pem` + `<tenant>/<machine>/<YYYY-MM-DD>.enc` |
| `local/` (gitignored) | `ledger.jsonl`, `summary.json`, `dashboard/{facts.csv,sessions.csv,tenants.json}`, `identity`, `tenant.json` (machine id + salt + pinned fingerprint), `recipient.key.pem` (owner only), `sweep.log` |
| `test/` | `node --test` — 44 tests |

Governing spec for the browser snapshot task: `~/Projects/specs/specs/federation-usage-log-hourly.md`
(owner roscel; invariants: raw snapshot outside repo, append-only, PII gate, skip-is-reported).
Build spec for session usage: `specs/codex/2026-07-09-session-usage-metrics.md`.
Zero runtime dependencies, CommonJS, Node stdlib only.

## Data sources

- **claude.ai limits** — only via the logged-in browser (`/api/organizations/{org}/usage`).
- **Claude Code** — `~/.claude/projects/<slug>/<session>.jsonl` (+ `subagents/`);
  `entrypoint` `cli` / `claude-desktop` (the Code tab).
- **Cowork** — `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<org>/<session>/.claude/projects/session/*.jsonl`
  (+ `subagents/`); `entrypoint` `local-agent`. Per-session metadata sits beside the
  session dirs as `<account>/<org>/local_<id>.json`; `cliSessionId` = the transcript's
  sessionId. `ledger.js` reads ONLY `title`, `scheduledTaskId`, `sessionType`,
  `parentSessionId`, `createdAt`, `effortOverride` — the file also holds the system
  prompt, first message and account email, which are never copied.
- Extra per-turn fields kept privately: `effort`, `requested_model`, `advisor_model`,
  `service_tier`, `speed`, `inference_geo`, web search/fetch counts, `quota` (limit
  events: `status`, `rateLimitType`, `isUsingOverage` — rare, only when a limit state
  is reported).
- **Codex** — `~/.codex/sessions`, not scanned here yet (mlx-monitor's tracker reads it).
- **Sibling tracker** — `Misc/llm-cli/mlx-monitor/usage_tracker.py` (day × model CSVs);
  left as is by decision; may read `local/ledger.jsonl` later.

## Pricing

`PRICING` in `session-lib.js`: API list prices per MTok from
platform.claude.com/docs/en/about-claude/pricing, verified 2026-11-04. Newer models
carry explicit cache rates (they break the old 1.25× / 2× / 0.1× ratios); Haiku 5.5
has a long-prompt tier above 100K prompt tokens. First matching prefix wins, so
`claude-opus-4-5…4-8` ($5/$25) sit above `claude-opus-4` ($15/$75 for Opus 4/4.1).
Not priced: fast mode and US-only inference (fields recorded; none seen so far).
On a subscription seat these are "what it would cost on the API", not cash.
Public rows freeze `cost_usd` at import (the dedupe key excludes cost), so rows
published before 2026-11-04 carry the old Opus 4.x price.

## Running it

- **Hourly, no tokens** — launchd `com.thirdsphere.federation-sweep` runs
  `sweep.sh`: pull --rebase → `ledger` rebuild → `sync.js push` (stages this
  machine's new closed days) → helper (public closed-hour import, gates, one commit,
  push) → `sync.js collect` on the machine holding `local/recipient.key.pem`.
  Identity from `TS_FED_IDENTITY` or `local/identity` (must stay constant or the
  public series splits). Log: `local/sweep.log`.
- **Every 4 hours (Cowork scheduled task `federation-usage-snapshot-4h`)** — Part A:
  claude.ai limits snapshot via Claude in Chrome → `log_and_push.sh`. Part B (at most
  daily): upload `facts.csv`, `sessions.csv`, `tenants.json` to the private
  Dashboard, repoint its three datasets, delete the previous files.
- **New machine / person** — `SETUP-NEW-MACHINE.md` prompt → `onboard.sh`.
- By hand: `node session-usage.js report --by=account`, `node session-usage.js ledger --top=20`,
  `node sync.js collect`.

## Multitenant sync (2026-11)

- **Why encrypted in the public repo**: chosen over a private repo (owner's call).
  Asymmetric, so contributors share no secret: each machine encrypts to the owner's
  RSA-4096 public key; only `local/recipient.key.pem` decrypts. **Back that key up**
  (e.g. a password manager): losing it makes every other machine's history unreadable;
  replacing it needs every machine to re-pin the new fingerprint.
- Envelope: RSA-OAEP-SHA256-wrapped AES-256-GCM key, gzip(JSON) body, header
  (`v, kid, tenant, machine, day`) bound as AAD. `verify` accepts only that exact shape.
- **Pinning**: `onboard.sh` refuses unless `tenants/recipient.pub.pem` matches the
  fingerprint given out of band; `push` re-checks it every run, so a swapped key in
  the repo stops pushes instead of encrypting to someone else.
- **Append-only days**: only closed UTC days, each written once (~11 KB). The owner's
  own machine pushes too (encrypted backup) but `collect` uses its local ledger for
  itself, so today is live for the owner and other machines arrive a day behind.
- **Labels**: other people are `hashed` (owner's decision: always hashed). HMAC-SHA256
  with a per-person salt in `local/tenant.json`, so guessing likely task names and
  hashing them doesn't reveal anything. Built-in tool names and bare subagent types
  stay readable; connector tool names collapse to `mcp`; MCP steps keep
  `read`/`act`/`interactive`. The owner's machines are `clear`.
- **Limits**: a machine without push access would open a PR every hour — onboarding
  requires collaborator access. Rows the PR flow would need are not handled.

## Dashboard v2 (2026-11)

Datasets `facts` (CSV, ~29K rows / 6 MB for 5 months on one machine), `sessions`
(CSV), `tenants` (JSON); page files `index.html` + `score.js`. All filtering is in
the page, in the viewer's local time: date presets + from/to, time-of-day range
(wraps past midnight), weekdays/weekends, session type (Scheduled / On demand /
Dispatched / Claude Code), person, account. Filters are `dash.setParams` names no
query uses, so they redraw without refetching. Sessions are counted from
session-day rows by start time. Candidates are re-scored on the filtered rows with
the same `score.js` the CLI uses; a Node harness run on real data matched the CLI
(30 days: same cost to the dollar, sessions within 1, identical savings estimate).

## Offload rules (offload.js `RULES`)

Buckets under 20 turns are ignored. Per task × step: **local-model** (text-only or
read/search-only steps with short outputs, not on Haiku) · **script-it** (read-like
connector calls — search/fetch/get/list/read/query/find — excluding shell, browser,
desktop and Cowork servers) · **downshift-subagent** (subagents on Opus/Fable →
Haiku 5.5, re-priced) · **codex** (heavy edit turns on a top tier). Per task:
**downshift-scheduled** (≥3 runs mostly on Opus/Fable → Sonnet 5.5, re-priced) and
**other-account** (top 5 scheduled tasks by tokens; frees limit, saves no money).
`savingsEstimate` takes, per task, the larger of the whole-task saving and the sum of
its step savings, so overlapping candidates don't inflate the headline.
Re-pricing assumes the same tokens on the cheaper model — a lead to test, not a result.

## Decisions log

- 2026-07-09 — session usage built by a Codex worker per spec; public rows hash
  namespaced skills and all MCP labels; local report keeps clear labels.
- 2026-11-04 — revival (Stonly): **background sweep** instead of an in-session log
  step (every session covered, no token cost); **browser limits snapshot every 4h**;
  **extend the Node engine** here, not mlx-monitor; **private view = private claude.ai
  Dashboard** (aggregated task/step labels uploaded; prompts never). **Publish Cowork
  rows to the public log** (approved; backfill of 19,561 rows pushed as `5240ccb`).
- 2026-11-04 — P0 repaired the local clone (missing commit/blob; `git fetch
  --refetch` + ff). P1 Cowork scan + streaming reader (a ~700 MB transcript broke
  `readFileSync` with `ERR_STRING_TOO_LONG`). P2 pricing. P3 ledger. P4 scorer.
  P5 Dashboard. P6 launchd sweep + 4h task.
- 2026-11-04 — reading other sessions' raw transcript/audit content into a chat was
  blocked by the auto-mode classifier; code that extracts only labels into the
  private ledger is the pattern to keep.

- 2026-11-04 — Dashboard v2 with client-side filters (Option A) + multitenant sync
  through this repo, encrypted (owner chose encrypted-in-public over a private repo,
  and "always hashed" for other people). Recipient key fingerprint
  `006d2850ff552a910b64664cb30c32cfd2b4f6c7c2a476cb10805c4ef6428f53`.

## Open items

- [ ] Tell roscel (spec owner) this node snapshots every 4h, not hourly.
- [ ] README still says "Codex.ai" for "Claude.ai" in places (stray find-and-replace).
- [ ] Codex sessions as a third source; second Cowork account appears automatically
      once used on this Mac (path key = account/org).
- [ ] Tune `RULES` after the first moves are tried; record outcomes here.
- [ ] Optional: show the limits snapshot series on the private Dashboard.
