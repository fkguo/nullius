#!/usr/bin/env bash
set -euo pipefail

ROOT="."
NOTES=""
FAIL=0

usage() {
  cat <<'EOF'
check_md_double_backslash.sh

Lightweight Markdown QA helper: detect common double-backslash LaTeX escapes inside Markdown math
that frequently get introduced by TOC generators or LLM over-escaping, e.g. \\Delta, \\gamma\\_{\\rm lin}, k^\\*.

Usage:
  check_md_double_backslash.sh [--root PATH] [--notes Draft_Derivation.md] [--fail]

Options:
  --root PATH   File or directory to scan (default: .)
  --notes PATH  Use research_team_config.json to deterministically scan key Markdown targets (same scope as markdown math hygiene gate).
  --fail        Exit non-zero if any matches are found (default: warn-only)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --fail) FAIL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -n "${NOTES}" ]]; then
  if [[ ! -f "${NOTES}" ]]; then
    echo "ERROR: notes not found: ${NOTES}" >&2
    exit 2
  fi
else
  if [[ ! -e "${ROOT}" ]]; then
    echo "ERROR: path not found: ${ROOT}" >&2
    exit 2
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXER="${SCRIPT_DIR}/fix_markdown_double_backslash_math.py"

if [[ ! -f "${FIXER}" ]]; then
  echo "ERROR: fixer script not found: ${FIXER}" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found in PATH" >&2
  exit 2
fi

set +e
if [[ -n "${NOTES}" ]]; then
  python3 "${FIXER}" --notes "${NOTES}"
else
  python3 "${FIXER}" --root "${ROOT}"
fi
code=$?
set -e

if [[ $code -eq 0 ]]; then
  exit 0
fi
if [[ $code -eq 1 ]]; then
  # Found likely-accidental escapes in math regions.
  if [[ "${FAIL}" -eq 1 ]]; then
    exit 1
  fi
  exit 0
fi

exit $code
