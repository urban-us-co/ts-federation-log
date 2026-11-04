#!/usr/bin/env bash
#
# log_and_push_sessions.sh — import local transcript usage and contribute rows.
#
# Usage: log_and_push_sessions.sh [repo_root]
#
# Reads ~/.claude/projects by default through session-usage.js. Override with:
#   TS_PROJECTS_DIR=/path/to/projects
#   SESSION_LOG_FILE=data/session-usage-log.jsonl
#   TS_FED_IDENTITY=you@example.com
set -euo pipefail

REPO="${1:-$(pwd)}"
cd "$REPO"

if [ ! -f session-usage.js ] || [ ! -f session-lib.js ]; then
  echo "error: $REPO doesn't look like the ts-federation-log repo (no session-usage.js/session-lib.js)." >&2
  exit 1
fi

LOG="${SESSION_LOG_FILE:-data/session-usage-log.jsonl}"
export SESSION_LOG_FILE="$LOG"

echo "== importing session usage =="
node session-usage.js import

echo "== validating public session log =="
node session-usage.js validate "$LOG"

if [ -f "$LOG" ] && grep -Eq '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}' "$LOG"; then
  echo "ABORT: an email address is present in $LOG — not committing." >&2
  exit 2
fi

ROWS=$(grep -c '' "$LOG" 2>/dev/null || echo 0)
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

git add "$LOG"

# Only the public session log and encrypted tenant day files (staged by
# `node sync.js push` in sweep.sh) may ride along in this commit.
UNEXPECTED=$(git diff --cached --name-only | grep -vE '^(data/session-usage-log\.jsonl|tenants/[0-9a-f]{12}/[0-9a-f]{12}/[0-9]{4}-[0-9]{2}-[0-9]{2}\.enc)$' || true)
if [ -n "$UNEXPECTED" ]; then
  echo "ABORT: unexpected staged file(s), not committing:" >&2
  printf '  %s\n' $UNEXPECTED >&2
  exit 2
fi
ENC=$(git diff --cached --name-only | grep '\.enc$' || true)
if [ -n "$ENC" ] && ! node sync.js verify $ENC; then
  echo "ABORT: a staged tenant file is not a valid encrypted envelope — not committing." >&2
  exit 2
fi

if git diff --cached --quiet; then
  echo "no new session-usage rows to commit."
  exit 0
fi

ORIGIN_URL=$(git remote get-url origin)
UPSTREAM=$(printf '%s\n' "$ORIGIN_URL" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')

CANPUSH=""
if command -v gh >/dev/null 2>&1; then
  CANPUSH=$(gh api "repos/$UPSTREAM" -q .permissions.push 2>/dev/null || echo "")
fi

COMMIT_MSG="log: session-usage snapshot ${STAMP} (${ROWS} total rows)"

if [ "$CANPUSH" = "true" ]; then
  git commit -m "$COMMIT_MSG"
  git pull --rebase --quiet origin "$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null || true
  git push
  echo "== pushed directly =="
  git log --oneline -1
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: no push access to $UPSTREAM and the gh CLI isn't installed." >&2
  echo "Install gh (https://cli.github.com), run 'gh auth login', and re-run." >&2
  exit 3
fi

echo "== no direct write access to $UPSTREAM — contributing via pull request =="
ME=$(gh api user -q .login)
BRANCH="session-usage-${ME}-${STAMP}"

git checkout -b "$BRANCH"
git commit -m "$COMMIT_MSG"

if ! git remote get-url fork >/dev/null 2>&1; then
  gh repo fork "$UPSTREAM" --clone=false --remote --remote-name fork
fi

git push -u fork "$BRANCH"

PR_URL=$(gh pr create --repo "$UPSTREAM" --base main --head "${ME}:${BRANCH}" \
  --title "$COMMIT_MSG" \
  --body "Automated session-usage snapshot from the \`log-session-usage\` skill (${ROWS} total rows after merge). Anonymized and bucketed by session-usage.js; no raw emails or namespaced labels.")

git checkout - >/dev/null 2>&1 || git checkout main >/dev/null 2>&1 || true

echo "== opened pull request =="
echo "$PR_URL"
