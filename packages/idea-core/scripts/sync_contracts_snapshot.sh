#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_REPO="${1:-$ROOT_DIR/../idea-generator}"
SOURCE_SCHEMAS="$SOURCE_REPO/schemas"
TARGET_DIR="$ROOT_DIR/contracts/idea-generator-snapshot"
TARGET_SCHEMAS="$TARGET_DIR/schemas"

if ! git -C "$SOURCE_REPO" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "error: source path is not inside a git repository: $SOURCE_REPO" >&2
  exit 1
fi
if [[ ! -d "$SOURCE_SCHEMAS" ]]; then
  echo "error: source schemas directory missing: $SOURCE_SCHEMAS" >&2
  exit 1
fi

SOURCE_COMMIT="$(git -C "$SOURCE_REPO" rev-parse --short HEAD)"
SOURCE_BRANCH="$(git -C "$SOURCE_REPO" rev-parse --abbrev-ref HEAD)"
SOURCE_TREE_STATE="clean"
if [[ -n "$(git -C "$SOURCE_REPO" status --porcelain -- .)" ]]; then
  SOURCE_TREE_STATE="dirty"
  SOURCE_COMMIT="${SOURCE_COMMIT}-dirty"
fi
SOURCE_SCHEMA_HASH="$(
  python3 - "$SOURCE_SCHEMAS" <<'PY'
import hashlib
import pathlib
import sys

schema_dir = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
for path in sorted(schema_dir.glob("*.json")):
    digest.update(path.name.encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
PY
)"
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
  "source_tree_state": "$SOURCE_TREE_STATE",
  "source_schema_sha256": "$SOURCE_SCHEMA_HASH",
  "synced_at_utc": "$SYNCED_AT",
  "openrpc_file": "schemas/idea_core_rpc_v1.openrpc.json",
  "bundled_openrpc_file": "schemas/idea_core_rpc_v1.bundled.json",
  "policy": "read-only vendored snapshot + generated bundled OpenRPC; do not hand-edit vendored schemas or bundled artifact"
}
META

echo "synced contracts from $SOURCE_REPO @ $SOURCE_COMMIT"
