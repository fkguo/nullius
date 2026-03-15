#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_logic_isolation.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeFullAccessLogicIsolation" --profile "mixed" >/dev/null 2>&1
notes="${tmp_root}/research_contract.md"

# Enable full_access + logic_isolation_gate.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d["review_access_mode"] = "full_access"
d.setdefault("features", {})
d["features"]["logic_isolation_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

tag="M0-r1"
mkdir -p "${tmp_root}/project" "${tmp_root}/shared_utils"
cat > "${tmp_root}/project/__init__.py" <<'PY'
# local package (for smoke)
PY
cat > "${tmp_root}/project/core.py" <<'PY'
def core_logic() -> int:
    return 1
PY
cat > "${tmp_root}/shared_utils/__init__.py" <<'PY'
# shared utils (allowed)
PY
cat > "${tmp_root}/shared_utils/num.py" <<'PY'
def helper() -> float:
    return 0.0
PY

mkdir -p "${tmp_root}/artifacts/${tag}/member_a/independent"
cat > "${tmp_root}/artifacts/${tag}/member_a/independent/independent_repro.py" <<'PY'
import project.core

def run() -> int:
    return project.core.core_logic()
PY

echo "[test1] fail case (imports local project core)"
set +e
python3 "${GATE}" --notes "${notes}" --tag "${tag}" --project-root "${tmp_root}" >"${tmp_root}/li_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected logic isolation gate to fail; got:" >&2
  sed -n '1,220p' "${tmp_root}/li_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF -- "- Gate: FAIL" "${tmp_root}/li_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected FAIL marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/li_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] pass case (imports only shared_utils)"
cat > "${tmp_root}/artifacts/${tag}/member_a/independent/independent_repro.py" <<'PY'
import shared_utils.num

def run() -> float:
    return shared_utils.num.helper()
PY

python3 "${GATE}" --notes "${notes}" --tag "${tag}" --project-root "${tmp_root}" >"${tmp_root}/li_pass.log" 2>&1
if ! grep -nF -- "- Gate: PASS" "${tmp_root}/li_pass.log" >/dev/null 2>&1; then
  echo "[fail] expected PASS marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/li_pass.log" >&2 || true
  exit 1
fi
echo "[ok] logic isolation gate smoke test passed"

