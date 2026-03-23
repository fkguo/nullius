#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
log_file="$(mktemp)"
repo_output_dir="${SKILL_ROOT}/.tmp/smoke_external_output_guard"
cleanup() {
  rm -rf "${tmp_root}"
  rm -f "${log_file}"
  rm -rf "${repo_output_dir}"
}
trap cleanup EXIT

mkdir -p "${SKILL_ROOT}/.tmp"
proj="${tmp_root}/proj"

bash "${BIN_DIR}/scaffold_research_workflow.sh" \
  --root "${proj}" \
  --project "ExternalOutputGuard" \
  --profile mixed \
  --full >/dev/null

pushd "${proj}" >/dev/null
if bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0 \
  --notes research_contract.md \
  --out-dir "${repo_output_dir}" \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only >"${log_file}" 2>&1; then
  popd >/dev/null
  echo "ERROR: run_team_cycle unexpectedly allowed repo-internal real-project outputs" >&2
  cat "${log_file}" >&2
  exit 1
fi
popd >/dev/null

if ! rg -n "team output path must resolve outside the autoresearch-lab dev repo" "${log_file}" >/dev/null; then
  echo "ERROR: missing external-output guard message" >&2
  cat "${log_file}" >&2
  exit 1
fi

if [[ -e "${repo_output_dir}/runs" ]]; then
  echo "ERROR: repo-internal output guard should fail before creating run artifacts" >&2
  exit 1
fi

echo "[ok] external output guard smoke test passed"
