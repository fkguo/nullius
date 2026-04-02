#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the global double-backslash math gate:
# scaffold → baseline pass → inject double-backslash escapes → gate fails → deterministic fix (by config targets) → gate passes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_double_backslash_math.py"
FIX="${SKILL_ROOT}/scripts/bin/fix_markdown_double_backslash_math.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "ERROR: gate script missing: ${GATE}" >&2
  exit 2
fi
if [[ ! -f "${FIX}" ]]; then
  echo "ERROR: fixer script missing: ${FIX}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeDoubleBackslashGate" --profile "mixed" --full >/dev/null 2>&1

# Ensure the gate is enabled (explicit).
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["double_backslash_math_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

# Create a prior team output with the same hazard; the fixer in --notes mode must NOT rewrite it.
mkdir -p "${tmp_root}/team/runs/old"
cat >"${tmp_root}/team/runs/old/report.md" <<'EOF'
# old report

Inline: $\\Delta = 1$.
EOF

echo "[test0] baseline passes"
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1

echo "[test1] inject hazards into research_contract.md (intentional)"
cat >>"${tmp_root}/research_contract.md" <<'EOF'

<!-- SMOKE_DOUBLE_BACKSLASH_GATE_START -->
Inline math: $\\Delta = 1$, $k^\\* = 0$.
$$
\\gamma_{\\rm lin} = 2
$$
<!-- SMOKE_DOUBLE_BACKSLASH_GATE_END -->
EOF

set +e
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/gate_fail.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected double-backslash math gate to fail; got:" >&2
  sed -n '1,220p' "${tmp_root}/gate_fail.log" >&2 || true
  exit 1
fi
if ! grep -nF "double-backslash math gate failed" "${tmp_root}/gate_fail.log" >/dev/null 2>&1; then
  echo "[fail] expected failure marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/gate_fail.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo "[test2] deterministic fix via --notes then pass"
python3 "${FIX}" --notes "${tmp_root}/research_contract.md" --in-place >/dev/null 2>&1

python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1

# Ensure we did NOT rewrite prior team outputs.
if ! grep -nF "\\\\Delta = 1" "${tmp_root}/team/runs/old/report.md" >/dev/null 2>&1; then
  echo "[fail] expected old team report to remain unchanged (still contains \\\\Delta)" >&2
  sed -n '1,80p' "${tmp_root}/team/runs/old/report.md" >&2 || true
  exit 1
fi

echo "[ok] double-backslash math gate smoke test passed"
