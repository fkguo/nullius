#!/usr/bin/env bash
set -euo pipefail

ROOT="."
FAIL=0

usage() {
  cat <<'EOF'
check_md_double_backslash.sh

Detect common double-backslash LaTeX escapes inside Markdown math regions
that frequently get introduced by TOC generators or LLM over-escaping, e.g. \\Delta, \\gamma\\_{\\rm lin}, k^\\*.

Usage:
  check_md_double_backslash.sh [--root PATH] [--fail]

Options:
  --root PATH   File or directory to scan (default: .)
  --fail        Exit non-zero if any matches are found (default: warn-only)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --fail) FAIL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXER="${SCRIPT_DIR}/fix_md_double_backslash_math.py"

if [[ ! -e "${ROOT}" ]]; then
  echo "ERROR: path not found: ${ROOT}" >&2
  exit 2
fi
if [[ ! -f "${FIXER}" ]]; then
  echo "ERROR: fixer script not found: ${FIXER}" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found in PATH" >&2
  exit 2
fi

set +e
python3 "${FIXER}" --root "${ROOT}"
code=$?
set -e

if [[ $code -eq 0 ]]; then
  exit 0
fi
if [[ $code -eq 1 ]]; then
  if [[ "${FAIL}" -eq 1 ]]; then
    exit 1
  fi
  exit 0
fi

exit $code

