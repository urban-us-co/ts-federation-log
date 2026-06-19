# ts-federation-log

Log Claude.ai usage limits (5-hour window, weekly all-models, Sonnet-only,
extra-usage spend) to a local time-series file you can later turn into a
dashboard or chart. Built to collect from **multiple users / orgs** into one log.

## How it works

The numbers shown on `claude.ai` Settings → Usage come from an authenticated
endpoint: `GET /api/organizations/{org_uuid}/usage`. A small browser snippet
reads your live session (no stored cookie), pulls usage for **every org you
belong to**, and records a snapshot.

```
  claude.ai (logged in)
        │  usage-logger.js  (bookmarklet / console)
        │  fetch /api/account + /api/organizations/*/usage
        ▼
   ┌─────────────┐   POST (if allowed)      ┌──────────────┐
   │   snapshot  │ ───────────────────────▶ │ collector.js │──┐
   │  (records)  │                          └──────────────┘  │ append
   │             │ ──download usage-*.jsonl──▶ import.js ──────┤
   └─────────────┘                                            ▼
                                            data/usage-log.jsonl  (the log)
```

### Two ways the snapshot reaches the log

1. **Download + import (reliable).** Chrome's *Local Network Access* protection
   blocks `claude.ai → localhost` requests unless you grant a per-session prompt,
   so by default the snippet **downloads** a `usage-*.jsonl` file. Ingest it with:
   ```bash
   node import.js                 # auto-imports usage-*.jsonl from ~/Downloads
   node import.js path/to/file.jsonl
   ```
   `import.js` flattens, de-dupes (by user+org+timestamp), and appends — safe to
   re-run.

2. **Direct POST (optional).** If you run the collector and approve the Chrome
   local-network prompt, the snippet POSTs straight to it — no download step.
   ```bash
   npm start            # node collector.js  -> http://127.0.0.1:8787
   ```

## Setup

1. **Get the snippet** (kept out of git): open `usage-logger.bookmarklet.txt`,
   make a bookmark, paste the `javascript:` line as its URL. (Or paste
   `usage-logger.js` into the DevTools console on claude.ai.)
2. Click the bookmark while on `claude.ai` — a usage table prints to the console,
   and a snapshot is logged (POST) or downloaded.
3. If downloaded: `node import.js`.

## The log format (`data/usage-log.jsonl`)

One JSON object per line — each self-identifies the user and org:

| field | meaning |
|-------|---------|
| `ts` | snapshot time (ISO) |
| `user_id`, `user_name` | who recorded it — UUID/email hashed into a stable `user_id`; raw UUID/email never written |
| `org_id`, `org_name` | which org — UUID hashed into `org_id`; emails scrubbed from the name |
| `five_hour_pct`, `five_hour_resets_at` | 5-hour session limit |
| `weekly_all_pct`, `weekly_all_resets_at` | weekly all-models limit |
| `weekly_sonnet_pct`, `weekly_sonnet_resets_at` | Sonnet-only weekly sub-limit |
| `spend_used_usd`, `spend_limit_usd`, `spend_pct` | extra-usage / credits |
| `extra_usage_enabled` | whether extra usage is on |
| `raw` | the full untouched `/usage` payload (future-proofing) |

A future UI can read `data/usage-log.jsonl` (or `GET /log` from the collector)
and chart utilization over time per user/org.

## Files

| file | tracked? | purpose |
|------|----------|---------|
| `collector.js` | yes | local HTTP collector (append to log, serve `/log`) |
| `import.js` | yes | ingest downloaded snapshots into the log |
| `lib.js` | yes | shared flatten / dedupe helpers |
| `package.json` | yes | `npm start`, `npm run import` |
| `usage-logger.js` | **no** (gitignored) | the browser snippet |
| `usage-logger.bookmarklet.txt` | **no** (gitignored) | one-line bookmarklet |
| `data/usage-log.jsonl` | yes | the usage log — shared publicly via this repo |

## Notes / caveats

- `/api/...` is an internal, undocumented endpoint — Anthropic can change it.
- The log (`data/usage-log.jsonl`) is **tracked and shared publicly** via this
  repo. UUIDs and email addresses are hashed/scrubbed at ingest (see `lib.js`),
  so the public log carries stable `user_id`/`org_id` hashes plus display names
  (`user_name`, `org_name`) — never raw UUIDs or emails.
- For shared collection, run **one** collector instance that everyone POSTs to
  (appends are serialized in-process), or have each person `import.js` their
  downloads into a shared `LOG_FILE`.
