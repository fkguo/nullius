#!/usr/bin/env bash
set -euo pipefail

# Smoke tests for the Project Charter gate (project_charter.md).
#
# Coverage:
# - Missing charter fails
# - DRAFT status fails
# - Declared profile mismatch fails
# - Commitments require >=2 bullets and >=1 clickable KB link (not in backticks, not hidden in comments)
# - KB link path traversal / symlink escapes are rejected
# - A valid charter passes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_project_charter.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeCharterGate" --profile "mixed" >/dev/null 2>&1

notes="${tmp_root}/research_contract.md"
charter="${tmp_root}/project_charter.md"
cfg="${tmp_root}/research_team_config.json"

mkdir -p "${tmp_root}/knowledge_base/literature"
cat > "${tmp_root}/knowledge_base/literature/demo.md" <<'EOF'
# demo literature note

RefKey: DemoLit2026
Links:
- arXiv: https://arxiv.org/abs/0711.1635
EOF

# Ensure the gate is enabled deterministically.
python3 - "${cfg}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d["profile"] = "mixed"
d.setdefault("features", {})
d["features"]["project_charter_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

write_charter() {
  local status="$1"
  local declared_profile="$2"
  local primary_goal="$3"
  local validation_goal="$4"
  local anti_goal_bullet="$5"
  local commitment1="$6"
  local commitment2="$7"

  cat > "${charter}" <<EOF
# project_charter.md

Status: ${status}
Project: SmokeCharterGate
Root: .
Created: 2000-01-01
Last updated: 2000-01-01

## 0. Goal Hierarchy (MANDATORY)

Primary goal: ${primary_goal}

Validation goal(s): ${validation_goal}

Anti-goals / non-goals (must include at least 1):
- ${anti_goal_bullet}

## 1. Declared Profile (MANDATORY)

Declared profile: ${declared_profile}
Rationale: smoke fixture.

## 2. Reusable Outputs Contract (MANDATORY)

Project-specific commitments (fill at least 2 bullets; must include at least 1 KB link):
- ${commitment1}
- ${commitment2}
EOF
}

run_gate_expect_fail() {
  local label="$1"
  local expect_substr="$2"
  local log="${tmp_root}/${label}.log"

  set +e
  python3 "${GATE}" --notes "${notes}" >"${log}" 2>&1
  local code=$?
  set -e

  if [[ ${code} -eq 0 ]]; then
    echo "[fail] expected non-zero exit (${label}); got:" >&2
    sed -n '1,220p' "${log}" >&2 || true
    exit 1
  fi
  if [[ -n "${expect_substr}" ]] && ! grep -nF "${expect_substr}" "${log}" >/dev/null 2>&1; then
    echo "[fail] expected error marker '${expect_substr}' (${label}); got:" >&2
    sed -n '1,220p' "${log}" >&2 || true
    exit 1
  fi
  echo "[ok] ${label}"
}

run_gate_expect_ok() {
  local label="$1"
  local log="${tmp_root}/${label}.log"

  python3 "${GATE}" --notes "${notes}" >"${log}" 2>&1
  if ! grep -nF "[ok] project charter gate passed" "${log}" >/dev/null 2>&1; then
    echo "[fail] expected ok marker (${label}); got:" >&2
    sed -n '1,220p' "${log}" >&2 || true
    exit 1
  fi
  echo "[ok] ${label}"
}

echo "[test0] missing charter fails"
mv "${charter}" "${charter}.bak"
run_gate_expect_fail "t0_missing_charter" "Missing project_charter.md"
mv "${charter}.bak" "${charter}"

echo "[test1] DRAFT status fails"
write_charter \
  "DRAFT" \
  "mixed" \
  "smoke — ensure project charter gate rejects DRAFT" \
  "smoke — deterministic gate behavior" \
  "No goal drift." \
  "KB: [demo](knowledge_base/literature/demo.md)" \
  "Method: [template](knowledge_base/methodology_traces/_template.md)"
run_gate_expect_fail "t1_status_draft" "Status must be one of"

echo "[test2] declared profile mismatch fails"
write_charter \
  "APPROVED" \
  "theory" \
  "smoke — profile mismatch should fail" \
  "smoke — deterministic gate behavior" \
  "No goal drift." \
  "KB: [demo](knowledge_base/literature/demo.md)" \
  "Method: [template](knowledge_base/methodology_traces/_template.md)"
run_gate_expect_fail "t2_profile_mismatch" "Declared profile mismatch"

echo "[test3] commitments without KB link fails"
write_charter \
  "APPROVED" \
  "mixed" \
  "smoke — require KB link" \
  "smoke — deterministic gate behavior" \
  "No goal drift." \
  "Toolkit: something reusable but not KB" \
  "Method: described in words (no KB link)"
run_gate_expect_fail "t3_no_kb_link" "include at least 1 clickable Markdown link to knowledge_base/"

echo "[test4] backticked KB link fails"
write_charter \
  "APPROVED" \
  "mixed" \
  "smoke — reject backticked KB link" \
  "smoke — deterministic gate behavior" \
  "No goal drift." \
  "KB: \`[demo](knowledge_base/literature/demo.md)\`" \
  "Method: [template](knowledge_base/methodology_traces/_template.md)"
run_gate_expect_fail "t4_backticked_kb_link" "wrapped in backticks"

echo "[test5] HTML comment hidden KB link does not count"
write_charter \
  "APPROVED" \
  "mixed" \
  "smoke — reject hidden links in HTML comments" \
  "smoke — deterministic gate behavior" \
  "No goal drift." \
  "KB: <!-- [hidden](knowledge_base/literature/demo.md) --> must NOT count" \
  "Toolkit: placeholder but not a KB link"
run_gate_expect_fail "t5_hidden_comment_link" "include at least 1 clickable Markdown link to knowledge_base/"

echo "[test6] KB file symlink escape must be rejected"
outside_dir="$(mktemp -d)"
echo "outside" > "${outside_dir}/outside.md"
ln -s "${outside_dir}/outside.md" "${tmp_root}/knowledge_base/symlink_escape.md"
write_charter \
  "APPROVED" \
  "mixed" \
  "smoke — reject KB symlink escape" \
  "smoke — deterministic gate behavior" \
  "No goal drift." \
  "KB: [escape](knowledge_base/symlink_escape.md) — should be rejected" \
  "Method: [template](knowledge_base/methodology_traces/_template.md)"
run_gate_expect_fail "t6_kb_symlink_escape" "escapes the knowledge_base/ subtree"
rm -f "${tmp_root}/knowledge_base/symlink_escape.md"
rm -rf "${outside_dir}"

echo "[test7] knowledge_base/ directory symlink escape must be rejected"
outside_kb="$(mktemp -d)"
mkdir -p "${outside_kb}/methodology_traces"
cat > "${outside_kb}/README.md" <<'EOF'
# outside_kb README
EOF
cat > "${outside_kb}/methodology_traces/_template.md" <<'EOF'
# outside_kb template
EOF

mv "${tmp_root}/knowledge_base" "${tmp_root}/knowledge_base_real"
ln -s "${outside_kb}" "${tmp_root}/knowledge_base"

write_charter \
  "APPROVED" \
  "mixed" \
  "smoke — reject knowledge_base symlink outside project root" \
  "smoke — deterministic gate behavior" \
  "No goal drift." \
  "KB: [README](knowledge_base/README.md) — should be rejected (kb dir is symlink)" \
  "Method: [template](knowledge_base/methodology_traces/_template.md) — should be rejected"
run_gate_expect_fail "t7_kb_dir_symlink_escape" "escapes the knowledge_base/ subtree"

rm -f "${tmp_root}/knowledge_base"
mv "${tmp_root}/knowledge_base_real" "${tmp_root}/knowledge_base"
rm -rf "${outside_kb}"

echo "[test8] valid charter passes"
write_charter \
  "APPROVED" \
  "mixed" \
  "smoke — valid charter passes" \
  "smoke — deterministic gate behavior" \
  "No goal drift." \
  "KB: [demo](knowledge_base/literature/demo.md)" \
  "Method: [template](knowledge_base/methodology_traces/_template.md)"
run_gate_expect_ok "t8_valid_charter"

echo "[ok] project charter gate smoke tests passed"
