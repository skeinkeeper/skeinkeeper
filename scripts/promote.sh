#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Skeinkeeper Contributors
#
# Promote the current commit into the live deployment.
#
#   scripts/promote.sh                 # build this commit, deploy it, verify it
#   scripts/promote.sh --rollback      # go back to the previously deployed image
#   scripts/promote.sh --status        # what is deployed, and what is running
#   scripts/promote.sh --skip-verify   # skip pnpm verify:all (you own the risk)
#
# The artifact is an image tagged with the commit it was built from. The deploy
# directory (SKEINKEEPER_DEPLOY_DIR, default ~/skeinkeeper-prod) holds only your
# `.env`, your `data/`, and a compose file this script manages. No source tree —
# so what is running cannot drift with your working copy.
#
# This script refuses rather than guesses. A dirty tree, a failing gate, a port
# already held, a container that does not come up — each stops the promotion with
# the reason, and a failed deploy rolls itself back.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${SKEINKEEPER_DEPLOY_DIR:-$HOME/skeinkeeper-prod}"
UNIT="skeinkeeper.service"
HEALTH_TIMEOUT="${SKEINKEEPER_HEALTH_TIMEOUT:-90}"

die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }

# --- .env helpers ------------------------------------------------------------
# Read/write a single key without disturbing the rest of the operator's file.
env_get() { sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" 2>/dev/null | tail -1; }
env_set() {
  local key="$1" val="$2" f="$DEPLOY_DIR/.env"
  if grep -q "^$key=" "$f"; then
    local tmp; tmp="$(mktemp)"
    sed "s|^$key=.*|$key=$val|" "$f" > "$tmp" && cat "$tmp" > "$f" && rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$val" >> "$f"
  fi
}

compose() { docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" "$@"; }

# Wait for the console to answer, not merely for the container to exist. A
# container that starts and then crash-loops looks "up" for several seconds.
health_check() {
  local port deadline state
  port="$(env_get SKEINKEEPER_WEB_PORT)"; port="${port:-3000}"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null; then return 0; fi
    # Fail fast on a container that started and DIED — but not on one that does
    # not exist yet. `systemctl restart` leaves a window of a few seconds before
    # compose creates it, and treating that absence as failure made every first
    # deploy report a false negative while the app was in fact coming up fine.
    state="$(compose ps -a --format '{{.State}}' 2>/dev/null | head -1)"
    case "$state" in exited|dead) return 1 ;; esac
    sleep 3
  done
  return 1
}

show_status() {
  step "Deployment status"
  if [ ! -f "$DEPLOY_DIR/.env" ]; then echo "    not deployed — $DEPLOY_DIR has no .env"; return 0; fi
  printf '    deploy dir:   %s\n' "$DEPLOY_DIR"
  printf '    deployed tag: %s\n' "$(env_get SKEINKEEPER_IMAGE_TAG || echo '(none)')"
  printf '    previous tag: %s\n' "$(env_get SKEINKEEPER_PREVIOUS_TAG || echo '(none)')"
  printf '    unit:         %s (%s)\n' "$UNIT" "$(systemctl --user is-active "$UNIT" 2>/dev/null || echo inactive)"
  compose ps --format '    container:    {{.Name}}  {{.State}}  {{.Status}}' 2>/dev/null || true
}

# --- argument handling -------------------------------------------------------
MODE=promote; SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --rollback) MODE=rollback ;;
    --status)   MODE=status ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    -h|--help) sed -n '4,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

[ "$MODE" = status ] && { show_status; exit 0; }

command -v docker >/dev/null || die "docker is not installed."
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon as $(id -un). Are you in the 'docker' group (and is this a fresh login)?"

# --- rollback ----------------------------------------------------------------
if [ "$MODE" = rollback ]; then
  [ -f "$DEPLOY_DIR/.env" ] || die "nothing deployed yet — $DEPLOY_DIR/.env does not exist."
  PREV="$(env_get SKEINKEEPER_PREVIOUS_TAG)"
  CURRENT="$(env_get SKEINKEEPER_IMAGE_TAG)"
  [ -n "$PREV" ] || die "no previous image recorded — nothing to roll back to."
  docker image inspect "skeinkeeper:$PREV" >/dev/null 2>&1 \
    || die "previous image skeinkeeper:$PREV is no longer present locally."
  step "Rolling back $CURRENT -> $PREV"
  env_set SKEINKEEPER_IMAGE_TAG "$PREV"
  env_set SKEINKEEPER_PREVIOUS_TAG "$CURRENT"
  systemctl --user restart "$UNIT"
  health_check && ok "rolled back to $PREV and the console is answering" \
    || die "rollback to $PREV did not come up. journalctl --user -u $UNIT -n 50"
  exit 0
