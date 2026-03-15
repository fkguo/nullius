#!/usr/bin/env bash
set -euo pipefail

# Smoke test for discover_latex_zero_arg_macros.py:
# scaffold → inject macros in Markdown + LaTeX sources → discover/update config → deterministic fix → gate passes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_markdown_latex_macro_hygiene.py"
DISCOVER="${BIN_DIR}/discover_latex_zero_arg_macros.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeLatexMacroDiscovery" --profile "mixed" >/dev/null 2>&1

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

mkdir -p "${tmp_root}/references/arxiv_src/2301.12345"
cat > "${tmp_root}/references/arxiv_src/2301.12345/main.tex" <<'EOF'
% commented-out macro must be ignored:
% \newcommand{\Bad}{BAD}

\newcommand{\Rc}{\mathcal{R}}
\renewcommand{\Mc}{\mathcal{M}}
\providecommand{\Cc}{\mathcal{C}}
\def\cK{\mathcal{K}}

% 1-arg macro must be ignored:
\newcommand{\foo}[1]{\mathbf{#1}}

\DeclareMathOperator{\re}{Re}
\DeclareMathOperator*{\im}{Im}
EOF

cat >> "${tmp_root}/research_preflight.md" <<'EOF'

## Smoke: macros from arXiv sources (intentional; should be rejected until expanded)

Using $\Rc$, $\Mc$, $\Cc$, $\cK$, plus operators $\re z$ and $\im z$.
EOF

set +e
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/gate_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected latex macro hygiene gate to fail before fixes; got:" >&2
  sed -n '1,160p' "${tmp_root}/gate_fail.log" >&2 || true
  exit 1
fi
echo "[ok] gate fails before fixes"

python3 "${DISCOVER}" --root "${tmp_root}" --update-config --strict >/dev/null 2>&1

python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
lm = d.get("latex_macro_hygiene", {}) if isinstance(d.get("latex_macro_hygiene", {}), dict) else {}
exp = lm.get("expansions", {}) if isinstance(lm.get("expansions", {}), dict) else {}
forbid = set(str(x) for x in (lm.get("forbidden_macros") or []))

req = {"Rc", "Mc", "Cc", "cK", "re", "im"}
missing = [k for k in req if k not in exp or k not in forbid]
if missing:
    raise SystemExit(f"missing expected macros in config: {missing}")
if "foo" in exp or "foo" in forbid:
    raise SystemExit("parameterized macro foo must NOT be discovered/added")
if "Bad" in exp or "Bad" in forbid:
    raise SystemExit("commented-out macro Bad must NOT be discovered/added")
print("[ok] config updated with discovered 0-arg macros only")
PY

python3 "${BIN_DIR}/fix_markdown_latex_macros.py" --root "${tmp_root}/research_preflight.md" --in-place >/dev/null 2>&1
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1

echo "[ok] latex 0-arg macro discovery smoke test passed"

