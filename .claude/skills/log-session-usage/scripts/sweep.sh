#!/usr/bin/env bash
#
# sweep.sh — hourly background sweep (launchd). Spends no model tokens: it only
# reads the local Claude Code + Cowork transcripts.
#   1. sync with origin (append-only log: rebase, never merge)
#   2. public: closed-hour anonymized rollup -> validate -> PII gate -> push
#      (log_and_push_sessions.sh)
#   3. private: rebuild local/ledger.jsonl, local/summary.json and the
#      Dashboard row files in local/dashboard/ (never committed)
#   4. multitenant: encrypt this machine's closed days to tenants/ (sync.js
#      push); on the dashboard owner's machine, decrypt and merge everyone's
#      days into local/dashboard/facts.csv + sessions.csv (sync.js collect)
#
# Identity: TS_FED_IDENTITY, else the first line of local/identity (gitignored).
# It is hashed into user_id; it must stay the same across runs or the public
# series splits into two users, so the sweep refuses to run without it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$REPO"
mkdir -p local

if [ -z "${TS_FED_IDENTITY:-}" ] && [ -s local/identity ]; then
  TS_FED_IDENTITY="$(head -n 1 local/identity)"
  export TS_FED_IDENTITY
fi
if [ -z "${TS_FED_IDENTITY:-}" ]; then
  echo "ABORT: no identity (set TS_FED_IDENTITY or write it to local/identity)." >&2
  exit 4
fi

echo "== sweep $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
if ! git pull --rebase --autostash -q origin main; then
  git rebase --abort 2>/dev/null || true
  echo "warn: pull failed; the helper rebases again before pushing."
fi

node session-usage.js ledger --top=0

# Encrypted private detail for the dashboard owner (closed days only; staged
# here, committed by the helper together with the public rows).
if [ -f local/tenant.json ]; then
  node sync.js push
  T=$(node -e "const t=require('./local/tenant.json');console.log(t.tenant+'/'+t.machine)")
  if [ -d "tenants/$T" ]; then git add "tenants/$T"; fi
fi

bash .claude/skills/log-session-usage/scripts/log_and_push_sessions.sh "$REPO"

# Only the dashboard owner holds the private key: merge everyone's days.
if [ -f local/recipient.key.pem ] && [ -f local/tenant.json ]; then
  node sync.js collect
fi
