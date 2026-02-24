#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

mkdir -p "${tmp_root}/team/runs/T0"
debt_file="${tmp_root}/team/runs/T0/T0_exploration_debt.md"
cat >"${debt_file}" <<'EOF'
# Exploration Gate Debt

- Tag: T0
- Notes: Draft_Derivation.md

Items:

- [ ] 2026-01-01T00:00:00Z gate=references_gate exit_code=1 :: missing refs
EOF

out="$(python3 "${SKILL_ROOT}/scripts/bin/exploration_debt_dashboard.py" summary --team-dir "${tmp_root}/team" --max-items 5)"
echo "${out}" | grep -Fq "[debt] open items: 1"
echo "${out}" | grep -Fq "references_gate: 1"

python3 "${SKILL_ROOT}/scripts/bin/exploration_debt_dashboard.py" close --file "${debt_file}" --line 8

out2="$(python3 "${SKILL_ROOT}/scripts/bin/exploration_debt_dashboard.py" summary --team-dir "${tmp_root}/team" --max-items 5)"
echo "${out2}" | grep -Fq "[debt] open items: 0"

echo "[ok] exploration debt dashboard smoke test passed"
