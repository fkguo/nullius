#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_member_evidence.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeFullAccessEvidence" --profile "mixed" --full >/dev/null 2>&1
notes="${tmp_root}/research_contract.md"

# Enable full_access + evidence_schema_gate.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d["review_access_mode"] = "full_access"
d.setdefault("features", {})
d["features"]["evidence_schema_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

run_dir="${tmp_root}/team/runs/M0-r1"
mkdir -p "${run_dir}"

cat > "${run_dir}/member_a_evidence.json" <<'JSON'
{}
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

echo "[test1] fail case (member_a invalid)"
set +e
python3 "${GATE}" --notes "${notes}" --member-a "${run_dir}/member_a_evidence.json" --member-b "${run_dir}/member_b_evidence.json" >"${tmp_root}/ev_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected evidence schema gate to fail; got:" >&2
  sed -n '1,220p' "${tmp_root}/ev_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF -- "- Gate: FAIL" "${tmp_root}/ev_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected FAIL marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/ev_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] pass case (both valid)"
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

python3 "${GATE}" --notes "${notes}" --member-a "${run_dir}/member_a_evidence.json" --member-b "${run_dir}/member_b_evidence.json" >"${tmp_root}/ev_pass.log" 2>&1
if ! grep -nF -- "- Gate: PASS" "${tmp_root}/ev_pass.log" >/dev/null 2>&1; then
  echo "[fail] expected PASS marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/ev_pass.log" >&2 || true
  exit 1
fi
echo "[ok] evidence schema gate smoke test passed"
