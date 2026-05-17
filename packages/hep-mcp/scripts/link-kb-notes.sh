#!/usr/bin/env bash
# Thin shell wrapper around the link-kb-notes CLI.
#
# Usage:
#   packages/hep-mcp/scripts/link-kb-notes.sh \
#     --project-root /abs/path/to/project [--kb-dir /abs/path] [--json]
#
# Build prerequisite: pnpm --filter @autoresearch/hep-mcp build (or pnpm -r build).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_JS="${PKG_DIR}/dist/admin/cli-link-kb-notes.js"

if [[ ! -f "${CLI_JS}" ]]; then
  echo "error: ${CLI_JS} not found." >&2
  echo "Build hep-mcp first: pnpm --filter @autoresearch/hep-mcp build" >&2
  exit 2
fi

exec node "${CLI_JS}" "$@"
