#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Meta Lead Ads -> CRM Integration — environment bootstrap / preflight
#
# One script to check and prepare ANY environment (a fresh laptop, a new
# team member's machine, a CI runner, a fresh cloud shell) for this project:
#   - verifies Node.js, npm, and git are installed (and Node is new enough)
#   - checks optional tooling (Docker, Vercel CLI) without hard-failing
#   - creates .env from .env.example if missing, and auto-generates the two
#     secrets this app must produce itself (AUTH_JWT_SECRET, ENCRYPTION_KEY)
#   - validates every other required variable is set to something real,
#     not just the .env.example placeholder
#   - runs `npm install`, and optionally migrations / QStash schedule setup
#     / a production deploy, depending on the flags you pass
#
# Usage:
#   bash scripts/bootstrap.sh                 # checks + npm install only
#   bash scripts/bootstrap.sh --with-docker    # + starts local Postgres/Redis
#   bash scripts/bootstrap.sh --migrate        # + applies DB migrations
#   bash scripts/bootstrap.sh --schedules      # + registers QStash schedule
#   bash scripts/bootstrap.sh --deploy         # + `vercel --prod`
#   bash scripts/bootstrap.sh --all            # everything above
#
# Windows: run this from Git Bash or WSL. Without either, run the
# equivalent steps by hand: `node scripts/generate-secrets.cjs`,
# `npm install`, `npm run db:migrate`, `npm run setup:schedules` all work
# on plain PowerShell/cmd because they're Node-based, not shell-based - only
# THIS wrapper script (the "is node even installed" check) needs bash.
# ---------------------------------------------------------------------------
set -uo pipefail

# ---- flags -----------------------------------------------------------------
WITH_DOCKER=false
DO_MIGRATE=false
DO_SCHEDULES=false
DO_DEPLOY=false
SKIP_INSTALL=false

for arg in "$@"; do
  case "$arg" in
    --with-docker) WITH_DOCKER=true ;;
    --migrate) DO_MIGRATE=true ;;
    --schedules) DO_SCHEDULES=true ;;
    --deploy) DO_DEPLOY=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    --all) WITH_DOCKER=true; DO_MIGRATE=true; DO_SCHEDULES=true ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $arg (use --help)"; exit 1 ;;
  esac
done

# ---- output helpers ---------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

ok()   { echo "  ${GREEN}✓${RESET} $1"; PASS_COUNT=$((PASS_COUNT+1)); }
warn() { echo "  ${YELLOW}!${RESET} $1"; WARN_COUNT=$((WARN_COUNT+1)); }
fail() { echo "  ${RED}✗${RESET} $1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
section() { echo ""; echo "${BOLD}$1${RESET}"; }

cd "$(dirname "$0")/.." || exit 1
ROOT_DIR="$(pwd)"

section "1. Required tooling"

# ---- Node.js -----------------------------------------------------------
REQUIRED_NODE_MAJOR=20
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v)"
  NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -ge "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
    ok "Node.js $NODE_VERSION found (>= v$REQUIRED_NODE_MAJOR required)"
  else
    fail "Node.js $NODE_VERSION found, but v$REQUIRED_NODE_MAJOR+ is required"
    echo "      Install a newer version: https://nodejs.org/en/download (or use nvm: https://github.com/nvm-sh/nvm)"
  fi
else
  fail "Node.js is not installed"
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) echo "      macOS:  brew install node@20   (https://brew.sh)" ;;
    Linux)  echo "      Linux:  use nvm - https://github.com/nvm-sh/nvm - then: nvm install 20" ;;
    *)      echo "      Windows: https://nodejs.org/en/download or: winget install OpenJS.NodeJS.LTS" ;;
  esac
fi

# ---- npm ----------------------------------------------------------------
if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v) found"
else
  fail "npm is not installed (usually ships with Node.js - reinstall Node)"
fi

# ---- git ------------------------------------------------------------------
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}') found"
else
  warn "git is not installed - fine for running the app, needed to clone/push this repo"
fi

# ---- Docker (optional - local dev only) ---------------------------------
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "Docker is installed and running"
  else
    warn "Docker is installed but not running - start Docker Desktop before using docker-compose.yml"
  fi
else
  warn "Docker not found - only needed for LOCAL development (Postgres + Redis shim). Production needs no Docker at all."
fi

# ---- Vercel CLI (optional - auto-installed on demand) ---------------------
if command -v vercel >/dev/null 2>&1; then
  ok "Vercel CLI $(vercel --version 2>/dev/null) found"
elif [ -x "$ROOT_DIR/node_modules/.bin/vercel" ]; then
  ok "Vercel CLI found in node_modules (will be installed by npm install if missing)"
else
  warn "Vercel CLI not found globally - will be available via 'npx vercel' once npm install runs"
fi

# Stop here if Node/npm are missing - nothing else in this script can run.
if [ "$FAIL_COUNT" -gt 0 ]; then
  section "Stopping - fix the failures above first"
  echo "  ${FAIL_COUNT} check(s) failed, ${WARN_COUNT} warning(s)."
  exit 1
