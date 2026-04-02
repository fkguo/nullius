#!/usr/bin/env bash
set -euo pipefail

# Smoke test for knowledge layers gate:
# scaffold → (gate should fail because capsule I missing/empty) → add minimal KB + capsule I → gate passes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATES_DIR="${SKILL_ROOT}/scripts/gates"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "KBTest" --full >/dev/null

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

set +e
python3 "${GATES_DIR}/check_knowledge_layers.py" --notes "${tmp_root}/research_contract.md" >/tmp/kb_gate_out1.txt 2>&1
code1=$?
set -e
if [[ $code1 -eq 0 ]]; then
  echo "[smoke][fail] expected knowledge layers gate to fail before capsule I is filled" >&2
  sed -n '1,120p' /tmp/kb_gate_out1.txt >&2
  exit 1
fi
echo "[smoke][ok] gate fails as expected when capsule I is missing/empty"

# Create minimal KB files and add capsule I section into the capsule block.
mkdir -p "${tmp_root}/knowledge_base/literature" "${tmp_root}/knowledge_base/methodology_traces/M0" "${tmp_root}/knowledge_base/priors"
cat > "${tmp_root}/knowledge_base/literature/one.md" <<'EOF'
# lit

RefKey: Dummy2026
Authors: A. Author et al.
Publication: Unpublished (2026)
Links:
- arXiv: https://arxiv.org/abs/0711.1635
EOF
echo "# trace" > "${tmp_root}/knowledge_base/methodology_traces/M0/trace.md"
echo "# priors" > "${tmp_root}/knowledge_base/priors/conventions.md"

python3 - <<PY
from pathlib import Path
import re

p=Path("${tmp_root}")/"research_contract.md"
text=p.read_text(encoding="utf-8", errors="replace")
start="<!-- REPRO_CAPSULE_START -->"
end="<!-- REPRO_CAPSULE_END -->"
assert start in text and end in text
a=text.index(start)
b=text.index(end)+len(end)
capsule=text[a:b]

