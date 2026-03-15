#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-M0-r1}"
NOTES="${2:-research_contract.md}"
OUT_DIR="${3:-team}"

MEMBER_A_SYSTEM="${MEMBER_A_SYSTEM:-prompts/_system_member_a.txt}"
MEMBER_B_SYSTEM="${MEMBER_B_SYSTEM:-prompts/_system_member_b.txt}"

LOCAL_RUNNER="${LOCAL_RUNNER:-}"
SKILL_DIR="${SKILL_DIR:-$HOME/.codex/skills/research-team}"

if [[ -n "${LOCAL_RUNNER}" ]]; then
  bash "${LOCAL_RUNNER}" "${TAG}"
elif [[ -x "scripts/run_local.sh" ]]; then
  bash "scripts/run_local.sh" "${TAG}"
fi

bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag "${TAG}" \
  --notes "${NOTES}" \
  --out-dir "${OUT_DIR}" \
  --member-a-system "${MEMBER_A_SYSTEM}" \
  --member-b-system "${MEMBER_B_SYSTEM}" \
  --auto-tag \
  --preflight-only

bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag "${TAG}" \
  --notes "${NOTES}" \
  --out-dir "${OUT_DIR}" \
  --member-a-system "${MEMBER_A_SYSTEM}" \
  --member-b-system "${MEMBER_B_SYSTEM}" \
  --auto-tag
