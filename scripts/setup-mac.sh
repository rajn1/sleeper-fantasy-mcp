#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20+ first (for example: brew install node)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed. Install Node.js 20+ with npm first." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required. Current version: $(node --version)" >&2
  exit 1
fi

USERNAME="${1:-}"
if [ -z "$USERNAME" ]; then
  read -r -p "Sleeper username: " USERNAME
fi

HAD_LOCKFILE=false
if [ -f package-lock.json ]; then
  HAD_LOCKFILE=true
  npm ci
else
  npm install
fi

npm run check
node scripts/check-connection.js "$USERNAME"

NODE_BIN="$(command -v node)"
SERVER_FILE="$ROOT/src/index.js"

echo
echo "Installation complete."
if [ "$HAD_LOCKFILE" = false ] && [ -f package-lock.json ]; then
  echo "A package-lock.json file was created. Review and commit it for reproducible installs."
fi
echo
echo "ChatGPT desktop settings:"
echo "  Name: Sleeper"
echo "  Transport: STDIO"
echo "  Command: $NODE_BIN"
echo "  Arguments: $SERVER_FILE"
echo "  Environment: SLEEPER_USERNAME=$USERNAME"
echo
echo "Or configure Codex CLI with:"
printf '  codex mcp add sleeper --env SLEEPER_USERNAME=%q -- %q %q\n' "$USERNAME" "$NODE_BIN" "$SERVER_FILE"
echo
echo "Then restart ChatGPT desktop or Codex and type /mcp to confirm the server is connected."
