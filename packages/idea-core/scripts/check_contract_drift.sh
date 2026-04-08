#!/usr/bin/env bash
# C-04: Check if the idea-generator → idea-core contract snapshot has drifted.
#
# Computes SHA-256 of the SSOT schema/OpenRPC files in idea-generator/schemas/
# and compares against the snapshot in
# idea-core/contracts/idea-generator-snapshot/schemas/.
#
# Non-SSOT generated artifacts such as *.bundled.json are intentionally
# excluded so the drift gate only tracks source-of-truth contract files.
#
# Exit 0 if in sync, exit 1 if drifted.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDEA_CORE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_ROOT="$(cd "$IDEA_CORE_ROOT/../.." && pwd)"

SOURCE_DIR="$MONOREPO_ROOT/packages/idea-generator/schemas"
SNAPSHOT_DIR="$IDEA_CORE_ROOT/contracts/idea-generator-snapshot/schemas"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "[error] idea-generator schemas directory not found: $SOURCE_DIR" >&2
    exit 1
fi

if [ ! -d "$SNAPSHOT_DIR" ]; then
    echo "[error] contract snapshot directory not found: $SNAPSHOT_DIR" >&2
    exit 1
fi

compute_contract_hash() {
    local root_dir="$1"
    local tmp_file
    tmp_file="$(mktemp)"

    find "$root_dir" -type f \( -name '*.schema.json' -o -name '*.openrpc.json' \) -print0 \
        | sort -z \
        | while IFS= read -r -d '' file; do
            local rel hash
            rel="${file#$root_dir/}"
            hash="$(shasum -a 256 "$file" | cut -d' ' -f1)"
            printf '%s  %s\n' "$hash" "$rel"
        done > "$tmp_file"

    shasum -a 256 "$tmp_file" | cut -d' ' -f1
    rm -f "$tmp_file"
}

# Compute checksums of source/snapshot contract files using content + relative
# path only, so different root directories do not create false drift.
SOURCE_HASH="$(compute_contract_hash "$SOURCE_DIR")"
SNAPSHOT_HASH="$(compute_contract_hash "$SNAPSHOT_DIR")"

if [ "$SOURCE_HASH" = "$SNAPSHOT_HASH" ]; then
    echo "[ok] contract snapshot is in sync (hash: ${SOURCE_HASH:0:12})"
    exit 0
else
    echo "[drift] contract snapshot has drifted!" >&2
    echo "  source hash:   ${SOURCE_HASH:0:12}" >&2
    echo "  snapshot hash: ${SNAPSHOT_HASH:0:12}" >&2
    echo "" >&2
    echo "Run 'make sync-contracts' in packages/idea-core/ to update the snapshot." >&2
    exit 1
fi
