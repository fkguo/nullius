#!/usr/bin/env bash
set -euo pipefail

INPUT_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET_DIR="${HOME}/.claude/skills/autoresearch-market"

if [[ ! -d "$INPUT_ROOT" ]]; then
  echo "[error] MARKET_ROOT does not exist or is not a directory: $INPUT_ROOT" >&2
  exit 1
fi
MARKET_ROOT="$(cd "$INPUT_ROOT" && pwd)"
if [[ ! -f "$MARKET_ROOT/packages/index.json" ]]; then
  echo "[error] MARKET_ROOT missing packages/index.json: $MARKET_ROOT" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET_DIR")"
if [[ -e "$TARGET_DIR" && ! -L "$TARGET_DIR" ]]; then
  echo "[error] TARGET_DIR exists and is not a symlink: $TARGET_DIR" >&2
  echo "Back up/remove it manually, then rerun." >&2
  exit 1
fi
ln -sfn "$MARKET_ROOT" "$TARGET_DIR"

echo "[ok] linked skills-market to $TARGET_DIR"
echo "If using Claude plugin marketplace, keep this as local/private fallback."
