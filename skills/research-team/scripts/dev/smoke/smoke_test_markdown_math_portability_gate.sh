#!/usr/bin/env bash
set -euo pipefail

# Smoke test for Markdown math portability gate:
# scaffold → baseline pass → inject warn-only hazards → gate warns but exits 0
# → enable enforcement → gate fails (exit 1).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_markdown_math_portability.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeMarkdownMathPortability" --profile "mixed" --full >/dev/null 2>&1

# Ensure the gate is enabled (explicit) and warn-only by default.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["markdown_math_portability_gate"] = True
d.setdefault("markdown_math_portability", {})
d["markdown_math_portability"]["enforce_table_math_pipes"] = False
d["markdown_math_portability"]["enforce_slashed"] = False
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "[test0] baseline passes (no warnings)"
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/gate_ok.log" 2>&1
if ! grep -nF "[ok] markdown math portability gate passed" "${tmp_root}/gate_ok.log" >/dev/null 2>&1; then
  echo "[fail] expected baseline OK marker; got:" >&2
  sed -n '1,120p' "${tmp_root}/gate_ok.log" >&2 || true
  exit 1
fi

echo "[test1] inject warn-only hazards into research_preflight.md"
cat >>"${tmp_root}/research_preflight.md" <<'EOF'

## Smoke: Markdown math portability hazards (intentional)

Inline slashed: $\slashed{p}$.

| name | value |
| --- | --- |
| abs | $|x|$ |
EOF

python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/gate_warn.log" 2>&1
if ! grep -nF "[warn] markdown math portability:" "${tmp_root}/gate_warn.log" >/dev/null 2>&1; then
  echo "[fail] expected warning summary; got:" >&2
  sed -n '1,160p' "${tmp_root}/gate_warn.log" >&2 || true
  exit 1
fi
if ! grep -nF "found '\\slashed'" "${tmp_root}/gate_warn.log" >/dev/null 2>&1; then
  echo "[fail] expected slashed warning; got:" >&2
  sed -n '1,160p' "${tmp_root}/gate_warn.log" >&2 || true
  exit 1
fi
if ! grep -nF "Markdown table line contains inline math" "${tmp_root}/gate_warn.log" >/dev/null 2>&1; then
  echo "[fail] expected table-math-pipe warning; got:" >&2
  sed -n '1,200p' "${tmp_root}/gate_warn.log" >&2 || true
  exit 1
fi
echo "[ok] warn-only behavior"

echo "[test2] enable enforcement (table-math pipes) → fail"
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("markdown_math_portability", {})
d["markdown_math_portability"]["enforce_table_math_pipes"] = True
d["markdown_math_portability"]["enforce_slashed"] = False
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

set +e
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/gate_enforce_table.log" 2>&1
code_table=$?
set -e
if [[ ${code_table} -eq 0 ]]; then
  echo "[fail] expected enforcement failure; got:" >&2
  sed -n '1,220p' "${tmp_root}/gate_enforce_table.log" >&2 || true
  exit 1
fi
if ! grep -nF "[fail] markdown math portability gate failed" "${tmp_root}/gate_enforce_table.log" >/dev/null 2>&1; then
  echo "[fail] expected enforce failure marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/gate_enforce_table.log" >&2 || true
  exit 1
fi
echo "[ok] enforcement (table-math pipes) fails as expected"

echo "[test3] enable enforcement (slashed) → fail"
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("markdown_math_portability", {})
d["markdown_math_portability"]["enforce_table_math_pipes"] = False
d["markdown_math_portability"]["enforce_slashed"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

set +e
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/gate_enforce_slashed.log" 2>&1
code_slashed=$?
set -e
if [[ ${code_slashed} -eq 0 ]]; then
  echo "[fail] expected enforcement failure; got:" >&2
  sed -n '1,220p' "${tmp_root}/gate_enforce_slashed.log" >&2 || true
  exit 1
fi
if ! grep -nF "[fail] markdown math portability gate failed" "${tmp_root}/gate_enforce_slashed.log" >/dev/null 2>&1; then
  echo "[fail] expected enforce failure marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/gate_enforce_slashed.log" >&2 || true
  exit 1
fi

echo "[ok] markdown math portability gate smoke test passed"
