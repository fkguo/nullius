#!/usr/bin/env bash
set -euo pipefail

# execute_task.sh <task_id> <task_text>
# Implement task execution here. Exit 0 on success; non-zero on failure.
# Autopilot updates RESEARCH_PLAN.md Task Board status.
# For complex numerics, justify the algorithm choice and cite a stable-method reference in PREWORK.md.

TASK_ID="${1:-}"
TASK_TEXT="${2:-}"

if [[ -z "${TASK_ID}" ]]; then
  echo "ERROR: task_id required" >&2
  exit 2
fi

echo "[todo] Implement task executor for ${TASK_ID}: ${TASK_TEXT}"
echo "[todo] Autopilot will update Task Board after successful execution."
lower_text="$(echo "${TASK_TEXT}" | tr '[:upper:]' '[:lower:]')"

if [[ "${lower_text}" == *"(manual)"* ]]; then
  echo "[manual] ${TASK_ID}: ${TASK_TEXT}" >&2
  echo "[manual] Complete this task by editing files / running scripts, then re-run autopilot." >&2
  exit 3
fi

# Default-safe behavior: for auto tasks we do NOT pretend to "implement" anything here.
# Autopilot will run the team cycle next; if outputs/derivations are missing, gates/convergence will fail.
echo "[auto] ${TASK_ID}: no-op executor (implement automation here if desired)"
exit 0
