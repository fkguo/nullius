#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SCAFFOLD="${SKILL_ROOT}/scripts/bin/scaffold_research_workflow.sh"
CHECK="${SKILL_ROOT}/scripts/dev/check_scaffold_output_contract.sh"

if [[ ! -f "${SCAFFOLD}" || ! -f "${CHECK}" ]]; then
  echo "ERROR: missing required scripts under: ${SKILL_ROOT}" >&2
  exit 2
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${SCAFFOLD}" --root "${tmp_root}/proj" --project "SmokeProject" --profile "mixed" --full
bash "${CHECK}" --root "${tmp_root}/proj" --variant full

echo "[ok] scaffold output contract smoke test passed"
