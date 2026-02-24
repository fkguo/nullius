#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ASSETS_DIR="${SKILL_ROOT}/assets"

if [[ ! -d "${ASSETS_DIR}" ]]; then
  echo "ERROR: assets dir not found: ${ASSETS_DIR}" >&2
  exit 2
fi

# Contract: keep `assets/` model-agnostic (no hard-coded vendor model names).
# This is intentionally a narrow allowlist of common model-family/alias strings that
# have historically leaked into templates.
forbidden='(claude-opus-4-5-20251101|gemini-3-pro-preview|\\bopus\\b|\\bsonnet\\b|\\bhaiku\\b|gemini-[0-9])'

if command -v rg >/dev/null 2>&1; then
  if rg -n -S "${forbidden}" "${ASSETS_DIR}" >/dev/null 2>&1; then
    echo "[fail] found forbidden model name(s) under assets/:" >&2
    rg -n -S "${forbidden}" "${ASSETS_DIR}" >&2 || true
    exit 1
  fi
else
  if grep -R -n -E "${forbidden}" "${ASSETS_DIR}" >/dev/null 2>&1; then
    echo "[fail] found forbidden model name(s) under assets/:" >&2
    grep -R -n -E "${forbidden}" "${ASSETS_DIR}" >&2 || true
    exit 1
  fi
fi

echo "[ok] assets are model-agnostic"

