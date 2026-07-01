---
name: log-usage
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

## Run it hourly (participation)

The federation is only useful if it's continuous: a single snapshot is a dot, a
**verified hourly time series**.
So the expectation for participants is an **hourly** contribution. 

**On first run, offer to schedule it** (and explain the requirement), using
Claude Code's **`/schedule`** feature (the `scheduled-tasks` tools). Create a
recurring hourly task — cron `7 * * * *` — with a fully self-contained prompt
(scheduled runs start fresh with no memory of the setup session). The prompt
should: read this `SKILL.md` and follow it; gather via the Claude-in-Chrome
`javascript_tool` (top-level await, slice large payloads); write the raw snapshot
to a file outside the repo; run `scripts/log_and_push.sh`; and **skip quietly if
no logged-in claude.ai browser is available** rather than erroring.

Why `/schedule` and not a headless cron/launchd job: scheduled tasks run **inside
the open app**, in the same authenticated runtime with the **connected Chrome
available** — so they can actually read the logged-in claude.ai session. A purely
headless `claude -p` can't (no host-injected auth → 401), and a *cloud* routine
has no browser at all.

Operational notes:
- **Chrome must be open and logged in to claude.ai when the task fires**, and the
  app must be open (if it's closed at fire time, the run happens on next launch).
- After creating the task, have the user click **"Run now"** once from the
  Scheduled sidebar — that stores the tool approvals (Chrome MCP + the helper's
  bash) so later hourly runs don't pause on permission prompts.
- To change cadence or prompt, use `update_scheduled_task` (don't create a
  duplicate); `list_scheduled_tasks` finds the id.
- To set this up on another machine, a copy-paste prompt (locates the repo,
  clones if missing, then creates the task) lives in `SETUP-ON-NEW-MACHINE.md`
  next to this file.

## Keeping a node in sync

Each machine ("node") has its own checkout that drifts from `origin/main` as
other nodes push rows and as the skill / dashboard / helper get updated. Pull
before you contribute so every run uses the latest code and appends onto the
newest log. The hourly run does this automatically as its first step; to sync by
hand from the repo root:

```bash
git pull --rebase --autostash origin main
```

The log is **append-only**, so always **rebase, never merge** — a merge commit
on a shared append-only file is noise, and rebasing keeps this node's own
un-pushed rows stacked cleanly on top. `--autostash` tucks away any local edits
first; `--rebase` replays your local commits on top of what you fetched.

If a rebase ever conflicts on `data/usage-log.jsonl` (rare — appends seldom
collide), the correct resolution is the **union of both sides** (keep every row
from both), then `git rebase --continue`. If it gets messy, `git rebase --abort`
and pull again — the helper (`log_and_push.sh`) also rebases right before it
pushes, so a run still lands its row even if you skip the manual sync.

Note: the *scheduled-task prompt itself* lives in `~/.claude/scheduled-tasks/`,
outside the repo, so `git pull` won't refresh it. If the run procedure changes
materially, re-run the `SETUP-ON-NEW-MACHINE.md` prompt (it updates the existing
task in place) to update each node's prompt.

## Propagating code changes to the fleet

When you change the *code* — this `SKILL.md`, `scripts/log_and_push.sh`,
`dashboard.html`, `import.js`/`lib.js` — it reaches other nodes through **two
different channels**, and only one is automatic:

1. **Repo-tracked code → automatic via `git pull`.** Everything under version
   control travels with `git pull --rebase origin main`. Because the hourly task
   pulls as its first step (see above), every *scheduled* node picks up merged
   code changes within the hour — no per-node action needed. A node that only
   runs the skill manually gets the update on its next run (the helper) or
   whenever someone pulls. So: **merge to `main`, and scheduled nodes
   self-update.**

2. **The out-of-repo run prompt → manual refresh.** Each node's scheduled-task
   prompt is a *copy* stored in `~/.claude/scheduled-tasks/<id>/SKILL.md`, made
   when the task was created. `git pull` does **not** touch it. If a change alters
   *what the run does* (the gather steps, the helper path, the contribution
   flow), each node must refresh its task by re-running the
   `SETUP-ON-NEW-MACHINE.md` prompt — it calls `update_scheduled_task` and
   rewrites the prompt in place (it does not create a duplicate). Changes that
   only touch files the run *reads at runtime* (this `SKILL.md`, the helper
   script) need no prompt refresh, since the run pulls and re-reads them.

Rollout checklist for a code change:

- [ ] Commit + push to `main` (or land it via PR).
- [ ] Confirm it's on `origin/main` — that alone updates scheduled nodes on their
      next hourly pull.
- [ ] **Only if the run procedure changed:** on each node, re-run the
      `SETUP-ON-NEW-MACHINE.md` prompt to refresh that node's task prompt, then
      "Run now" once to re-approve any newly-needed tools.
- [ ] To push an update out immediately on a node instead of waiting for the
      hour: from its repo root run `git pull --rebase origin main`.

To see whether a node is behind: `git -C <repo> fetch -q && git -C <repo> log --oneline HEAD..origin/main`
(empty = up to date).

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
- **Use top-level `await`, not an IIFE.** `javascript_tool` has REPL
  semantics — it returns the value of the last expression. A
  `(async () => { … return X })()` wrapper resolves to a Promise the tool
  doesn't await, so it returns `{}`. Write the bare expression as the last line
  (e.g. `await fetch(...).then(r=>r.json())`, or a `JSON.stringify(...)`).
- **The tool truncates returns at ~1000 chars.** A full `/usage` payload is
  bigger than that, so reading it directly corrupts `raw`. Stash the assembled
  snapshot on a `window` var and pull it back out in <900-char slices, then
  reassemble (see step 5).
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
3. **Identity + org list** — one `javascript_tool` call (top-level await, no
   IIFE):
   ```js
   const a = await fetch('/api/account', {credentials:'include', headers:{accept:'application/json'}}).then(r=>r.json());
   JSON.stringify({uuid:a.uuid, email:a.email_address, name:a.full_name,
     orgs:(a.memberships||[]).map(m=>({uuid:m.organization.uuid, name:m.organization.name}))})
   ```
   If this is empty / errors, the user isn't logged in — stop and tell them.
4. **Assemble the whole snapshot in-page, stash it on `window`.** Loop over the
   orgs, fetch each `/usage` payload, build one raw record per org (skip any
   with no `five_hour` key), join as JSONL on `window.__snap`, and return only
   the lengths — never the payloads themselves (they'd truncate):
   ```js
   const ts = new Date().toISOString();
   const acct = await fetch('/api/account',{credentials:'include',headers:{accept:'application/json'}}).then(r=>r.json());
   const orgs = (acct.memberships||[]).map(m=>({uuid:m.organization.uuid, name:m.organization.name}));
   const recs = [];
   for (const o of orgs) {
     const u = await fetch(`/api/organizations/${o.uuid}/usage`,{credentials:'include',headers:{accept:'application/json'}}).then(r=>r.json());
     if (!u || !u.five_hour) continue;
     recs.push({ts, recorded_by:"skill", user_uuid:acct.uuid, user_email:acct.email_address, user_name:acct.full_name, org_uuid:o.uuid, org_name:o.name, raw:u});
   }
   window.__snap = recs.map(r=>JSON.stringify(r)).join("\n");
   JSON.stringify({ts, n:recs.length, totalLen:window.__snap.length})
   ```
5. **Pull `window.__snap` back out in slices** of <900 chars
   (`window.__snap.slice(0,900)`, `slice(900,1800)`, … up to `totalLen`) and
   concatenate them — that exact string is the snapshot file. After writing it,
   verify `joined.length === totalLen` and that every line `JSON.parse`s before
   importing; a mismatch means a slice was dropped or overlapped.

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
.claude/skills/log-usage/scripts/log_and_push.sh /tmp/usage-<ts>.jsonl
```

Or do the steps by hand if you want more control:

```bash
node import.js /tmp/usage-<ts>.jsonl     # prints "Imported N / skipped M / X invalid"
```

## Phase 3 — Publish (commit + contribute)

`log_and_push.sh` commits (`log: usage snapshot <ts> (<N> total rows)`) and then
contributes the row back, picking the path automatically based on the user's
access to `origin`:

- **Direct (has push access).** Commits to `main`, rebases onto any rows other
  contributors pushed in the meantime (the log is append-only, so this
  fast-forwards), and pushes.
- **Pull request (no push access).** This is the default for people who cloned
  the canonical repo without write access — "joining the federation." The helper
  forks the repo (via `gh`), pushes a `usage-<login>-<ts>` branch to the fork,
  and opens a PR upstream, then leaves the user back on a clean `main`. Needs the
  `gh` CLI authenticated (`gh auth login`); if it's missing the helper says so
  and stops. Maintainers merge the PR to land the row.

If you ran `import.js` by hand and have write access:

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
- whether it pushed directly (commit hash) or opened a PR (the PR URL).

## Notes

- `/api/...` is an internal, undocumented endpoint — if a fetch shape changes,
  re-derive it from the live page, then update this skill.
- Each run is a new time-series point (new `ts`), so repeated runs in the same
  window are expected and not de-duped against each other; de-dupe only prevents
  re-importing the *same* file twice.
- Don't change what's anonymized here — that lives in `lib.js` so the POST path
  (collector.js) and this skill stay consistent.
