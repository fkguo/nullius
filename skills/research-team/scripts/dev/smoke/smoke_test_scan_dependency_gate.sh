#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_scan_dependency.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeScanDependency" --profile "mixed" >/dev/null 2>&1

notes="${tmp_root}/Draft_Derivation.md"

mkdir -p "${tmp_root}/runs/scan"
cat > "${tmp_root}/runs/scan/manifest.json" <<'JSON'
{"tag":"M0-scan","note":"smoke manifest"}
JSON

cat > "${tmp_root}/scan_dependency_rules.json" <<'JSON'
{
  "rules": [
    {
      "id": "alpha_requires_beta_vary",
      "description": "If alpha is scanned, beta must vary too (smoke).",
      "trigger": { "scanned_variable": { "match": "alpha" } },
      "required_columns": [
        { "name": "beta", "condition": "must_vary" }
      ],
      "error_message": "[RULE:{id}] scan dependency violation:\\n{errors}"
    }
  ]
}
JSON

write_scan_csv() {
  local mode="$1" # fail | pass
  if [[ "${mode}" == "fail" ]]; then
    cat > "${tmp_root}/runs/scan/scan.csv" <<'CSV'
alpha,beta
1,0
2,0
CSV
    return 0
  fi
  if [[ "${mode}" == "pass" ]]; then
    cat > "${tmp_root}/runs/scan/scan.csv" <<'CSV'
alpha,beta
1,0
2,1
CSV
    return 0
  fi
  echo "unknown mode: ${mode}" >&2
  return 2
}

patch_capsule_for_scan() {
  python3 - "${notes}" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

START = "<!-- REPRO_CAPSULE_START -->"
END = "<!-- REPRO_CAPSULE_END -->"
if START not in text or END not in text:
    raise SystemExit("missing capsule markers")
a = text.index(START)
b = text.index(END) + len(END)
capsule = text[a:b]

# Ensure scan outputs are listed in capsule D) so the gate can auto-find them.
def replace_section(capsule_text: str, heading_re: str, new_body: str) -> str:
    m = re.search(rf"^###\s+{heading_re}.*?$", capsule_text, flags=re.MULTILINE | re.IGNORECASE)
    if not m:
        raise SystemExit(f"missing capsule section: {heading_re}")
    start = m.end()
    m2 = re.search(r"^###\s+", capsule_text[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(capsule_text) - start)
    return capsule_text[:start] + "\n\n" + new_body.strip() + "\n\n" + capsule_text[end:]

g_body = """
- Scanned variables: alpha
- Dependent recomputations: beta must be recomputed when alpha changes (smoke contract)
- Held-fixed constants: none
""".strip()

d_body = """
- runs/scan/manifest.json
- runs/scan/scan.csv
""".strip()

capsule2 = replace_section(capsule, r"G\)\s+Sweep semantics\s*/\s*parameter dependence", g_body)
capsule3 = replace_section(capsule2, r"D\)\s+Expected outputs", d_body)

out = text[:a] + capsule3 + text[b:]
p.write_text(out, encoding="utf-8")
print("patched capsule sections for scan:", p)
PY
}

patch_capsule_for_scan >/dev/null 2>&1

echo "[test1] fail case: beta does not vary"
write_scan_csv "fail"
set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/scan_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected scan dependency gate to fail; got:" >&2
  sed -n '1,240p' "${tmp_root}/scan_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF "does not vary across the scan" "${tmp_root}/scan_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected must_vary violation marker; got:" >&2
  sed -n '1,260p' "${tmp_root}/scan_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] pass case: beta varies"
write_scan_csv "pass"
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/scan_pass.log" 2>&1
if ! grep -nF "[ok] scan dependency check passed" "${tmp_root}/scan_pass.log" >/dev/null 2>&1; then
  echo "[fail] expected pass marker; got:" >&2
  sed -n '1,240p' "${tmp_root}/scan_pass.log" >&2 || true
  exit 1
fi
echo "[ok] scan dependency gate pass/fail smoke test passed"
