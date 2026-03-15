#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the global Markdown math hygiene gate:
# scaffold → baseline pass → inject hazards across PREWORK + knowledge_base → gate fails → run deterministic autofix → gate passes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_markdown_math_hygiene.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeMarkdownMathHygiene" --profile "mixed" >/dev/null 2>&1

# Ensure the gate is enabled (explicit).
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["markdown_math_hygiene_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "[test0] baseline passes"
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1

echo "[test1] inject hazards in research_preflight.md and knowledge_base"
cat >> "${tmp_root}/research_preflight.md" <<'EOF'

## Smoke: broken display math (intentional; should be rejected)

$$
a = 1
- b = 2
$$
EOF

mkdir -p "${tmp_root}/knowledge_base/literature"
cat > "${tmp_root}/knowledge_base/literature/hazard.md" <<'EOF'
# hazard (smoke)

RefKey: DummyHazard2026
Authors: A. Author et al.
Publication: Unpublished (2026)
Links:
- Link: none

## Broken split equation (intentional)

$$
a = 1
$$

$$
\qquad b = 2
$$
EOF

set +e
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/gate_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected markdown math hygiene gate to fail; got:" >&2
  sed -n '1,240p' "${tmp_root}/gate_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF "markdown math hygiene gate failed" "${tmp_root}/gate_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected failure marker; got:" >&2
  sed -n '1,240p' "${tmp_root}/gate_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] deterministic autofix then pass"
python3 "${BIN_DIR}/fix_markdown_math_hygiene.py" --root "${tmp_root}/research_preflight.md" --in-place >/dev/null 2>&1
python3 "${BIN_DIR}/fix_markdown_math_hygiene.py" --root "${tmp_root}/knowledge_base/literature/hazard.md" --in-place >/dev/null 2>&1

cat >> "${tmp_root}/research_preflight.md" <<'EOF'

## Smoke: TeX linebreak spacing is allowed (\\[2pt] should NOT be treated as disallowed \\[)

$$
a = 1 \\[2pt]
b = 2
$$
EOF

cat >> "${tmp_root}/research_preflight.md" <<'EOF'

~~~text
$$
- not math (code fence; should be ignored)
$$
~~~
EOF

python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1
echo "[ok] markdown math hygiene gate smoke test passed"
