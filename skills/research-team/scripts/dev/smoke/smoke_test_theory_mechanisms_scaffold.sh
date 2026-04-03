#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SCAFFOLD_ALL="${SKILL_ROOT}/scripts/bin/scaffold_research_workflow.sh"
SCAFFOLD_MECH="${SKILL_ROOT}/scripts/scaffold/scaffold_theory_mechanisms.sh"

if [[ ! -f "${SCAFFOLD_ALL}" || ! -f "${SCAFFOLD_MECH}" ]]; then
  echo "ERROR: missing scaffold scripts under: ${SCRIPT_DIR}" >&2
  exit 2
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

pgrep_q() {
  local pattern="$1"
  local file="$2"
  if command -v rg >/dev/null 2>&1; then
    rg -q "${pattern}" "${file}"
  else
    grep -q "${pattern}" "${file}"
  fi
}

echo "[test1] full scaffold creates mechanisms/"
bash "${SCAFFOLD_ALL}" --root "${tmp_root}/proj" --project "SmokeProject" --full

req_files=(
  "${tmp_root}/proj/mechanisms/00_pre_task_clarifier.md"
  "${tmp_root}/proj/mechanisms/01_analogy_mining.md"
  "${tmp_root}/proj/mechanisms/02_problem_framing_protocol.md"
  "${tmp_root}/proj/mechanisms/examples/clarifier_example.md"
)

for f in "${req_files[@]}"; do
  if [[ ! -f "${f}" ]]; then
    echo "ERROR: missing expected file: ${f}" >&2
    exit 1
  fi
done

echo "[test1b] default profile substitution (mixed)"
if pgrep_q "<PROFILE>" "${tmp_root}/proj/mechanisms/00_pre_task_clarifier.md"; then
  echo "ERROR: <PROFILE> placeholder not substituted in clarifier output" >&2
  exit 1
fi
if ! pgrep_q "mixed" "${tmp_root}/proj/mechanisms/00_pre_task_clarifier.md"; then
  echo "ERROR: expected default profile 'mixed' in clarifier output" >&2
  exit 1
fi

echo "[test1c] explicit profile propagation (theory_only)"
bash "${SCAFFOLD_ALL}" --root "${tmp_root}/proj_profile" --project "ProfileProject" --profile "theory_only" --full
if ! pgrep_q "theory_only" "${tmp_root}/proj_profile/mechanisms/00_pre_task_clarifier.md"; then
  echo "ERROR: expected substituted profile 'theory_only' in clarifier output" >&2
  exit 1
fi

echo "[test2] incremental scaffold respects --force"
sentinel="SENTINEL_DO_NOT_OVERWRITE"
echo "${sentinel}" > "${tmp_root}/proj/mechanisms/00_pre_task_clarifier.md"

set +e
bash "${SCAFFOLD_MECH}" --root "${tmp_root}/proj" --project "SmokeProject"
code=$?
set -e
if [[ $code -ne 0 ]]; then
  echo "ERROR: scaffold_theory_mechanisms.sh failed (exit ${code})" >&2
  exit 1
fi
if ! pgrep_q "${sentinel}" "${tmp_root}/proj/mechanisms/00_pre_task_clarifier.md"; then
  echo "ERROR: expected file to be preserved without --force" >&2
  exit 1
fi

bash "${SCAFFOLD_MECH}" --root "${tmp_root}/proj" --project "SmokeProject" --force
if pgrep_q "${sentinel}" "${tmp_root}/proj/mechanisms/00_pre_task_clarifier.md"; then
  echo "ERROR: expected --force to overwrite the sentinel file" >&2
  exit 1
fi

echo "[ok] smoke tests passed"
