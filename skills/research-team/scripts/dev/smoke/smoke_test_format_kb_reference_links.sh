#!/usr/bin/env bash
set -euo pipefail

# Smoke test: format_kb_reference_links.py rewrites opaque capsule I bullets into readable links.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "KBRefFmtTest" >/dev/null

mkdir -p "${tmp_root}/knowledge_base/literature" "${tmp_root}/knowledge_base/methodology_traces/M0" "${tmp_root}/knowledge_base/priors"
cat > "${tmp_root}/knowledge_base/literature/one.md" <<'EOF'
# lit

RefKey: Dummy2026
Authors: A. Author et al.
Publication: Unpublished (2026)
Links:
- arXiv: https://arxiv.org/abs/0711.1635
EOF
echo "# trace: selection rationale" > "${tmp_root}/knowledge_base/methodology_traces/M0/trace.md"
echo "# conventions" > "${tmp_root}/knowledge_base/priors/conventions.md"

python3 - <<PY
from pathlib import Path
import re

root = Path("${tmp_root}")
p = root / "Draft_Derivation.md"
text = p.read_text(encoding="utf-8", errors="replace").replace("\\r\\n", "\\n").replace("\\r", "\\n")

start="<!-- REPRO_CAPSULE_START -->"
end="<!-- REPRO_CAPSULE_END -->"
assert start in text and end in text
a=text.index(start)
b=text.index(end)+len(end)
capsule=text[a:b]

section = """
### I) Knowledge base references (MANDATORY when enabled)

Literature:
- knowledge_base/literature/one.md

Methodology traces:
- knowledge_base/methodology_traces/M0/trace.md

Priors:
- knowledge_base/priors/conventions.md
""".strip()+"\\n"

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
PY

python3 "${BIN_DIR}/format_kb_reference_links.py" --notes "${tmp_root}/Draft_Derivation.md" --in-place >/dev/null

if ! rg -nF "Dummy2026 — A. Author et al. — lit" "${tmp_root}/Draft_Derivation.md" >/dev/null; then
  echo "[smoke][fail] expected literature label rewrite" >&2
  sed -n '1,220p' "${tmp_root}/Draft_Derivation.md" >&2
  exit 1
fi
if ! rg -nF -- "- [trace: selection rationale](knowledge_base/methodology_traces/M0/trace.md)" "${tmp_root}/Draft_Derivation.md" >/dev/null; then
  echo "[smoke][fail] expected methodology trace label rewrite (title-only)" >&2
  sed -n '1,220p' "${tmp_root}/Draft_Derivation.md" >&2
  exit 1
fi
if ! rg -nF -- "- [conventions](knowledge_base/priors/conventions.md)" "${tmp_root}/Draft_Derivation.md" >/dev/null; then
  echo "[smoke][fail] expected priors label rewrite (title-only)" >&2
  sed -n '1,220p' "${tmp_root}/Draft_Derivation.md" >&2
  exit 1
fi

echo "[smoke][ok] format_kb_reference_links.py rewrites capsule I bullets"
