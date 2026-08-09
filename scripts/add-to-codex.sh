#!/usr/bin/env bash
set -euo pipefail

USERNAME="${1:-}"
if [ -z "$USERNAME" ]; then
  echo "Usage: ./scripts/add-to-codex.sh YOUR_SLEEPER_USERNAME" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not on PATH. Install Node.js 20+ first." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "The codex CLI is not on PATH. Configure the server in ChatGPT desktop under Settings > MCP servers instead." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"

codex mcp add sleeper --env "SLEEPER_USERNAME=$USERNAME" -- "$NODE_BIN" "$ROOT/src/index.js"
codex mcp list
