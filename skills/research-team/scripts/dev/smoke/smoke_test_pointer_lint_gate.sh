#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_pointer_lint.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokePointerLint" --profile "mixed" >/dev/null 2>&1

notes="${tmp_root}/Draft_Derivation.md"

# Force a deterministic strategy: file symbol grep (no python import environment needed).
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["pointer_lint_gate"] = True
d.setdefault("pointer_lint", {})
d["pointer_lint"]["strategy"] = "file_symbol_grep"
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

mkdir -p "${tmp_root}/scripts"
cat > "${tmp_root}/scripts/demo_mod.py" <<'PY'
def good_symbol() -> int:
    return 1
PY

set_pointer_lines() {
  local mode="$1" # fail | pass
  python3 - "${notes}" "${mode}" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

notes = Path(sys.argv[1])
mode = sys.argv[2].strip()
text = notes.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

insert = ""
if mode == "fail":
    insert = "Pointer lint fixtures (smoke): `scripts/demo_mod.py:missing_symbol`"
elif mode == "pass":
    insert = "Pointer lint fixtures (smoke): `scripts/demo_mod.py:good_symbol`"
else:
    raise SystemExit(f"unknown mode: {mode}")

START = "<!-- POINTER_LINT_SMOKE_START -->"
END = "<!-- POINTER_LINT_SMOKE_END -->"

block = f"{START}\n{insert}\n{END}\n"
if START in text and END in text:
    a = text.index(START)
    b = text.index(END) + len(END)
    out = text[:a] + block + text[b:]
else:
    out = text.rstrip() + "\n\n" + block

notes.write_text(out, encoding="utf-8")
print("patched:", notes, "mode=", mode)
PY
}

echo "[test1] fail case (missing symbol)"
set_pointer_lines "fail" >/dev/null 2>&1
set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/pl_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected pointer lint to fail; got:" >&2
  sed -n '1,220p' "${tmp_root}/pl_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF -- "- Gate: FAIL" "${tmp_root}/pl_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected FAIL marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/pl_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] pass case (symbol exists)"
set_pointer_lines "pass" >/dev/null 2>&1
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/pl_pass.log" 2>&1
if ! grep -nF -- "- Gate: PASS" "${tmp_root}/pl_pass.log" >/dev/null 2>&1; then
  echo "[fail] expected PASS marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/pl_pass.log" >&2 || true
  exit 1
fi
echo "[ok] pointer lint gate pass/fail smoke test passed"
