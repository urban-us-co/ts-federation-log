#!/usr/bin/env bash
#
# federation_hourly.sh — unattended hourly usage contribution.
#
# Invoked by the launchd agent (com.thirdsphere.federation-log). Runs a headless
# Claude Code session that drives the `log-claude-usage` skill: it reads the
# logged-in claude.ai session in the already-open Chrome, anonymizes, and
# contributes a snapshot (direct push or PR). For this to gather anything,
# **Chrome must be open and logged in to claude.ai** with the Claude-in-Chrome
# extension connected; otherwise the run skips quietly.
#
# Permissions: the headless run is given a NARROW allow-list (Chrome MCP +
# node/git/gh/bash for the helper + file read/write) rather than a blanket
# permission bypass. Anything outside the list is denied, not prompted.
#
# Env overrides:
#   FED_REPO    repo checkout (default below)
#   FED_DRYRUN  if set to 1, gather + report but do NOT commit/push (for testing)
set -uo pipefail

export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO="${FED_REPO:-/Users/stonly/Projects/Third Sphere IT and Software Dev/ts-federation-log}"
LOGDIR="$HOME/Library/Logs/federation-log"
mkdir -p "$LOGDIR"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG="$LOGDIR/run-$TS.log"

cd "$REPO" || { echo "repo not found: $REPO" >"$LOG"; exit 1; }

CONTRIB='contribute it to the ts-federation-log (direct push if you have write access, otherwise open a pull request from a fork)'
[ "${FED_DRYRUN:-0}" = "1" ] && CONTRIB='report the captured numbers but do NOT commit or push (dry run)'

PROMPT="Run the log-claude-usage skill now: capture a Claude.ai usage snapshot from the logged-in Chrome session (one row per org), anonymize via this repo's import.js, and ${CONTRIB}. If no logged-in claude.ai browser session is available (no connected browser, or /api/account returns empty), skip this run quietly and report that gathering was unavailable — do not error out."

echo "== federation_hourly $TS (dryrun=${FED_DRYRUN:-0}) ==" >"$LOG"
claude -p "$PROMPT" \
  --allowedTools \
    "mcp__Claude_in_Chrome__list_connected_browsers" \
    "mcp__Claude_in_Chrome__navigate" \
    "mcp__Claude_in_Chrome__javascript_tool" \
    "Read" "Write" \
    "Bash(node:*)" "Bash(git:*)" "Bash(gh:*)" "Bash(bash:*)" "Bash(mkdir:*)" \
  >>"$LOG" 2>&1
echo "== exit $? ==" >>"$LOG"
