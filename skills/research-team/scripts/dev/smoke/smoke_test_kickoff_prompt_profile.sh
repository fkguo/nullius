#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp1="$(mktemp -d)"
tmp2="$(mktemp -d)"
tmp3="$(mktemp -d)"
cleanup() { rm -rf "${tmp1}" "${tmp2}" "${tmp3}"; }
trap cleanup EXIT

echo "[smoke] tmp1=${tmp1}"
echo "[smoke] tmp2=${tmp2}"
echo "[smoke] tmp3=${tmp3}"

echo "[test1] profile from config: toolkit_extraction should NOT be overwritten to mixed"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp1}" --project "SmokeKickoff1" --profile "toolkit_extraction" >/tmp/smoke_kickoff_profile_out1.txt 2>&1
python3 "${BIN_DIR}/generate_project_start_prompt.py" --root "${tmp1}" --force >/tmp/smoke_kickoff_profile_out2.txt 2>&1
if ! grep -nF "  --profile toolkit_extraction" "${tmp1}/PROJECT_START_PROMPT.md" >/dev/null 2>&1; then
  echo "[fail] expected kickoff prompt to include '--profile toolkit_extraction'; got:" >&2
  sed -n '1,220p' "${tmp1}/PROJECT_START_PROMPT.md" >&2 || true
  exit 1
fi
if grep -nF "  --profile mixed" "${tmp1}/PROJECT_START_PROMPT.md" >/dev/null 2>&1; then
  echo "[fail] kickoff prompt incorrectly includes '--profile mixed' under toolkit_extraction; got:" >&2
  sed -n '1,220p' "${tmp1}/PROJECT_START_PROMPT.md" >&2 || true
  exit 1
fi
echo "[ok] config profile preserved"

echo "[test2] profile from config: mixed should be reflected"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp2}" --project "SmokeKickoff2" --profile "mixed" >/tmp/smoke_kickoff_profile_out3.txt 2>&1
python3 "${BIN_DIR}/generate_project_start_prompt.py" --root "${tmp2}" --force >/tmp/smoke_kickoff_profile_out4.txt 2>&1
if ! grep -nF "  --profile mixed" "${tmp2}/PROJECT_START_PROMPT.md" >/dev/null 2>&1; then
  echo "[fail] expected kickoff prompt to include '--profile mixed'; got:" >&2
  sed -n '1,220p' "${tmp2}/PROJECT_START_PROMPT.md" >&2 || true
  exit 1
fi
echo "[ok] mixed profile reflected"

echo "[test3] no config: kickoff prompt should omit --profile and instruct profile choice"
cat > "${tmp3}/INITIAL_INSTRUCTION.md" <<'EOF'
Goal: Smoke test kickoff prompt generation with no config.
EOF
python3 "${BIN_DIR}/generate_project_start_prompt.py" --root "${tmp3}" --force >/tmp/smoke_kickoff_profile_out5.txt 2>&1
if grep -nF "  --profile " "${tmp3}/PROJECT_START_PROMPT.md" >/dev/null 2>&1; then
  echo "[fail] expected no '--profile' line when config missing; got:" >&2
  sed -n '1,220p' "${tmp3}/PROJECT_START_PROMPT.md" >&2 || true
  exit 1
fi
if grep -nE "^[[:space:]]*--project .*\\\\$" "${tmp3}/PROJECT_START_PROMPT.md" >/dev/null 2>&1; then
  echo "[fail] expected scaffold command to terminate cleanly (no trailing backslash) when config missing; got:" >&2
  sed -n '1,220p' "${tmp3}/PROJECT_START_PROMPT.md" >&2 || true
  exit 1
fi
if ! grep -nF "No research_team_config found" "${tmp3}/PROJECT_START_PROMPT.md" >/dev/null 2>&1; then
  echo "[fail] expected profile choice instruction when config missing; got:" >&2
  sed -n '1,220p' "${tmp3}/PROJECT_START_PROMPT.md" >&2 || true
  exit 1
fi
echo "[ok] no-config behavior ok"

echo "[ok] kickoff prompt profile smoke tests passed"
