#!/usr/bin/env bash
set -euo pipefail

# Smoke test: KB notes generated from literature_fetch.py templates must pass
# the knowledge-layers gate Markdown math hygiene checks.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATES_DIR="${SKILL_ROOT}/scripts/gates"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "LitFetchNoteMathHygiene" >/dev/null

# Ensure the mode enables knowledge_layers_gate by default (theory_numerics).
python3 - <<PY
from pathlib import Path
import json
p=Path("${tmp_root}")/"research_team_config.json"
obj=json.loads(p.read_text())
obj["mode"]="theory_numerics"
obj["features"]={}  # use mode defaults
obj.setdefault("pointer_lint", {})["strategy"]=""  # use mode defaults
p.write_text(json.dumps(obj, indent=2))
print("[ok] set mode=theory_numerics")
PY

mkdir -p "${tmp_root}/knowledge_base/literature" "${tmp_root}/knowledge_base/methodology_traces/M0" "${tmp_root}/knowledge_base/priors"
echo "# trace: generated" > "${tmp_root}/knowledge_base/methodology_traces/M0/trace.md"
echo "# priors: generated" > "${tmp_root}/knowledge_base/priors/conventions.md"

python3 - <<PY
from __future__ import annotations

import importlib.util
from pathlib import Path

bin_dir = Path("${BIN_DIR}")
spec = importlib.util.spec_from_file_location("literature_fetch", str(bin_dir / "literature_fetch.py"))
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)  # type: ignore[attr-defined]

rec = {
    "refkey": "recid-9999999",
    "recid": "9999999",
    "citekey": "Dummy:2026",
    "title": "Dummy Title",
    "authors": "A. Author et al.",
    "publication": "Unpublished (2026)",
    "year": "2026",
    "arxiv_id": "0711.1635",
    "doi": "10.0000/dummy",
    "inspire_url": "https://inspirehep.net/literature/9999999",
}

kb_note_rel = "knowledge_base/literature/recid-9999999.md"
out_path = Path("${tmp_root}") / kb_note_rel
out_path.write_text(mod._kb_note_template(rec, kb_note_rel), encoding="utf-8")  # type: ignore[attr-defined]
print("[ok] wrote:", out_path)
PY

python3 - <<PY
from pathlib import Path
import re

root = Path("${tmp_root}")
p = root / "Draft_Derivation.md"
text = p.read_text(encoding="utf-8", errors="replace")
start="<!-- REPRO_CAPSULE_START -->"
end="<!-- REPRO_CAPSULE_END -->"
assert start in text and end in text
a=text.index(start)
b=text.index(end)+len(end)
capsule=text[a:b]

section = """
### I) Knowledge base references (MANDATORY when enabled)

Literature:
- [recid-9999999](knowledge_base/literature/recid-9999999.md)

Methodology traces:
- [trace](knowledge_base/methodology_traces/M0/trace.md)

Priors:
- [priors](knowledge_base/priors/conventions.md)
""".strip()+"\n"

# Replace existing section body if present; otherwise insert before capsule end.
m = re.search(r"^###\\s+I\\)\\s+Knowledge\\s+base\\s+references.*?$", capsule, flags=re.MULTILINE)
if m:
    start_off = m.start()
    after = capsule[m.end():]
    m2 = re.search(r"^###\\s+", after, flags=re.MULTILINE)
    if m2:
        end_off = m.end() + m2.start()
    else:
        end_off = capsule.index(end)
    capsule = capsule[:start_off] + section + capsule[end_off:]
else:
    capsule = capsule.replace(end, "\\n\\n"+section+"\\n"+end)

text = text[:a] + capsule + text[b:]
p.write_text(text, encoding="utf-8")
print("[ok] patched capsule I")
PY

python3 "${GATES_DIR}/check_knowledge_layers.py" --notes "${tmp_root}/Draft_Derivation.md" >/dev/null

echo "[smoke][ok] literature_fetch KB note template passes knowledge-layers math hygiene"

