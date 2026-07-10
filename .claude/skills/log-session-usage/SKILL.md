---
name: log-session-usage
description: Capture local Claude Code / Cowork transcript usage, append anonymized closed-hour rows, and contribute them to ts-federation-log.
---

# Log Session Usage

This skill records token and estimated-cost usage from local session transcripts.
It needs no browser and no claude.ai page: it reads local files under
`~/.claude/projects/**/*.jsonl`.

## What It Logs

- Per closed hour token totals and computed cost.
- Breakdowns by skill, MCP tool, model, entrypoint, session, and subagent source.
- Public rows in `data/session-usage-log.jsonl`.

Local reports keep clear labels:

```bash
node session-usage.js report --by=skill
```

Public imports hash namespaced skill labels and all MCP labels:

```bash
node session-usage.js import
node session-usage.js validate data/session-usage-log.jsonl
```

Set `TS_FED_IDENTITY` to the same email used for the existing Codex usage log if
you want `user_id` to line up across both datasets.

## Contribute Snapshot

Run from repo root:

```bash
.claude/skills/log-session-usage/scripts/log_and_push_sessions.sh
```

The helper imports closed-hour rows, validates the tracked log, refuses to commit
if validation fails or an email appears in the public dataset, then commits
`log: session-usage snapshot <ts>`.

It uses the same contribution pattern as `log-usage`: direct push when GitHub says
you have push access, otherwise fork/branch/PR through `gh`.

## Schedule

This can reuse the existing hourly `/schedule` cadence. Scheduled runs only need
the local checkout and transcript files; no browser session is required.
