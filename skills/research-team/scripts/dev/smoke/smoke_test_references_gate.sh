#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATES_DIR="${SKILL_ROOT}/scripts/gates"
GATE="${GATES_DIR}/check_references_section.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeReferencesGate" --profile "mixed" >/dev/null 2>&1

# Ensure references gate is enabled deterministically.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["references_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

notes="${tmp_root}/Draft_Derivation.md"

mkdir -p "${tmp_root}/knowledge_base/literature"
cat > "${tmp_root}/knowledge_base/literature/recid-123.md" <<'EOF'
# Demo INSPIRE record (smoke)

RefKey: recid-123
Links:
- INSPIRE: https://inspirehep.net/literature/123
EOF

rewrite_references_section() {
  local mode="$1" # fail | pass
  python3 - "${notes}" "${mode}" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

notes = Path(sys.argv[1])
mode = sys.argv[2].strip()
text = notes.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

# Avoid template placeholders that would require additional References entries (keep the fixture minimal).
text = text.replace("knowledge_base/literature/recid-1234567.md", "knowledge_base/literature/recid-123.md")

# Replace the first "## ... References" section body deterministically.
m = re.search(r"^##\s+(?:\d+\.\s*)?References\b.*$", text, flags=re.MULTILINE | re.IGNORECASE)
if not m:
    raise SystemExit("missing References heading in template")
start = m.end()
m2 = re.search(r"^##\s+", text[start:], flags=re.MULTILINE)
end = start + (m2.start() if m2 else len(text) - start)

if mode == "fail":
    body = """
- [@recid-123](#ref-recid-123) <a id="ref-recid-123"></a> A. Author et al. (2026). Link: https://inspirehep.net/literature/123
""".strip() + "\n"
elif mode == "pass":
    body = """
- [@recid-123](#ref-recid-123) <a id="ref-recid-123"></a> A. Author et al. (2026). Link: https://inspirehep.net/literature/123 | KB: [recid-123](knowledge_base/literature/recid-123.md)
""".strip() + "\n"
elif mode == "host_fail":
    body = """
- [@recid-123](#ref-recid-123) <a id="ref-recid-123"></a> A. Author et al. (2026). Link: https://inspirehep.net/literature/123 | KB: [recid-123](knowledge_base/literature/recid-123.md)
- [@ads-test](#ref-ads-test) <a id="ref-ads-test"></a> A. Author et al. (2026). Link: https://ui.adsabs.harvard.edu/abs/2026PhRvD...fake | KB: [recid-123](knowledge_base/literature/recid-123.md)
""".strip() + "\n"
else:
    raise SystemExit(f"unknown mode: {mode}")

out = text[:start] + "\n\n" + body + "\n" + text[end:]
notes.write_text(out, encoding="utf-8")
print("patched:", notes, "mode=", mode)
PY
}

echo "[test1] references gate fails when KB link is missing"
rewrite_references_section "fail" >/dev/null 2>&1
set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/refs_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected references gate to fail; got:" >&2
  sed -n '1,200p' "${tmp_root}/refs_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF "missing knowledge_base link" "${tmp_root}/refs_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected missing-KB-link error; got:" >&2
  sed -n '1,220p' "${tmp_root}/refs_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] references gate passes when KB + external links exist"
rewrite_references_section "pass" >/dev/null 2>&1
set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/refs_pass.log" 2>&1
code2=$?
set -e
if [[ ${code2} -ne 0 ]]; then
  echo "[fail] expected references gate to pass; got exit=${code2}:" >&2
  sed -n '1,220p' "${tmp_root}/refs_pass.log" >&2 || true
  exit 1
fi
if ! grep -nF "[ok] references gate passed" "${tmp_root}/refs_pass.log" >/dev/null 2>&1; then
  echo "[fail] expected pass marker; got:" >&2
  sed -n '1,200p' "${tmp_root}/refs_pass.log" >&2 || true
  exit 1
fi
echo "[ok] references gate pass/fail smoke test passed"

echo "[test3] references gate fails for a non-allowlisted external host by default"
rewrite_references_section "host_fail" >/dev/null 2>&1
set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/refs_host_fail.log" 2>&1
code3=$?
set -e
if [[ ${code3} -eq 0 ]]; then
  echo "[fail] expected references gate to fail for unknown host; got:" >&2
  sed -n '1,220p' "${tmp_root}/refs_host_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF "external link host not allowed" "${tmp_root}/refs_host_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected external-host-allowlist error; got:" >&2
  sed -n '1,260p' "${tmp_root}/refs_host_fail.log" >&2 || true
  exit 1
fi
echo "[ok] host allowlist fail case"

echo "[test4] references gate passes when host is added via references.allowed_external_hosts_extra"
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
refs = d.get("references", {})
if not isinstance(refs, dict):
    refs = {}
extra = refs.get("allowed_external_hosts_extra", [])
if not isinstance(extra, list):
    extra = []
if "ui.adsabs.harvard.edu" not in extra:
    extra.append("ui.adsabs.harvard.edu")
refs["allowed_external_hosts_extra"] = extra
d["references"] = refs
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print("patched:", p)
PY

set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/refs_host_pass.log" 2>&1
code4=$?
set -e
if [[ ${code4} -ne 0 ]]; then
  echo "[fail] expected references gate to pass after extending allowlist; got exit=${code4}:" >&2
  sed -n '1,260p' "${tmp_root}/refs_host_pass.log" >&2 || true
  exit 1
fi
if ! grep -nF "[ok] references gate passed" "${tmp_root}/refs_host_pass.log" >/dev/null 2>&1; then
  echo "[fail] expected pass marker; got:" >&2
  sed -n '1,260p' "${tmp_root}/refs_host_pass.log" >&2 || true
  exit 1
fi
echo "[ok] host allowlist extension passed"
