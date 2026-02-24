#!/usr/bin/env bash
# C-04: Check if the idea-generator → idea-core contract snapshot has drifted.
#
# Computes SHA-256 of all idea-generator/schemas/ files and compares against
# the snapshot in idea-core/contracts/idea-generator-snapshot/schemas/.
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

# Compute checksums of source schemas (sorted for determinism).
SOURCE_HASH=$(find "$SOURCE_DIR" -type f -name '*.json' -o -name '*.schema.json' | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)

# Compute checksums of snapshot schemas.
SNAPSHOT_HASH=$(find "$SNAPSHOT_DIR" -type f -name '*.json' -o -name '*.schema.json' | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)

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
