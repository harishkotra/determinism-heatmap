#!/usr/bin/env bash
#
# Start the whole app with one command: backend on :3001, frontend on :5173.
#
#   ./scripts/dev.sh
#
# The API key is resolved in this order, and is never written to the repo:
#   1. PARTICLE_AI_API_KEY already set in your environment
#   2. a .env file in the project root (gitignored)
#   3. the DSH credential store at ~/.dsh/.credentials.yaml
#
# If none is found the app still runs — paste a key into ⚙ Settings instead.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${PARTICLE_AI_API_KEY:-}" && -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
  echo "[dev] loaded .env"
fi

if [[ -z "${PARTICLE_AI_API_KEY:-}" && -f "$HOME/.dsh/.credentials.yaml" ]]; then
  KEY="$(node -e '
    const fs = require("fs");
    try {
      const txt = fs.readFileSync(process.env.HOME + "/.dsh/.credentials.yaml", "utf8");
      const m = txt.match(/PARTICLE_AI_API_KEY:\s*(\S+)/);
      process.stdout.write(m ? m[1].replace(/^["\x27]|["\x27]$/g, "") : "");
    } catch { process.stdout.write(""); }
  ')"
  if [[ -n "$KEY" ]]; then
    export PARTICLE_AI_API_KEY="$KEY"
    echo "[dev] using API key from ~/.dsh/.credentials.yaml (not printed, not stored)"
  fi
fi

if [[ -z "${PARTICLE_AI_API_KEY:-}" ]]; then
  echo "[dev] no API key found — paste one into Settings in the browser to run sweeps"
fi

echo "[dev] backend  http://localhost:${PORT:-3001}"
echo "[dev] frontend http://localhost:${WEB_PORT:-5173}"
echo

exec pnpm dev