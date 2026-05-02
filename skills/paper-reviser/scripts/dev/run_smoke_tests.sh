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
  local full_document="$3"
  local out_dir="${tmp_root}/${name}"

  set +e
  python3 "${BIN}" --in "${input_tex}" --out-dir "${out_dir}" --stub-models
  local rc=$?
  set -e

  # Core artifacts (must exist)
  test -s "${out_dir}/original.tex"
  test -s "${out_dir}/clean.tex"
  test -s "${out_dir}/changes.diff"
  test -s "${out_dir}/changes.md"
  test -f "${out_dir}/open_questions.md"
  test -s "${out_dir}/readthrough.md"
  test -f "${out_dir}/risk_flags.md"
  test -f "${out_dir}/global_style_notes.md"
  test -s "${out_dir}/audit.md"
  test -s "${out_dir}/response_revision_audit.md"
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

  python3 - <<'PY' "${out_dir}/run.json" "${out_dir}" "${full_document}" "${rc}"
import json
import sys
from pathlib import Path
p = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
full_document = sys.argv[3] == "true"
rc = int(sys.argv[4])
obj = json.loads(p.read_text(encoding="utf-8"))
tracked = obj.get("tracked_delivery", {})
assert obj.get("models", {}).get("deep_verifier", {}).get("enabled") is True, obj
assert (out_dir / "response_revision_audit.md").is_file()
if full_document:
    if tracked.get("status") == "ready":
        assert rc == 0, (rc, obj)
        assert obj.get("exit_status") == 0, obj
        assert obj.get("converged") is True, obj
        assert obj.get("auditor_verdict") == "READY", obj
        assert (out_dir / "tracked.tex").is_file()
    else:
        assert rc == 1, (rc, obj)
        assert obj.get("exit_status") == 1, obj
        assert obj.get("converged") is False, obj
        assert obj.get("auditor_verdict") == "NOT_READY", obj
        assert tracked.get("status") == "not_ready", obj
        assert tracked.get("delivery_kind") == "latexdiff_required", obj
        assert not (out_dir / "tracked.tex").exists()
else:
    assert rc == 0, (rc, obj)
    assert obj.get("exit_status") == 0, obj
    assert obj.get("converged") is True, obj
    assert tracked.get("status") == "audit_only", obj
    assert tracked.get("valid_tracked_delivery") is False, obj
    assert tracked.get("delivery_kind") == "fragment_audit_view", obj
    assert not (out_dir / "tracked.tex").exists()
    assert (out_dir / "tracked_fragment_audit.tex").is_file()
print("ok:", p, tracked.get("status"))
PY
}

run_fast() {
  local name="$1"
  local input_tex="$2"
  local out_dir="${tmp_root}/${name}"

  set +e
  python3 "${BIN}" --in "${input_tex}" --out-dir "${out_dir}" --stub-models --mode fast
  local rc=$?
  set -e

  test -s "${out_dir}/clean.tex"
  test -s "${out_dir}/changes.diff"
  test -s "${out_dir}/changes.md"
  test -s "${out_dir}/deep_verification.md"
  test -s "${out_dir}/run.json"
  test -s "${out_dir}/response_revision_audit.md"
  rg -n "## Tool notes" "${out_dir}/changes.md" >/dev/null
  rg -n "mode fast" "${out_dir}/changes.md" >/dev/null

  python3 - <<'PY' "${out_dir}/run.json" "${out_dir}/deep_verification.md" "${out_dir}" "${rc}"
import json
import sys
from pathlib import Path
run_p = Path(sys.argv[1])
deep_p = Path(sys.argv[2])
out_dir = Path(sys.argv[3])
rc = int(sys.argv[4])
obj = json.loads(run_p.read_text(encoding="utf-8"))
assert obj.get("mode") == "fast", obj
assert obj.get("models", {}).get("deep_verifier", {}).get("enabled") is False, obj
deep = deep_p.read_text(encoding="utf-8", errors="replace")
assert "skipped" in deep.lower(), deep
tracked = obj.get("tracked_delivery", {})
if tracked.get("status") == "ready":
    assert rc == 0, (rc, obj)
    assert obj.get("exit_status") == 0, obj
    assert obj.get("converged") is True, obj
    assert (out_dir / "tracked.tex").is_file()
else:
    assert rc == 1, (rc, obj)
    assert obj.get("exit_status") == 1, obj
    assert obj.get("converged") is False, obj
    assert tracked.get("status") == "not_ready", obj
print("ok:", run_p, tracked.get("status"))
PY
}

run_one "full" "${FIXTURES_DIR}/minimal_full.tex" true
run_one "fragment" "${FIXTURES_DIR}/minimal_fragment.tex" false
run_fast "fast_full" "${FIXTURES_DIR}/minimal_full.tex"

echo "paper-reviser smoke tests: OK"
