#!/usr/bin/env bash
set -euo pipefail

REQUIRE_CLAUDE=0
REQUIRE_GEMINI=0

usage() {
  cat <<'EOF'
check_environment.sh

Quick environment sanity check for the research-team skill.

Exit codes:
  0  all required dependencies found
  1  missing required dependency
  2  usage / invalid args

Usage:
  check_environment.sh [--require-claude] [--require-gemini]

Required:
  - bash
  - python3

Recommended (warn-only):
  - git
  - rg

Optional (warn-only unless required):
  - claude
  - gemini
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-claude) REQUIRE_CLAUDE=1; shift ;;
    --require-gemini) REQUIRE_GEMINI=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

missing_required=0

check_cmd() {
  local name="$1"
  local required="$2"
  if command -v "${name}" >/dev/null 2>&1; then
    echo "[ok] ${name}: $(command -v "${name}")"
    return 0
  fi
  if [[ "${required}" -eq 1 ]]; then
    echo "[fail] ${name}: not found (required)" >&2
    missing_required=1
  else
    echo "[warn] ${name}: not found (optional)" >&2
  fi
  return 0
}

echo "[info] research-team environment check"

check_cmd bash 1
check_cmd python3 1
check_cmd git 0
check_cmd rg 0

check_cmd claude "${REQUIRE_CLAUDE}"
check_cmd gemini "${REQUIRE_GEMINI}"

if [[ "${missing_required}" -ne 0 ]]; then
  echo "[result] FAIL: missing required dependency" >&2
  exit 1
fi

echo "[result] OK"
exit 0