section = """
### I) Knowledge base references (MANDATORY when enabled)

Literature:
- [knowledge_base/literature/one.md](knowledge_base/literature/one.md)

Methodology traces:
- [knowledge_base/methodology_traces/M0/trace.md](knowledge_base/methodology_traces/M0/trace.md)

Priors:
- [knowledge_base/priors/conventions.md](knowledge_base/priors/conventions.md)
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
        # "I)" is the last capsule section in the template; keep the end marker.
        end_off = capsule.index(end)
    capsule = capsule[:start_off] + section + capsule[end_off:]
else:
    capsule = capsule.replace(end, "\\n\\n"+section+"\\n"+end)

text = text[:a] + capsule + text[b:]
p.write_text(text, encoding="utf-8")
PY

python3 "${GATES_DIR}/check_knowledge_layers.py" --notes "${tmp_root}/research_contract.md" >/tmp/kb_gate_out2.txt 2>&1
echo "[smoke][ok] gate passes after adding KB + capsule I"

# Regression: referenced KB notes must follow Markdown math hygiene rules.
echo "[test2] math hygiene: fail then pass"
cat >> "${tmp_root}/knowledge_base/literature/one.md" <<'EOF'

## Broken math excerpt (intentional)

$$
a = 1
-2 b
$$

$$
\qquad c
$$
EOF

set +e
python3 "${GATES_DIR}/check_knowledge_layers.py" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/kb_gate_out3.txt" 2>&1
code3=$?
set -e
if [[ $code3 -eq 0 ]]; then
  echo "[smoke][fail] expected knowledge layers gate to fail on KB math hygiene" >&2
  sed -n '1,200p' "${tmp_root}/kb_gate_out3.txt" >&2
  exit 1
fi
if ! grep -nF "Markdown hazard" "${tmp_root}/kb_gate_out3.txt" >/dev/null 2>&1; then
  echo "[smoke][fail] expected math hygiene marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/kb_gate_out3.txt" >&2
  exit 1
fi
echo "[smoke][ok] math hygiene failure caught"

python3 "${BIN_DIR}/fix_markdown_math_hygiene.py" --root "${tmp_root}/knowledge_base/literature/one.md" --in-place >/dev/null 2>&1
python3 - "${tmp_root}" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
p = root / "knowledge_base/literature/one.md"
t = p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
assert "\\quad -2 b\n\n\\qquad c" in t, "expected blank line between merged split blocks to be preserved"
print("[smoke][ok] blank line preserved inside merged $$ block")
PY

python3 "${GATES_DIR}/check_knowledge_layers.py" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/kb_gate_out4.txt" 2>&1
echo "[smoke][ok] math hygiene passes after fix"

echo "[test3] reject inline '\\$\\$ ... \\$\\$' (prevents parser desync)"
cat >> "${tmp_root}/knowledge_base/literature/one.md" <<'EOF'

## Inline display math (intentional; should be rejected)

$$ x = 1 $$
EOF

set +e
python3 "${GATES_DIR}/check_knowledge_layers.py" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/kb_gate_out5.txt" 2>&1
code5=$?
set -e
if [[ $code5 -eq 0 ]]; then
  echo "[smoke][fail] expected knowledge layers gate to reject inline \\$\\$ usage" >&2
  sed -n '1,220p' "${tmp_root}/kb_gate_out5.txt" >&2
  exit 1
fi
if ! grep -nF "found '\$\$' not on its own line" "${tmp_root}/kb_gate_out5.txt" >/dev/null 2>&1; then
  echo "[smoke][fail] expected inline-\\$\\$ marker; got:" >&2
  sed -n '1,240p' "${tmp_root}/kb_gate_out5.txt" >&2
  exit 1
fi
echo "[smoke][ok] inline \\$\\$ rejected"

# Fix the inline $$ and confirm the gate passes again.
python3 "${BIN_DIR}/fix_markdown_math_hygiene.py" --root "${tmp_root}/knowledge_base/literature/one.md" --in-place >/dev/null 2>&1

python3 "${GATES_DIR}/check_knowledge_layers.py" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/kb_gate_out6.txt" 2>&1
echo "[smoke][ok] gate passes after fixing inline \\$\\$"

echo "[test4] autofix must not rewrite inline code examples with \\$\\$"
cat >> "${tmp_root}/knowledge_base/literature/one.md" <<'EOF'

Literal inline-code example (must remain verbatim): `$$ x = 1 $$`
EOF
python3 "${BIN_DIR}/fix_markdown_math_hygiene.py" --root "${tmp_root}/knowledge_base/literature/one.md" --in-place >/dev/null 2>&1
if ! grep -nF 'Literal inline-code example (must remain verbatim): `$$ x = 1 $$`' "${tmp_root}/knowledge_base/literature/one.md" >/dev/null 2>&1; then
  echo "[smoke][fail] expected inline-code $$ example to remain unchanged" >&2
  sed -n '1,220p' "${tmp_root}/knowledge_base/literature/one.md" >&2
  exit 1
fi
python3 "${GATES_DIR}/check_knowledge_layers.py" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1
echo '[smoke][ok] inline-code $$ example preserved'

echo "[test5] autofix must not rewrite multiple inline \\$\\$ blocks on one line"
cat > "${tmp_root}/multi_inline.md" <<'EOF'
This line is intentionally NOT a display fence; it contains two inline $$ segments.
$$ a $$ vs $$ b $$
EOF
before="$(cat "${tmp_root}/multi_inline.md")"
python3 "${BIN_DIR}/fix_markdown_math_hygiene.py" --root "${tmp_root}/multi_inline.md" --in-place >/dev/null 2>&1
after="$(cat "${tmp_root}/multi_inline.md")"
if [[ "${before}" != "${after}" ]]; then
  echo "[smoke][fail] expected multi-inline $$ line to remain unchanged; diff:" >&2
  diff -u <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") >&2 || true
  exit 1
fi
echo '[smoke][ok] multi-inline $$ line preserved'

echo "[test6] autofix must ignore ~~~ fenced code blocks"
cat > "${tmp_root}/tilde_fence.md" <<'EOF'
~~~text
$$
- not math
$$
~~~
EOF
before2="$(cat "${tmp_root}/tilde_fence.md")"
python3 "${BIN_DIR}/fix_markdown_math_hygiene.py" --root "${tmp_root}/tilde_fence.md" --in-place >/dev/null 2>&1
after2="$(cat "${tmp_root}/tilde_fence.md")"
if [[ "${before2}" != "${after2}" ]]; then
  echo "[smoke][fail] expected ~~~ fenced code to remain unchanged; diff:" >&2
  diff -u <(printf '%s\n' "${before2}") <(printf '%s\n' "${after2}") >&2 || true
  exit 1
fi
echo "[smoke][ok] ~~~ fenced code ignored"
