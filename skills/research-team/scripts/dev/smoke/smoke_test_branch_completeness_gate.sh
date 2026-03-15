#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_branch_completeness.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeBranchGate" --profile "mixed" >/dev/null 2>&1

notes="${tmp_root}/research_contract.md"

mkdir -p "${tmp_root}/runs"
cat > "${tmp_root}/runs/connected.csv" <<'CSV'
m_pi_gev,q05,q50,q95,n_ok
0.10,0.5,1.0,1.5,10
0.12,0.6,1.4,1.8,10
0.14,0.7,1.8,2.1,10
CSV

cat > "${tmp_root}/runs/diag.txt" <<'EOF'
smoke diagnostic artifact
EOF

patch_branch_section() {
  local mode="$1" # fail | pass
  python3 - "${notes}" "${mode}" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

notes = Path(sys.argv[1])
mode = sys.argv[2].strip()
text = notes.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

START = "<!-- REPRO_CAPSULE_START -->"
END = "<!-- REPRO_CAPSULE_END -->"
if START not in text or END not in text:
    raise SystemExit("missing capsule markers")
a = text.index(START)
b = text.index(END) + len(END)
capsule = text[a:b]

h_pat = re.compile(r"^###\s+H\)\s+Branch\s+Semantics\s*/\s*Multi-root\s+Contract\b.*?$", flags=re.MULTILINE | re.IGNORECASE)
m = h_pat.search(capsule)
if not m:
    raise SystemExit("missing H) section in capsule")
start = m.end()
m2 = re.search(r"^###\s+", capsule[start:], flags=re.MULTILINE)
end = start + (m2.start() if m2 else len(capsule) - start)

if mode == "fail":
    h_body = """
- Multi-root quantities: poles
- Bands shown: yes
- Branches: connected, disconnected

- Branch connected:
  - Output file: runs/connected.csv
  - Columns: m_pi_gev, q05, q50, q95, n_ok

- Continuity invariant: abs_delta(q50) <= 10
- Scan coordinate: m_pi_gev
- Diagnostic artifact: runs/diag.txt
""".strip()
elif mode == "pass":
    h_body = """
- Multi-root quantities: poles
- Bands shown: yes
- Branches: connected, disconnected

- Branch connected:
  - Output file: runs/connected.csv
  - Columns: m_pi_gev, q05, q50, q95, n_ok

- Branch disconnected:
  - Output file: runs/disconnected.csv
  - Columns: m_pi_gev, q05, q50, q95, n_ok

- Continuity invariant: abs_delta(q50) <= 1.0
- Scan coordinate: m_pi_gev
- Diagnostic artifact: runs/diag.txt
""".strip()
else:
    raise SystemExit(f"unknown mode: {mode}")

capsule2 = capsule[:start] + "\n\n" + h_body + "\n\n" + capsule[end:]
out = text[:a] + capsule2 + text[b:]
notes.write_text(out, encoding="utf-8")
print("patched branch section:", notes, "mode=", mode)
PY
}

ensure_body_cites_outputs() {
  python3 - "${notes}" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

START = "<!-- REPRO_CAPSULE_START -->"
END = "<!-- REPRO_CAPSULE_END -->"
if START not in text or END not in text:
    raise SystemExit("missing capsule markers")

cap_start = text.index(START)
cap_end = text.index(END) + len(END)

body_after = text[cap_end:]
needle = "runs/connected.csv"
if needle in body_after and "runs/disconnected.csv" in body_after:
    print("body already cites outputs")
    raise SystemExit(0)

insertion = "\n\n## 7. Results (smoke)\n\nThis smoke note cites per-branch outputs used for bands:\n- runs/connected.csv\n- runs/disconnected.csv\n"
p.write_text(text[:cap_end] + insertion + body_after, encoding="utf-8")
print("inserted citations in body:", p)
PY
}

echo "[test1] fail case: missing output mapping for a declared branch"
patch_branch_section "fail" >/dev/null 2>&1
set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/branch_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected branch completeness gate to fail; got:" >&2
  sed -n '1,260p' "${tmp_root}/branch_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF "Output mapping missing for branch" "${tmp_root}/branch_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected missing-output-mapping marker; got:" >&2
  sed -n '1,260p' "${tmp_root}/branch_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] pass case: complete contract + artifacts + citations"
cat > "${tmp_root}/runs/disconnected.csv" <<'CSV'
m_pi_gev,q05,q50,q95,n_ok
0.10,0.4,0.9,1.3,10
0.12,0.5,1.2,1.6,10
0.14,0.6,1.5,1.9,10
CSV

patch_branch_section "pass" >/dev/null 2>&1
ensure_body_cites_outputs >/dev/null 2>&1

python3 "${GATE}" --notes "${notes}" >"${tmp_root}/branch_pass.log" 2>&1
if ! grep -nF "[ok] branch completeness gate passed" "${tmp_root}/branch_pass.log" >/dev/null 2>&1; then
  echo "[fail] expected pass marker; got:" >&2
  sed -n '1,260p' "${tmp_root}/branch_pass.log" >&2 || true
  exit 1
fi
echo "[ok] branch completeness gate pass/fail smoke test passed"

