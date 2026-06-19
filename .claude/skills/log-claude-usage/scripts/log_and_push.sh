#!/usr/bin/env bash
#
# log_and_push.sh — ingest a usage snapshot, then contribute it back to the log.
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
#
# Two contribution paths, chosen automatically:
#   * Direct  — if you have push access to `origin`, commit to main and push.
#   * Pull request — if you don't (you cloned the canonical repo without write
#     access), fork it, push a branch to your fork, and open a PR upstream.
#     Requires the `gh` CLI, authenticated (`gh auth login`).
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

# Work out which repo `origin` points at (owner/name), so we can both check
# push access and target it as the PR base.
ORIGIN_URL=$(git remote get-url origin)
UPSTREAM=$(printf '%s\n' "$ORIGIN_URL" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')

# Do we have push access? Prefer the authoritative answer from the API; if gh
# isn't available, optimistically try a direct push and let it fail into the
# PR path.
CANPUSH=""
if command -v gh >/dev/null 2>&1; then
  CANPUSH=$(gh api "repos/$UPSTREAM" -q .permissions.push 2>/dev/null || echo "")
fi

COMMIT_MSG="log: usage snapshot ${STAMP} (${ROWS} total rows)"

if [ "$CANPUSH" = "true" ]; then
  # ---- Direct path: commit to main and push. ----
  git commit -m "$COMMIT_MSG"
  # Re-base onto any rows other contributors pushed since we fetched, so the
  # append-only log fast-forwards cleanly.
  git pull --rebase --quiet origin "$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null || true
  git push
  echo "== pushed directly =="
  git log --oneline -1
  exit 0
fi

# ---- Pull-request path: no direct write access. ----
if ! command -v gh >/dev/null 2>&1; then
  echo "error: no push access to $UPSTREAM and the gh CLI isn't installed." >&2
  echo "Install gh (https://cli.github.com), run 'gh auth login', and re-run." >&2
  exit 3
fi

echo "== no direct write access to $UPSTREAM — contributing via pull request =="
ME=$(gh api user -q .login)
BRANCH="usage-${ME}-${STAMP}"

# Carry the staged change onto a fresh branch so main stays clean for a tidy PR.
git checkout -b "$BRANCH"
git commit -m "$COMMIT_MSG"

# Ensure a fork exists and is wired up as the `fork` remote (idempotent).
if ! git remote get-url fork >/dev/null 2>&1; then
  gh repo fork "$UPSTREAM" --clone=false --remote --remote-name fork
fi

git push -u fork "$BRANCH"

PR_URL=$(gh pr create --repo "$UPSTREAM" --base main --head "${ME}:${BRANCH}" \
  --title "$COMMIT_MSG" \
  --body "Automated usage snapshot from the \`log-claude-usage\` skill (${ROWS} total rows after merge). Anonymized at ingest by import.js — no raw UUIDs or emails." )

# Leave the contributor back on main with a clean tree.
git checkout - >/dev/null 2>&1 || git checkout main >/dev/null 2>&1 || true

echo "== opened pull request =="
echo "$PR_URL"
