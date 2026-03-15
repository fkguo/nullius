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

proj="${tmp_root}/proj"
bash "${SCAFFOLD}" --root "${proj}" --project "SmokeProject" --profile "mixed" --minimal
bash "${CHECK}" --root "${proj}" --variant minimal

if [[ ! -f "${proj}/research_notebook.md" ]]; then
  echo "ERROR: minimal scaffold missing research_notebook.md" >&2
  exit 1
fi
if [[ ! -f "${proj}/research_contract.md" ]]; then
  echo "ERROR: minimal scaffold missing research_contract.md" >&2
  exit 1
fi
if [[ -d "${proj}/prompts" || -d "${proj}/knowledge_base" || -f "${proj}/research_team_config.json" ]]; then
  echo "ERROR: minimal scaffold should not precreate host-local research-team surfaces" >&2
  exit 1
fi

echo "[ok] minimal scaffold smoke test passed"
