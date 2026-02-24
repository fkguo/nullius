#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${ROOT_DIR}/scripts/bin/paper_reviser_edit.py"
FIXTURES_DIR="${ROOT_DIR}/scripts/dev/fixtures"

if [[ ! -f "${BIN}" ]]; then
  echo "ERROR: missing script: ${BIN}" >&2
  exit 2
fi

python3 -m py_compile "${BIN}"

tmp_root="$(mktemp -d /tmp/paper_reviser_smoke.XXXXXX)"
trap 'rm -rf "${tmp_root}"' EXIT

run_one() {
  local name="$1"
  local input_tex="$2"
  local out_dir="${tmp_root}/${name}"

  python3 "${BIN}" --in "${input_tex}" --out-dir "${out_dir}" --stub-models

  # Core artifacts (must exist)
  test -s "${out_dir}/original.tex"
  test -s "${out_dir}/clean.tex"
  test -s "${out_dir}/changes.diff"
  test -s "${out_dir}/tracked.tex"
  test -s "${out_dir}/changes.md"
  test -f "${out_dir}/open_questions.md"
  test -s "${out_dir}/readthrough.md"
  test -f "${out_dir}/risk_flags.md"
  test -f "${out_dir}/global_style_notes.md"
  test -s "${out_dir}/audit.md"
  test -f "${out_dir}/verification_requests.md"
  test -s "${out_dir}/verification_requests.json"
  test -s "${out_dir}/deep_verification.md"
  test -s "${out_dir}/run.json"

  # Optional: plan generator should work even with empty items.
  plan_py="${ROOT_DIR}/scripts/bin/build_verification_plan.py"
  if [[ -f "${plan_py}" ]]; then
    python3 "${plan_py}" --in "${out_dir}/verification_requests.json" --out "${out_dir}/verification_plan.json" >/dev/null
    test -s "${out_dir}/verification_plan.json"
  fi

  python3 - <<'PY' "${out_dir}/run.json"
import json
import sys
from pathlib import Path
p = Path(sys.argv[1])
obj = json.loads(p.read_text(encoding="utf-8"))
assert obj.get("exit_status") == 0, obj
assert obj.get("converged") is True, obj
assert obj.get("auditor_verdict") == "READY", obj
assert obj.get("deep_verifier_verdict") == "READY", obj
assert obj.get("models", {}).get("deep_verifier", {}).get("enabled") is True, obj
print("ok:", p)
PY
}

run_fast() {
  local name="$1"
  local input_tex="$2"
  local out_dir="${tmp_root}/${name}"

  python3 "${BIN}" --in "${input_tex}" --out-dir "${out_dir}" --stub-models --mode fast

  test -s "${out_dir}/clean.tex"
  test -s "${out_dir}/changes.diff"
  test -s "${out_dir}/changes.md"
  test -s "${out_dir}/deep_verification.md"
  test -s "${out_dir}/run.json"
  rg -n "## Tool notes" "${out_dir}/changes.md" >/dev/null
  rg -n "mode fast" "${out_dir}/changes.md" >/dev/null

  python3 - <<'PY' "${out_dir}/run.json" "${out_dir}/deep_verification.md"
import json
import sys
from pathlib import Path
run_p = Path(sys.argv[1])
deep_p = Path(sys.argv[2])
obj = json.loads(run_p.read_text(encoding="utf-8"))
assert obj.get("exit_status") == 0, obj
assert obj.get("converged") is True, obj
assert obj.get("mode") == "fast", obj
assert obj.get("models", {}).get("deep_verifier", {}).get("enabled") is False, obj
deep = deep_p.read_text(encoding="utf-8", errors="replace")
assert "skipped" in deep.lower(), deep
print("ok:", run_p)
PY
}

run_one "full" "${FIXTURES_DIR}/minimal_full.tex"
run_one "fragment" "${FIXTURES_DIR}/minimal_fragment.tex"
run_fast "fast_full" "${FIXTURES_DIR}/minimal_full.tex"

echo "paper-reviser smoke tests: OK"
