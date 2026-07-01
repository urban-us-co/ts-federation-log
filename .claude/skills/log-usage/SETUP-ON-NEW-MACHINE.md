# Set up the hourly contribution on another machine

Paste the prompt below into Claude Code (the desktop/app build — `/schedule`
tasks run inside the open app, where the connected Chrome is reachable) on the
other machine. It locates the repo (clones it if missing), then creates the same
recurring hourly task that captures a Claude.ai usage snapshot and contributes
it to this log.

Notes before you run it:

- **Clone protocol:** the prompt clones over **HTTPS**. If that machine uses SSH
  for GitHub, tell Claude to use `git@github.com:urban-us-co/ts-federation-log.git`.
- **Contribution path is automatic:** with write access it pushes to `main`;
  otherwise the helper forks via `gh` and opens a **pull request** (so that
  machine needs `gh auth login`).
- **Each machine contributes an independent series** — every row self-identifies
  by user×org, so running this on several machines is expected and additive.
- **At fire time** the app must be open and Chrome logged in to claude.ai, or the
  run skips quietly.

---

```text
Set up the hourly "ts-federation-log" Claude usage contribution on this machine.

STEP 1 — Locate the repo (don't assume a path):
- Search likely locations for a checkout of github.com/urban-us-co/ts-federation-log
  (it contains import.js, lib.js, and .claude/skills/log-usage/SKILL.md).
  Try: `find ~ -maxdepth 6 -type d -name ts-federation-log 2>/dev/null` and check
  each hit with `git -C <dir> remote get-url origin`.
- If you find it, confirm the remote is urban-us-co/ts-federation-log and note its
  absolute path as REPO.
- If it's NOT found, ask me where to clone it, then:
  `git clone https://github.com/urban-us-co/ts-federation-log.git` and use that as REPO.
- Print the resolved REPO path before continuing.

STEP 2 — Read the skill so you set things up correctly:
- Read REPO/.claude/skills/log-usage/SKILL.md (especially the
  "Run it hourly (participation)" section).

STEP 3 — Create the recurring task via Claude Code's /schedule (the
scheduled-tasks tools), cron "7 * * * *", id "federation-usage-log-hourly",
notifyOnCompletion false. If a task with that id already exists, UPDATE it
instead of creating a duplicate. Use this exact run prompt (it must be fully
self-contained — substitute the real REPO path you resolved in Step 1):

  """
  Capture a Claude.ai usage snapshot and contribute it to the ts-federation-log
  time series (hourly federation contribution).
  REPO: <ABSOLUTE REPO PATH>
  Prefer the project skill "log-usage" — read REPO/.claude/skills/log-usage/SKILL.md and follow it.
  SYNC FIRST: from REPO run `git pull --rebase --autostash origin main` to pull the latest code + rows before contributing. The log is append-only — rebase, never merge; if it conflicts on data/usage-log.jsonl take the union of both sides then `git rebase --continue`, or `git rebase --abort` and continue (the helper rebases again before pushing).
  PRECONDITION: needs a logged-in claude.ai session in the connected Chrome (Claude in Chrome).
  If no browser is connected or /api/account returns empty, SKIP quietly — report "gathering unavailable, skipped", do NOT error or commit.
  GATHER via the Claude-in-Chrome javascript_tool only (never screenshot/get_page_text/read_page on claude.ai — they hang):
   1) list_connected_browsers; if none, skip.
   2) navigate a tab to https://claude.ai/new.
   3) Use TOP-LEVEL await (an IIFE returns {}); the tool truncates at ~1000 chars, so stash on window.__snap and pull back in <900-char slices, then reassemble.
   4) Build one raw record per org that has a usage surface:
      const ts=new Date().toISOString();
      const acct=await fetch('/api/account',{credentials:'include',headers:{accept:'application/json'}}).then(r=>r.json());
      const orgs=(acct.memberships||[]).map(m=>({uuid:m.organization.uuid,name:m.organization.name}));
      const recs=[]; for(const o of orgs){const u=await fetch(`/api/organizations/${o.uuid}/usage`,{credentials:'include',headers:{accept:'application/json'}}).then(r=>r.json()); if(!u||!u.five_hour)continue; recs.push({ts,recorded_by:"scheduled",user_uuid:acct.uuid,user_email:acct.email_address,user_name:acct.full_name,org_uuid:o.uuid,org_name:o.name,raw:u});}
      window.__snap=recs.map(r=>JSON.stringify(r)).join("\n");
      JSON.stringify({ts,n:recs.length,totalLen:window.__snap.length})
   5) Retrieve window.__snap in <900-char slices, concatenate, verify joined length === totalLen and every line JSON.parses.
  LOG + CONTRIBUTE:
   6) Write the reassembled JSONL to a file OUTSIDE the repo (e.g. /tmp/usage-<ts>.jsonl) — it holds raw email/uuid; import.js anonymizes before anything touches the tracked log.
   7) From REPO run: .claude/skills/log-usage/scripts/log_and_push.sh /tmp/usage-<ts>.jsonl
      (anonymizes + de-dupes + PII-checks, then direct-pushes to main if you have write access, else forks via gh and opens a PR).
  REPORT: orgs captured (5-hour %, weekly %, spend %), rows added vs skipped, and whether it pushed (commit hash) or opened a PR (URL) — or that it skipped (no logged-in browser).
  """

STEP 4 — Tell me to click "Run now" once in the Scheduled sidebar to pre-approve
the tools (Claude-in-Chrome + the helper's bash) so future hourly runs don't
pause on permission prompts, and remind me the app + a logged-in Chrome must be
open when the task fires.
```
