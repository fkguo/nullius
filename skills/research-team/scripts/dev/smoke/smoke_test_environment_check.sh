#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CHECK_ENV="${SKILL_ROOT}/scripts/bin/check_environment.sh"

echo "[test1] required deps present -> exit 0"
bash "${CHECK_ENV}" >/tmp/smoke_env_check_out1.txt 2>&1

echo "[test2] missing required -> exit 1 (simulate by removing PATH)"
set +e
PATH="/nonexistent" /bin/bash "${CHECK_ENV}" >/tmp/smoke_env_check_out2.txt 2>&1
code=$?
set -e
if [[ "${code}" -eq 0 ]]; then
  echo "[fail] expected non-zero exit when PATH is empty" >&2
  cat /tmp/smoke_env_check_out2.txt >&2
  exit 1
fi
if ! rg -n "missing required" /tmp/smoke_env_check_out2.txt >/dev/null 2>&1; then
  if ! grep -n "missing required" /tmp/smoke_env_check_out2.txt >/dev/null 2>&1; then
    echo "[fail] expected fixable error message; got:" >&2
    cat /tmp/smoke_env_check_out2.txt >&2
    exit 1
  fi
fi
echo "[ok] smoke env checks passed"
