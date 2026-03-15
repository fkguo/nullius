#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == -* ]]; then
  python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/autopilot_loop.py" "$@"
  exit $?
fi

ROOT="${1:-.}"
NOTES_DEFAULT="${ROOT}/research_contract.md"
OUT_DIR_DEFAULT="${ROOT}/team"

# Positional parsing is "soft":
# - arg1: root (always, if provided)
# - arg2: notes (only if it does NOT look like a flag)
# - arg3: out_dir (only if it does NOT look like a flag)
# This allows: `run_autopilot.sh . --once --mode assist`
NOTES="${NOTES_DEFAULT}"
OUT_DIR="${OUT_DIR_DEFAULT}"
shift_n=0
if (( $# >= 1 )); then
  shift_n=1
fi
if (( $# >= 2 )) && [[ "${2}" != -* ]]; then
  NOTES="${2}"
  shift_n=2
fi
if (( $# >= 3 )) && [[ "${3}" != -* ]]; then
  OUT_DIR="${3}"
  shift_n=3
fi
if (( shift_n > 0 )); then
  shift "${shift_n}"
fi

python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/autopilot_loop.py" \
  --root "${ROOT}" \
  --notes "${NOTES}" \
  --out-dir "${OUT_DIR}" \
  "$@"
