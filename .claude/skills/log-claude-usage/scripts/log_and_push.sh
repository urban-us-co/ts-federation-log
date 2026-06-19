#!/usr/bin/env bash
#
# log_and_push.sh — ingest a usage snapshot, then commit + push the log.
#
# Usage: log_and_push.sh <snapshot.jsonl> [repo_root]
#
#   <snapshot.jsonl>  a file of RAW usage records (one JSON object per line,
#                     each with ts, user_*, org_*, raw) — typically written
#                     from the browser-gathered data. May contain raw email/
#                     uuid; that's fine, it lives OUTSIDE the repo and import.js
#                     anonymizes before anything touches the tracked log.
#   [repo_root]       ts-federation-log checkout (defaults to current dir).
#
# import.js does the anonymization (hash uuid/email -> user_id/org_id, scrub
# emails from names) and de-dupe, so we never write raw PII into data/.
set -euo pipefail

SNAP="${1:?usage: log_and_push.sh <snapshot.jsonl> [repo_root]}"
REPO="${2:-$(pwd)}"
cd "$REPO"

if [ ! -f import.js ] || [ ! -f lib.js ]; then
  echo "error: $REPO doesn't look like the ts-federation-log repo (no import.js/lib.js)." >&2
  exit 1
fi

echo "== ingesting =="
node import.js "$SNAP"

# Safety net: refuse to commit if any raw email slipped into the tracked log.
if grep -Eq '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}' data/usage-log.jsonl; then
  echo "ABORT: an email address is present in data/usage-log.jsonl — not committing." >&2
  exit 2
fi

ROWS=$(grep -c '' data/usage-log.jsonl 2>/dev/null || echo 0)
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

git add data/usage-log.jsonl
if git diff --cached --quiet; then
  echo "no new log rows to commit."
  exit 0
fi

git commit -m "log: usage snapshot ${STAMP} (${ROWS} total rows)"
git push
echo "== pushed =="
git log --oneline -1
