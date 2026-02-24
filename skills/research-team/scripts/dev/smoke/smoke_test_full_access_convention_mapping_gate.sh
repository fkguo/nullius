#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_convention_mappings.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeFullAccessConventionMapping" --profile "mixed" >/dev/null 2>&1
notes="${tmp_root}/Draft_Derivation.md"

# Enable full_access + convention_mapping_gate + trigger via config.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d["review_access_mode"] = "full_access"
d.setdefault("features", {})
d["features"]["convention_mapping_gate"] = True
d["convention_mapping"] = {"required": True}
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

run_dir="${tmp_root}/team/runs/M0-r1"
mkdir -p "${run_dir}"

cat > "${run_dir}/member_a_evidence.json" <<'JSON'
{
  "version": 1,
  "member_id": "member_a",
  "mode": "full_access",
  "timestamps": {"start_utc": "2026-01-01T00:00:00.000000Z", "end_utc": ""},
  "files_read": [],
  "commands_run": [],
  "network_queries": [],
  "fetched_sources": [],
  "outputs_produced": [{"path": "team/runs/M0-r1/member_a_stub.txt", "sha256": "0", "description": "stub"}],
  "environment": {"os": "", "python_version": "", "julia_version": "", "git_commit": "", "cwd": ""},
  "convention_mappings": []
}
JSON

cat > "${run_dir}/member_b_evidence.json" <<'JSON'
{
  "version": 1,
  "member_id": "member_b",
  "mode": "full_access",
  "timestamps": {"start_utc": "2026-01-01T00:00:00.000000Z", "end_utc": ""},
  "files_read": [],
  "commands_run": [],
  "network_queries": [],
  "fetched_sources": [],
  "outputs_produced": [{"path": "team/runs/M0-r1/member_b_stub.txt", "sha256": "0", "description": "stub"}],
  "environment": {"os": "", "python_version": "", "julia_version": "", "git_commit": "", "cwd": ""},
  "convention_mappings": []
}
JSON

echo "[test1] fail case (required but missing)"
set +e
python3 "${GATE}" --notes "${notes}" --member-a "${run_dir}/member_a_evidence.json" --member-b "${run_dir}/member_b_evidence.json" >"${tmp_root}/cm_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected convention mapping gate to fail; got:" >&2
  sed -n '1,220p' "${tmp_root}/cm_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF -- "- Gate: FAIL" "${tmp_root}/cm_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected FAIL marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/cm_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] pass case (both provide mappings)"
python3 - "${run_dir}/member_a_evidence.json" "${run_dir}/member_b_evidence.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

for p in [Path(sys.argv[1]), Path(sys.argv[2])]:
    d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
    d["convention_mappings"] = [
        {
            "source_anchors": ["references/paperA.tex:Eq.(12)", "references/paperB.tex:Eq.(7)"],
            "explicit_relation": "T^{[A]} = (4\\pi\\alpha_s) T^{[B]}",
            "sanity_check": "Assuming \\alpha_s~0.3 gives prefactor ~3.8; numbers should shift by O(1), not 1e6.",
        }
    ]
    p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

python3 "${GATE}" --notes "${notes}" --member-a "${run_dir}/member_a_evidence.json" --member-b "${run_dir}/member_b_evidence.json" >"${tmp_root}/cm_pass.log" 2>&1
if ! grep -nF -- "- Gate: PASS" "${tmp_root}/cm_pass.log" >/dev/null 2>&1; then
  echo "[fail] expected PASS marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/cm_pass.log" >&2 || true
  exit 1
fi
echo "[ok] convention mapping gate smoke test passed"
