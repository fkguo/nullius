#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

mkdir -p "${SKILL_ROOT}/.tmp"
bad_root="$(mktemp -d "${SKILL_ROOT}/.tmp/smoke_external_root_guard.XXXXXX")"
log_file="$(mktemp)"
cleanup() {
  rm -rf "${bad_root}"
  rm -f "${log_file}"
}
trap cleanup EXIT

if bash "${BIN_DIR}/scaffold_research_workflow.sh" \
  --root "${bad_root}" \
  --project "RepoInternalGuard" \
  --profile mixed >"${log_file}" 2>&1; then
  echo "ERROR: scaffold unexpectedly allowed a repo-internal real project root" >&2
  cat "${log_file}" >&2
  exit 1
fi

if ! rg -n "outside the autoresearch-lab dev repo" "${log_file}" >/dev/null; then
  echo "ERROR: missing external-root guard message" >&2
  cat "${log_file}" >&2
  exit 1
fi

if [[ -e "${bad_root}/research_contract.md" ]]; then
  echo "ERROR: repo-internal root guard should fail before scaffold output is written" >&2
  exit 1
fi

echo "[ok] external root guard smoke test passed"
