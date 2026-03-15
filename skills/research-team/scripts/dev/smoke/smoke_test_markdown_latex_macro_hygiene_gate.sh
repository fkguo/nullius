#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the global LaTeX macro hygiene gate:
# scaffold → baseline pass → inject custom macros → gate fails → run deterministic macro expansion → gate passes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_markdown_latex_macro_hygiene.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeLatexMacroHygiene" --profile "mixed" >/dev/null 2>&1

# Ensure the gate is enabled (explicit).
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["latex_macro_hygiene_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "[test0] baseline passes"
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1

echo "[test1] inject hazards in research_preflight.md"
cat >> "${tmp_root}/research_preflight.md" <<'EOF'

## Smoke: custom LaTeX macro (intentional; should be rejected)

- Using paper macros in Markdown: $p \in \bar\Rc$ and $\Mc_2(q)=1$, with $\re s$ and $\im s$.
EOF

set +e
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/gate_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected latex macro hygiene gate to fail; got:" >&2
  sed -n '1,240p' "${tmp_root}/gate_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF "latex macro hygiene gate failed" "${tmp_root}/gate_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected failure marker; got:" >&2
  sed -n '1,240p' "${tmp_root}/gate_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] deterministic macro expansion then pass"
python3 "${BIN_DIR}/fix_markdown_latex_macros.py" --root "${tmp_root}/research_preflight.md" --in-place >/dev/null 2>&1

cat >> "${tmp_root}/research_preflight.md" <<'EOF'

## Smoke: prefix collisions must NOT trigger

These LaTeX commands/prefixes must not be mis-detected as `\re` or `\im`:
- \ref{fig:re}
- \implies
- \renewcommand
EOF

python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1

echo "[ok] latex macro hygiene gate smoke test passed"
