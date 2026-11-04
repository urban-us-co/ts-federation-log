#!/usr/bin/env bash
#
# onboard.sh — set up a machine to contribute to ts-federation-log (macOS).
#
#   .claude/skills/log-session-usage/scripts/onboard.sh \
#     --identity you@example.com --name "Your Name" \
#     --fingerprint <64-hex recipient key fingerprint, sent to you out of band> \
#     [--labels hashed|clear] [--no-launchd]
#
# What it does, in order (it stops at the first problem):
#   1. checks node >= 18, git, and push access to the repo (gh)
#   2. checks tenants/recipient.pub.pem matches the fingerprint you were given,
#      so your encrypted detail can only be read by the dashboard owner
#   3. writes local/identity and local/tenant.json (gitignored; holds a random
#      machine id and a secret salt that never leave this machine)
#   4. installs + loads the hourly launchd sweep, then shows its first log lines
#
# Default labels are "hashed": task, skill, connector and account names are
# HMAC'd with your own salt before anything is encrypted and shared.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$REPO"

IDENTITY="" NAME="" FP="" LABELS="hashed" LAUNCHD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --fingerprint) FP="$2"; shift 2 ;;
    --labels) LABELS="$2"; shift 2 ;;
    --no-launchd) LAUNCHD=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
[ -n "$IDENTITY" ] || { echo "error: --identity <your claude.ai email> is required" >&2; exit 1; }
[ -n "$FP" ] || { echo "error: --fingerprint is required (ask the dashboard owner)" >&2; exit 1; }
case "$LABELS" in hashed|clear) ;; *) echo "error: --labels must be hashed or clear" >&2; exit 1 ;; esac

echo "== 1. tools =="
command -v node >/dev/null || { echo "error: node not found (install Node 18+)" >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || { echo "error: node $NODE_MAJOR is too old; need 18+" >&2; exit 1; }
command -v git >/dev/null || { echo "error: git not found" >&2; exit 1; }
UPSTREAM=$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
if command -v gh >/dev/null && [ "$(gh api "repos/$UPSTREAM" -q .permissions.push 2>/dev/null || true)" = "true" ]; then
  echo "push access to $UPSTREAM: yes"
else
  echo "error: no push access to $UPSTREAM (or gh not logged in)." >&2
  echo "Ask the repo owner to add your GitHub account as a collaborator, run 'gh auth login', then re-run." >&2
  echo "(Without push access every hourly run would open a pull request.)" >&2
  exit 1
fi

echo "== 2. recipient key =="
git pull --rebase --autostash -q origin main
ACTUAL=$(node sync.js fingerprint)
if [ "$ACTUAL" != "$FP" ]; then
  echo "ABORT: tenants/recipient.pub.pem fingerprint is $ACTUAL, not the $FP you were given." >&2
  echo "Don't continue until the dashboard owner confirms which key is right." >&2
  exit 2
fi
echo "fingerprint matches"

echo "== 3. identity =="
mkdir -p local
printf '%s\n' "$IDENTITY" > local/identity
chmod 600 local/identity
node sync.js init-tenant --identity="$IDENTITY" --name="$NAME" --labels="$LABELS" --fingerprint="$FP"
node session-usage.js report --by=source | sed -n '1,8p'

if [ "$LAUNCHD" = 1 ]; then
  echo "== 4. hourly sweep (launchd) =="
  PLIST=~/Library/LaunchAgents/com.thirdsphere.federation-sweep.plist
  TOOLPATH="$(dirname "$(command -v node)"):$(dirname "$(command -v git)"):$(dirname "$(command -v gh)"):/usr/bin:/bin:/usr/sbin:/sbin"
  mkdir -p ~/Library/LaunchAgents
  sed -e "s#__REPO__#$REPO#g" -e "s#__PATH__#$TOOLPATH#g" .claude/skills/log-session-usage/com.thirdsphere.federation-sweep.plist > "$PLIST"
  plutil -lint "$PLIST" >/dev/null
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded; first run starts now. Waiting 60s for its log..."
  sleep 60
  tail -n 15 local/sweep.log 2>/dev/null || echo "(no log yet — check $REPO/local/sweep.log in a minute)"
fi

echo "== done =="
echo "tenant $(node -p "require('./local/tenant.json').tenant") machine $(node -p "require('./local/tenant.json').machine") labels $LABELS"
echo "Back up local/tenant.json: losing its salt or machine id splits your history."
