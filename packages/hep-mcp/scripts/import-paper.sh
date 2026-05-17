#!/usr/bin/env bash
# Thin shell wrapper around the import-paper CLI.
#
# Usage:
#   packages/hep-mcp/scripts/import-paper.sh \
#     --identifier doi:10.1103/PhysRevD.110.012345 \
#     --pdf /abs/path/to/paper.pdf [--overwrite --confirm] [--json]
#
# Build prerequisite: pnpm --filter @autoresearch/hep-mcp build (or pnpm -r build).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_JS="${PKG_DIR}/dist/admin/cli-import-paper.js"

if [[ ! -f "${CLI_JS}" ]]; then
  echo "error: ${CLI_JS} not found." >&2
  echo "Build hep-mcp first: pnpm --filter @autoresearch/hep-mcp build" >&2
  exit 2
fi

exec node "${CLI_JS}" "$@"
