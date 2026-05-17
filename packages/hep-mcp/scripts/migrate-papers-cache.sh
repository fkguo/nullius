#!/usr/bin/env bash
# Thin shell wrapper around the migrate-papers-cache CLI. Invokes the compiled
# JS so users can run migration from a terminal without spawning an agent or
# wiring through an MCP client.
#
# Usage:
#   packages/hep-mcp/scripts/migrate-papers-cache.sh --project-root /abs/path [--apply] [--hep-data-root /abs/path] [--json]
#
# Build prerequisite: pnpm --filter @autoresearch/hep-mcp build  (or pnpm -r build).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_JS="${PKG_DIR}/dist/admin/cli-migrate-papers-cache.js"

if [[ ! -f "${CLI_JS}" ]]; then
  echo "error: ${CLI_JS} not found." >&2
  echo "Build hep-mcp first: pnpm --filter @autoresearch/hep-mcp build" >&2
  exit 2
fi

exec node "${CLI_JS}" "$@"
