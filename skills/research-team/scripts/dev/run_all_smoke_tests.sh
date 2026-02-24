#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_DIR="${SCRIPT_DIR}/smoke"

if [[ ! -d "${SMOKE_DIR}" ]]; then
  echo "ERROR: smoke dir not found: ${SMOKE_DIR}" >&2
  exit 2
fi

tests=( "${SMOKE_DIR}"/smoke_test_*.sh )
if [[ ${#tests[@]} -eq 0 || "${tests[0]}" == "${SMOKE_DIR}/smoke_test_*.sh" ]]; then
  echo "ERROR: no smoke tests found in: ${SMOKE_DIR}" >&2
  exit 2
fi

for t in "${tests[@]}"; do
  echo "=== ${t##*/} ==="
  bash "${t}"
done

echo "[ok] all smoke tests passed"