fi

section "2. Environment configuration (.env)"

if [ ! -f .env ]; then
  cp .env.example .env
  ok "Created .env from .env.example"
else
  ok ".env already exists"
fi

# Auto-generate the two secrets this app must produce itself, if still
# placeholders - every other run of this script is a no-op here.
if grep -q '^AUTH_JWT_SECRET=replace-me' .env 2>/dev/null || grep -q '^ENCRYPTION_KEY=replace-me' .env 2>/dev/null; then
  echo "  Generating AUTH_JWT_SECRET / ENCRYPTION_KEY ..."
  SECRETS="$(node scripts/generate-secrets.cjs)"
  AUTH_SECRET_VALUE="$(echo "$SECRETS" | grep AUTH_JWT_SECRET | cut -d= -f2-)"
  ENC_KEY_VALUE="$(echo "$SECRETS" | grep ENCRYPTION_KEY | cut -d= -f2-)"
  # Portable in-place edit for both GNU and BSD sed.
  sed -i.bak "s|^AUTH_JWT_SECRET=.*|AUTH_JWT_SECRET=${AUTH_SECRET_VALUE}|" .env && rm -f .env.bak
  sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${ENC_KEY_VALUE}|" .env && rm -f .env.bak
  ok "Generated and wrote AUTH_JWT_SECRET and ENCRYPTION_KEY into .env"
else
  ok "AUTH_JWT_SECRET and ENCRYPTION_KEY are already set"
fi

# Validate every key from .env.example is present and non-placeholder in .env.
echo ""
echo "  Checking required variables:"
MISSING_VARS=()
PLACEHOLDER_VARS=()
while IFS= read -r line; do
  case "$line" in
    ''|'#'*) continue ;;
  esac
  key="${line%%=*}"
  [ -z "$key" ] && continue
  actual_line="$(grep "^${key}=" .env 2>/dev/null || true)"
  if [ -z "$actual_line" ]; then
    MISSING_VARS+=("$key")
    continue
  fi
  value="${actual_line#*=}"
  if [ -z "$value" ] || [ "$value" = "replace-me" ]; then
    PLACEHOLDER_VARS+=("$key")
  fi
done < .env.example

if [ ${#MISSING_VARS[@]} -eq 0 ] && [ ${#PLACEHOLDER_VARS[@]} -eq 0 ]; then
  ok "All variables in .env.example are set in .env"
else
  for v in "${MISSING_VARS[@]:-}"; do [ -n "$v" ] && fail "Missing from .env: $v"; done
  for v in "${PLACEHOLDER_VARS[@]:-}"; do [ -n "$v" ] && warn "Still a placeholder in .env: $v (fill in before deploying)"; done
fi

section "3. Installing dependencies"
if [ "$SKIP_INSTALL" = true ]; then
  warn "Skipped (--skip-install)"
else
  if npm install; then
    ok "npm install completed"
  else
    fail "npm install failed - see output above"
  fi
fi

if [ "$WITH_DOCKER" = true ]; then
  section "4. Starting local Docker services"
  if command -v docker >/dev/null 2>&1; then
    if docker compose up -d; then
      ok "docker compose up -d completed"
      echo "  Waiting for Postgres to report healthy..."
      for i in $(seq 1 20); do
        STATUS="$(docker inspect --format='{{.State.Health.Status}}' meta-leads-postgres 2>/dev/null || echo unknown)"
        if [ "$STATUS" = "healthy" ]; then ok "Postgres is healthy"; break; fi
        sleep 2
        if [ "$i" -eq 20 ]; then warn "Postgres did not report healthy in time - check 'docker compose logs postgres'"; fi
      done
    else
      fail "docker compose up -d failed"
    fi
  else
    fail "Docker is not installed - cannot start local services (--with-docker requires it)"
  fi
fi

if [ "$DO_MIGRATE" = true ]; then
  section "5. Applying database migrations"
  if npm run db:migrate; then
    ok "Migrations applied"
  else
    fail "Migration failed - check DATABASE_URL in .env"
  fi
fi

if [ "$DO_SCHEDULES" = true ]; then
  section "6. Registering QStash reconciliation schedule"
  if npm run setup:schedules; then
    ok "QStash schedule registered"
  else
    fail "Failed to register QStash schedule - check QSTASH_TOKEN and PUBLIC_BASE_URL in .env"
  fi
fi

if [ "$DO_DEPLOY" = true ]; then
  section "7. Deploying to Vercel (production)"
  if npx vercel --prod; then
    ok "Deployed"
  else
    fail "vercel --prod failed - see output above"
  fi
fi

section "Summary"
echo "  ${GREEN}${PASS_COUNT} passed${RESET}, ${YELLOW}${WARN_COUNT} warning(s)${RESET}, ${RED}${FAIL_COUNT} failed${RESET}"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo "  Fix the ✗ items above and re-run this script - it's safe to run as many times as you like."
  exit 1
fi
echo ""
echo "  Ready. Next: npm run dev   (or re-run with --migrate --schedules --deploy once .env is fully filled in)"
