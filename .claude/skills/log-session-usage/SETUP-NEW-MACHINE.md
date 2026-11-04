# Add a machine (or a person) to the usage map

Paste the prompt below into Claude (Cowork or Claude Code desktop) on the new
Mac. Before that, the dashboard owner adds the person's GitHub account as a
collaborator on `urban-us-co/ts-federation-log` (the hourly job pushes directly;
without push access it would open a pull request every hour).

What the new machine shares:

- **Public, anonymized** — closed-hour token/cost rollups in
  `data/session-usage-log.jsonl` (hashed ids; namespaced skill and all connector
  names hashed). Optionally the claude.ai limits snapshot in `data/usage-log.jsonl`.
- **Encrypted** — one file per closed day under `tenants/<person>/<machine>/`,
  readable only with the dashboard owner's private key. Task, skill, connector and
  account names are HMAC-hashed with a salt that never leaves the machine, so the
  owner sees costs, models, session types, times and offload candidates, not names.
- **Never** — prompts, messages, file contents, the salt, or anything in `local/`.

Recipient key fingerprint (confirm it with the owner over a separate channel):
`006d2850ff552a910b64664cb30c32cfd2b4f6c7c2a476cb10805c4ef6428f53`

---

```text
Set up this Mac to contribute to the "ts-federation-log" Claude usage map.

What this is: a background job that reads this Mac's local Claude Code and Cowork
session logs every hour (no model usage), publishes anonymized hourly totals to a
public GitHub repo, and sends a daily encrypted summary that only the dashboard
owner can read, with my task, skill, connector and account names hashed on this
machine first. Prompts and file contents are never read into the summary or shared.

Work on the Mac itself (use Desktop Commander or the local terminal tool, not a
sandbox). Stop and ask me whenever a step fails; don't work around a check.

1. Ask me for: (a) the email I use for claude.ai, (b) the display name to show on
   the dashboard. Don't guess either.
2. Prerequisites: `node --version` (needs 18+), `git --version`, and
   `gh auth status`. If gh isn't logged in, ask me to run `gh auth login` and wait.
3. Find or clone the repo: look for an existing checkout with
   `find ~ -maxdepth 5 -type d -name ts-federation-log 2>/dev/null` and confirm
   `git -C <dir> remote get-url origin` is urban-us-co/ts-federation-log. If none,
   ask me where to put it, then
   `git clone https://github.com/urban-us-co/ts-federation-log.git`. Call it REPO.
4. From REPO run:
   .claude/skills/log-session-usage/scripts/onboard.sh \
     --identity "<my claude.ai email>" --name "<my display name>" \
     --fingerprint 006d2850ff552a910b64664cb30c32cfd2b4f6c7c2a476cb10805c4ef6428f53 \
     --labels hashed
   If it says I have no push access, tell me to ask the dashboard owner for
   collaborator access and stop. If the fingerprint check fails, stop: do not edit
   the key or the fingerprint.
5. Show me the last lines of REPO/local/sweep.log. Success looks like "Imported N
   new row(s)", "encrypted N closed day(s)" and "pushed directly".
6. Optional (ask me first): to also log my claude.ai limits (5-hour %, weekly %,
   extra-usage spend), create a scheduled task every 4 hours (cron "23 1-21/4 * * *")
   that follows REPO/.claude/skills/log-usage/SKILL.md (Claude in Chrome,
   javascript_tool only, raw snapshot written to /tmp outside the repo, then
   REPO/.claude/skills/log-usage/scripts/log_and_push.sh), and skips quietly when
   Chrome isn't logged in to claude.ai. Tell me to click "Run now" once to approve
   its tools.
7. Report: my tenant id and machine id (from REPO/local/tenant.json — never print
   the salt), what the first sweep did, and remind me to back up
   REPO/local/tenant.json and to keep the Claude app open for the optional task.

Rules: never commit or upload anything in REPO/local/; never change --labels to
clear; never edit tenants/recipient.pub.pem.
```

## Your own second machine

Same prompt, but use your own claude.ai email (so your series stays one person)
and `--labels clear` if you want your own names readable on the dashboard. Only the
machine that holds `local/recipient.key.pem` builds the dashboard; don't copy the
private key to other machines unless that machine should take over the dashboard.
