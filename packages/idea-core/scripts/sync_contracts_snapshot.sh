#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_REPO="${1:-$ROOT_DIR/../idea-generator}"
SOURCE_SCHEMAS="$SOURCE_REPO/schemas"
TARGET_DIR="$ROOT_DIR/contracts/idea-generator-snapshot"
TARGET_SCHEMAS="$TARGET_DIR/schemas"

if [[ ! -d "$SOURCE_REPO/.git" ]]; then
  echo "error: source repo is not a git repository: $SOURCE_REPO" >&2
  exit 1
fi
if [[ ! -d "$SOURCE_SCHEMAS" ]]; then
  echo "error: source schemas directory missing: $SOURCE_SCHEMAS" >&2
  exit 1
fi

SOURCE_COMMIT="$(git -C "$SOURCE_REPO" rev-parse --short HEAD)"
SOURCE_BRANCH="$(git -C "$SOURCE_REPO" rev-parse --abbrev-ref HEAD)"
SYNCED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

rm -rf "$TARGET_SCHEMAS"
mkdir -p "$TARGET_SCHEMAS"
cp "$SOURCE_SCHEMAS"/*.json "$TARGET_SCHEMAS"/
PYTHONPATH="$ROOT_DIR/src" python3 -m idea_core.contracts.bundle --contract-dir "$TARGET_SCHEMAS" --write

cat > "$TARGET_DIR/CONTRACT_SOURCE.json" <<META
{
  "source_repo": "../idea-generator",
  "source_branch": "$SOURCE_BRANCH",
  "source_commit": "$SOURCE_COMMIT",
  "synced_at_utc": "$SYNCED_AT",
  "openrpc_file": "schemas/idea_core_rpc_v1.openrpc.json",
  "bundled_openrpc_file": "schemas/idea_core_rpc_v1.bundled.json",
  "policy": "read-only vendored snapshot + generated bundled OpenRPC; do not hand-edit vendored schemas or bundled artifact"
}
META

echo "synced contracts from $SOURCE_REPO @ $SOURCE_COMMIT"
