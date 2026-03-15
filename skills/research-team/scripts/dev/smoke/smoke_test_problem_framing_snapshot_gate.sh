#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATES_DIR="${SKILL_ROOT}/scripts/gates"

SCAFFOLD="${BIN_DIR}/scaffold_research_workflow.sh"
CHECK="${GATES_DIR}/check_problem_framing_snapshot.py"
FILL="${BIN_DIR}/auto_fill_prework.py"

if [[ ! -f "${SCAFFOLD}" || ! -f "${CHECK}" || ! -f "${FILL}" ]]; then
  echo "ERROR: missing required scripts" >&2
  echo "- scaffold: ${SCAFFOLD}" >&2
  echo "- check: ${CHECK}" >&2
  echo "- fill: ${FILL}" >&2
  exit 2
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

proj="${tmp_root}/proj"
mkdir -p "${proj}"

echo "[test] scaffold + Problem Framing gate + deterministic autofill"
bash "${SCAFFOLD}" --root "${proj}" --project "demo" --profile mixed >/dev/null

# Make initial instruction non-template-ish so goal line is meaningful.
cat > "${proj}/project_brief.md" <<'EOF'
Goal: smoke-test Problem Framing Snapshot gate + autofill.
EOF

set +e
python3 "${CHECK}" --notes "${proj}/research_contract.md" >/dev/null
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "ERROR: expected Problem Framing gate to fail on fresh scaffold (empty template fields)" >&2
  exit 1
fi

python3 "${FILL}" --root "${proj}" --deterministic >/dev/null

python3 "${CHECK}" --notes "${proj}/research_contract.md" >/dev/null
echo "[ok] Problem Framing Snapshot gate passes after autofill"