fi

# --- promote -----------------------------------------------------------------
cd "$REPO"

step "Checking the tree"
# `git diff --quiet` does NOT see untracked files; a promotion that ignored them
# would build a commit while copying uncommitted files into the deployment, and
# record a tag that does not describe what is deployed.
[ -z "$(git status --porcelain)" ] \
  || die "working tree is dirty (including untracked files). Promotion records the commit it built, so it must build a commit — commit or stash first.

$(git status --short | head -10)"
SHA="$(git rev-parse --short=12 HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ok "HEAD $SHA on $BRANCH, tree clean"

if [ "$SKIP_VERIFY" -eq 1 ]; then
  printf '    \033[33m!\033[0m skipping pnpm verify:all at your request\n'
else
  step "Running the repo gates (pnpm verify:all)"
  pnpm verify:all >/tmp/skeinkeeper-promote-verify.log 2>&1 \
    || die "verify:all failed — see /tmp/skeinkeeper-promote-verify.log. Not promoting a build that does not pass its own gates."
  ok "headers, telemetry registry, lint, type-check, tests, eval"
fi

step "Building skeinkeeper:$SHA"
docker build -t "skeinkeeper:$SHA" "$REPO" >/tmp/skeinkeeper-promote-build.log 2>&1 \
  || die "docker build failed — see /tmp/skeinkeeper-promote-build.log"
ok "image built"

step "Preparing $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/data"
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  [ -f "$REPO/.env" ] || die "$DEPLOY_DIR/.env does not exist and there is no $REPO/.env to seed it from. Create it from .env.example first."
  cp "$REPO/.env" "$DEPLOY_DIR/.env"; chmod 600 "$DEPLOY_DIR/.env"
  ok "seeded .env from the repo (review it — deployment secrets should be yours to manage)"
fi
cp "$REPO/docker-compose.prod.yml" "$DEPLOY_DIR/docker-compose.yml"
ok "compose file synced"

# The deployment owns 3000/7733. A dev `docker compose up` or `pnpm app:start`
# holding them would make the promotion look like it failed for the wrong reason.
step "Checking the ports are free for the deployment"
PORT="$(env_get SKEINKEEPER_WEB_PORT)"; PORT="${PORT:-3000}"
GW="$(env_get FOUNDRY_GATEWAY_PORT)"; GW="${GW:-7733}"
if systemctl --user is-active --quiet "$UNIT"; then
  ok "the deployment itself holds them (restarting it below)"
else
  for p in "$PORT" "$GW"; do
    ss -tln 2>/dev/null | grep -qE "127\.0\.0\.1:$p\b|0\.0\.0\.0:$p\b" \
      && die "port $p is already in use and it is not $UNIT — stop your dev run first (docker compose down, or kill pnpm app:start)."
  done
  ok "$PORT and $GW are free"
fi

step "Deploying"
PREV_TAG="$(env_get SKEINKEEPER_IMAGE_TAG)"
[ -n "$PREV_TAG" ] && env_set SKEINKEEPER_PREVIOUS_TAG "$PREV_TAG"
env_set SKEINKEEPER_IMAGE_TAG "$SHA"
systemctl --user restart "$UNIT" 2>/dev/null || die "could not restart $UNIT. Is it installed? See docs/INSTALL.md."

if health_check; then
  ok "skeinkeeper:$SHA is live and the console is answering on 127.0.0.1:$PORT"
  [ -n "$PREV_TAG" ] && printf '    roll back with: scripts/promote.sh --rollback  (-> %s)\n' "$PREV_TAG"
else
  printf '\n\033[31mdeployment did not come up.\033[0m\n' >&2
  if [ -n "$PREV_TAG" ] && docker image inspect "skeinkeeper:$PREV_TAG" >/dev/null 2>&1; then
    step "Rolling back to $PREV_TAG automatically"
    env_set SKEINKEEPER_IMAGE_TAG "$PREV_TAG"
    systemctl --user restart "$UNIT" || true
    health_check && ok "rolled back to $PREV_TAG" || printf '    rollback ALSO failed — the deployment is down.\n' >&2
  fi
  die "promotion of $SHA failed. journalctl --user -u $UNIT -n 80"
fi
