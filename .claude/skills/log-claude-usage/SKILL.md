---
name: log-claude-usage
description: >-
  Capture a Claude.ai usage snapshot — the 5-hour session limit, weekly
  all-models limit, Sonnet-only weekly sub-limit, and extra-usage/credit spend —
  from a logged-in browser, append it as an anonymized row to the
  ts-federation-log time-series, then commit and push. Use this whenever the
  user wants to log, record, snapshot, or capture Claude usage; update or
  refresh the usage log / federation log; save current usage limits or
  rate-limit headroom over time; or run "the usage logger". Triggers on phrases
  like "log my usage", "snapshot my Claude usage", "update the usage log",
  "record my current limits", "how much have I used and save it", or "run the
  federation log" — even if the user doesn't name the repo, as long as the
  intent is to record Claude usage over time.
---

# Log Claude usage

Record a point-in-time snapshot of Claude.ai usage limits into the
`ts-federation-log` time-series and publish it. Three phases: **gather** (from a
logged-in browser), **log** (anonymize + append), **publish** (commit + push).

The usage numbers shown on claude.ai Settings → Usage come from an authenticated
endpoint. We read it straight from the logged-in browser session, normalize and
anonymize via the repo's `import.js`, and append one row per org to
`data/usage-log.jsonl`.

## Prerequisites

- The **ts-federation-log** repo checked out (contains `import.js`, `lib.js`,
  `data/usage-log.jsonl`). Run from its root; if you're elsewhere, locate it
  (`git rev-parse --show-toplevel` from within it) and pass the path along.
- **Claude in Chrome** connected, with the user **logged in to claude.ai** in
  that browser. (Alternative without browser automation: the user runs the
  `usage-logger` bookmarklet themselves — see "Manual gathering" below.)

## Phase 1 — Gather (Claude in Chrome)

The goal is a set of **raw records**, one per org, shaped like this (the exact
shape `import.js` expects):

```json
{"ts":"<ISO timestamp>","recorded_by":"skill","user_uuid":"…","user_email":"…","user_name":"…","org_uuid":"…","org_name":"…","raw":{ …the /usage payload… }}
```

Hard-won lessons — follow these or you'll waste time:

- **Use `javascript_tool` for everything.** Do NOT use `screenshot`,
  `get_page_text`, or `read_page` on claude.ai — that page holds streaming
  connections open and never reaches `document_idle`, so those tools hang for
  45s and fail. `javascript_tool` runs immediately regardless.
- **Don't drive the Settings UI.** The modal won't open from a URL
  (`/settings/usage` redirects to the chat), and clicking React menus
  programmatically is unreliable. Go straight to the API.
- **Don't POST from the page to a localhost collector.** Chrome's Local Network
  Access protection blocks claude.ai → localhost and the request *hangs* (not a
  fast error), even with CORS/PNA headers. We pull the data out via the tool
  return instead.

Steps:

1. Confirm a browser: `list_connected_browsers`. If none, ask the user to open
   Chrome with the extension and log in to claude.ai.
2. `navigate` a tab to `https://claude.ai/new` (any logged-in claude.ai page is
   fine). You don't need the page to finish loading.
3. **Identity + org list** — one `javascript_tool` call:
   ```js
   (async () => {
     const a = await fetch('/api/account', {credentials:'include', headers:{accept:'application/json'}}).then(r=>r.json());
     return JSON.stringify({uuid:a.uuid, email:a.email_address, name:a.full_name,
       orgs:(a.memberships||[]).map(m=>({uuid:m.organization.uuid, name:m.organization.name}))});
   })()
   ```
   If this is empty / errors, the user isn't logged in — stop and tell them.
4. **Per-org usage** — for each org, a separate `javascript_tool` call. Fetch one
   org at a time on purpose: a single call returning every org's full payload can
   exceed the tool-result size limit and get truncated, corrupting the data.
   ```js
   (async () => (await fetch('/api/organizations/ORG_UUID/usage',
     {credentials:'include', headers:{accept:'application/json'}}).then(r=>r.json())))()
   ```
   Skip any org whose payload has no `five_hour` key (no usage surface).
5. Assemble the raw records (identity from step 3 + org name/uuid + that org's
   `raw` payload), using a single `ts` for the whole snapshot, and
   `"recorded_by":"skill"`.

### Manual gathering (no browser automation)

If Claude in Chrome isn't available, have the user click the `usage-logger`
bookmarklet on claude.ai. It downloads a `usage-*.jsonl` file to `~/Downloads`.
Skip to Phase 2 using that file (or let `node import.js` with no args auto-scan
`~/Downloads`).

## Phase 2 — Log (anonymize + append)

Write the raw records to a snapshot file **outside the repo** — e.g. the session
scratch dir or `/tmp/usage-<ts>.jsonl`. This matters: the snapshot holds the raw
email/uuid, and `data/` is tracked, so never write raw records inside the repo.
`import.js` is the only thing that writes to the tracked log, and it anonymizes
first (hashes uuid/email → `user_id`/`org_id`, scrubs emails from name fields).

Then run the helper, which ingests, sanity-checks for leaked PII, commits, and
pushes:

```bash
.claude/skills/log-claude-usage/scripts/log_and_push.sh /tmp/usage-<ts>.jsonl
```

Or do the steps by hand if you want more control:

```bash
node import.js /tmp/usage-<ts>.jsonl     # prints "Imported N / skipped M / X invalid"
```

## Phase 3 — Publish (commit + push)

`log_and_push.sh` already commits (`log: usage snapshot <ts> (<N> total rows)`)
and pushes to `origin`. If you ran `import.js` by hand:

```bash
git add data/usage-log.jsonl
git commit -m "log: usage snapshot <ts> (<N> total rows)"
git push
```

The helper refuses to commit if it finds an email address in the log — a
backstop against accidental PII. If that fires, inspect `lib.js`'s scrubbing
rather than forcing the commit.

## Report back

Tell the user, concisely:
- which orgs were captured and their key numbers (5-hour %, weekly %, spend),
- how many rows were added vs skipped,
- the commit hash and that it pushed.

## Notes

- `/api/...` is an internal, undocumented endpoint — if a fetch shape changes,
  re-derive it from the live page, then update this skill.
- Each run is a new time-series point (new `ts`), so repeated runs in the same
  window are expected and not de-duped against each other; de-dupe only prevents
  re-importing the *same* file twice.
- Don't change what's anonymized here — that lives in `lib.js` so the POST path
  (collector.js) and this skill stay consistent.
