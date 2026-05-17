#!/usr/bin/env bash
# Thin shell wrapper around the prune-paper-cache CLI.
#
# Usage:
#   packages/hep-mcp/scripts/prune-paper-cache.sh \
#     --project-root /abs/path/A [--project-root /abs/path/B ...] [--apply] [--json]
#
# Build prerequisite: pnpm --filter @autoresearch/hep-mcp build (or pnpm -r build).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_JS="${PKG_DIR}/dist/admin/cli-prune-paper-cache.js"

if [[ ! -f "${CLI_JS}" ]]; then
  echo "error: ${CLI_JS} not found." >&2
  echo "Build hep-mcp first: pnpm --filter @autoresearch/hep-mcp build" >&2
  exit 2
fi

exec node "${CLI_JS}" "$@"
