# ts-federation-log

Log Claude.ai usage limits (5-hour window, weekly all-models, Sonnet-only,
extra-usage spend) to a local time-series that drives a
dashboard or chart. Built to collect from **multiple users / orgs** into one log. 
The goal is to help share pooled Claude Pro account and token resources across trusted peers. 
This is just the log that drives our Federation. 

## Join the Federation

The "federation" is the pooled log of usage across many Claude accounts. **Today
it's just tracking** — a shared time series of how close each user/org is to
their 5-hour, weekly, and spend limits, visualized in the
[dashboard](https://urban-us-co.github.io/ts-federation-log/dashboard.html).
**The vision:** once enough accounts contribute, that shared signal can be used
to *load-balance token and plan usage across accounts* — route work to whoever
has headroom instead of hammering one account into a rate limit. We're not doing
the routing yet; we're building the data that would make it possible.

To join, contribute your own snapshots:

1. **Clone the repo** and install deps (there are none beyond Node):
   ```bash
   git clone https://github.com/urban-us-co/ts-federation-log.git
   cd ts-federation-log
   ```
2. **Run the skill.** In Claude Code (with the `log-claude-usage` skill — it
   lives in `.claude/skills/` so it's available the moment you clone) just ask:
   *"log my Claude usage"*. It reads your live claude.ai session, anonymizes
   (hashes UUIDs/emails, scrubs names), appends a row per org, and contributes it.
3. **How your data lands depends on your access:**
   - **Write access** → the row is committed and pushed straight to `main`.
   - **No write access** (the default for new joiners) → the skill forks the
     repo, pushes a branch to your fork, and opens a **pull request** with your
     anonymized rows. A maintainer merges it. This needs the
     [`gh` CLI](https://cli.github.com) authenticated (`gh auth login`).
4. **Keep it running — hourly.** A one-off snapshot is a dot; the pool needs a
   continuous signal, so participants contribute **hourly**. On first run the
   skill offers to set this up via Claude Code's **`/schedule`** feature as a
   recurring hourly task. Scheduled tasks run inside the open app with your
   connected Chrome available, so they can read your logged-in claude.ai session
   — just keep the app open and Chrome logged in (a run due while the app is
   closed happens on next launch). Click **"Run now"** once after creating the
   task to pre-approve the tools it uses.

**Participation is proportional to contribution:** drawing on the shared pool
(once routing exists) is gated on contributing a verified, ongoing log. No
verified logs, no pool access.

Only anonymized rows ever leave your machine — raw UUIDs and emails are hashed
or scrubbed at ingest (see `lib.js`), so the public log carries stable
`user_id`/`org_id` hashes and display names, never the underlying identifiers.

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

## Dashboard

`dashboard.html` is a self-contained (no-dependency) viewer for the log:
current-state indicator cards per user×org (5-hour / weekly / Sonnet / spend,
colored by severity) plus an interactive time-series chart with a metric
selector, per-series toggles, and hover tooltips. Serve the repo so it can
fetch the tracked log, then open `/dashboard.html`:

```bash
python3 -m http.server 8801   # then visit http://localhost:8801/dashboard.html
```

Opened directly via `file://`, `fetch` is blocked — drag a `usage-log.jsonl`
onto the page (or use the browse link) instead.

## Files

| file | tracked? | purpose |
|------|----------|---------|
| `collector.js` | yes | local HTTP collector (append to log, serve `/log`) |
| `import.js` | yes | ingest downloaded snapshots into the log |
| `dashboard.html` | yes | no-dependency viewer — indicators + time-series chart |
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
