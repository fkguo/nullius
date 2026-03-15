#!/usr/bin/env bash
set -euo pipefail

# Regression test for the capsule headline tier contract:
# - Every "- Hn:" line must include [T1]/[T2]/[T3]
# - At least one Tier-T2/T3 headline is required by default (nontrivial proxy/diagnostic)
#
# This test runs the deterministic capsule gate only (no external LLM calls).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATES_DIR="${SKILL_ROOT}/scripts/gates"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeCapsuleHeadlineTiers"

mkdir -p "${tmp_root}/runs/demo" "${tmp_root}/scripts"
cat > "${tmp_root}/runs/demo/manifest.json" <<'JSON'
{"created_at":"2026-01-13T00:00:00Z","command":"echo demo","outputs":["runs/demo/summary.json","runs/demo/analysis.json"]}
JSON
cat > "${tmp_root}/runs/demo/summary.json" <<'JSON'
{"stats":{"q1":1,"q2":2}}
JSON
cat > "${tmp_root}/runs/demo/analysis.json" <<'JSON'
{"results":{"q3":3}}
JSON
echo "# demo" > "${tmp_root}/scripts/demo.py"

fill_capsule() {
  local headline_block="$1"
  python3 - "${tmp_root}/research_contract.md" "${headline_block}" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

path = Path(sys.argv[1])
headline_block = sys.argv[2]
text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

start = "<!-- REPRO_CAPSULE_START -->"
end = "<!-- REPRO_CAPSULE_END -->"
if start not in text or end not in text:
    raise SystemExit("missing capsule markers in template")

a = text.index(start) + len(start)
b = text.index(end)
capsule = f"""
## Reproducibility Capsule (MANDATORY, per milestone/tag)

- Milestone/tag: M0
- Milestone kind: dataset
- Date: 2026-01-13

### A) Model, normalization, units, and truncation

- Starting equations / model variant: demo
- Normalization / units (explicit): demo
- Retained terms (LO/NLO etc.; write what is kept): demo
- Dropped terms / truncation (write what is discarded and why): demo

### B) Exact inputs (numbers + scheme/scale)

| Name | Value | Units/Normalization | Notes (scheme/scale) |
|---|---:|---|---|
| a | 1.0 | demo | demo |

### G) Sweep semantics / parameter dependence (MANDATORY)

- Scanned variables: a in [1.0, 1.0] step 1.0 (no scan; baseline)
- Dependent recomputations: none (baseline)
- Held-fixed constants: all other params fixed (baseline)

### H) Branch Semantics / Multi-root Contract (MANDATORY)

- Multi-root quantities: none
- Bands shown: no
- Branches: none

### C) One-command reproduction (exact CLI)

```bash
echo demo
```

### D) Expected outputs (paths) + provenance

- runs/demo/manifest.json
- runs/demo/summary.json
- runs/demo/analysis.json

### E) Headline numbers (at least 3; copied from artifacts, not “see file”)

{headline_block.strip()}

### F) Environment versions + key source pointers (paths; include hash/commit if possible)

- Environment:
  - python: 3.11
  - numpy: 1.26
- Source pointers (include hash/commit if possible):
  - scripts/demo.py (git=deadbeef)
""".strip()

out = text[:a] + "\n\n" + capsule + "\n\n" + text[b:]
path.write_text(out, encoding="utf-8")
print("filled capsule:", path)
PY
}

run_gate_expect_fail() {
  local label="$1"
  local expect_pat="$2"
  set +e
  python3 "${GATES_DIR}/check_reproducibility_capsule.py" --notes "${tmp_root}/research_contract.md" --root "${tmp_root}" >/tmp/smoke_capsule_tiers.txt 2>&1
  local code=$?
  set -e
  if [ "${code}" -eq 0 ]; then
    echo "[fail] expected capsule gate failure (${label}); got exit=0" >&2
    sed -n '1,200p' /tmp/smoke_capsule_tiers.txt >&2
    exit 1
  fi
  if ! grep -nE "${expect_pat}" /tmp/smoke_capsule_tiers.txt >/dev/null 2>&1; then
    echo "[fail] expected failure pattern not found (${label}): ${expect_pat}" >&2
    sed -n '1,240p' /tmp/smoke_capsule_tiers.txt >&2
    exit 1
  fi
  echo "[ok] expected failure (${label})"
}

run_gate_expect_pass() {
  set +e
  python3 "${GATES_DIR}/check_reproducibility_capsule.py" --notes "${tmp_root}/research_contract.md" --root "${tmp_root}" >/tmp/smoke_capsule_tiers.txt 2>&1
  local code=$?
  set -e
  if [ "${code}" -ne 0 ]; then
    echo "[fail] expected capsule gate pass; got exit=${code}" >&2
    sed -n '1,240p' /tmp/smoke_capsule_tiers.txt >&2
    exit 1
  fi
  echo "[ok] capsule gate passed"
}

echo "[test1] missing tier tags must fail"
fill_capsule $'- Min nontrivial headlines: 1\n- H1: Q1 = 1 (from runs/demo/summary.json:stats.q1)\n- H2: Q2 = 2 (from runs/demo/summary.json:stats.q2)\n- H3: Q3 ≈ 3 (from runs/demo/analysis.json:results.q3)'
run_gate_expect_fail "missing tier tags" "Missing tier tag|explicit tier tag"

echo "[test2] all-T1 headlines must fail (nontrivial requirement)"
fill_capsule $'- Min nontrivial headlines: 1\n- H1: [T1] Q1 = 1 (from runs/demo/summary.json:stats.q1)\n- H2: [T1] Q2 = 2 (from runs/demo/summary.json:stats.q2)\n- H3: [T1] Q3 ≈ 3 (from runs/demo/analysis.json:results.q3)'
run_gate_expect_fail "all T1" "Need at least .* nontrivial headline"

echo "[test3] all-T1 headlines allowed when Min nontrivial headlines: 0"
fill_capsule $'- Min nontrivial headlines: 0\n- H1: [T1] Q1 = 1 (from runs/demo/summary.json:stats.q1)\n- H2: [T1] Q2 = 2 (from runs/demo/summary.json:stats.q2)\n- H3: [T1] Q3 ≈ 3 (from runs/demo/analysis.json:results.q3)'
run_gate_expect_pass

echo "[test4] at least one T2/T3 headline must pass"
fill_capsule $'- Min nontrivial headlines: 1\n- H1: [T1] Q1 = 1 (from runs/demo/summary.json:stats.q1)\n- H2: [T2] Q2 = 2 (from runs/demo/summary.json:stats.q2)\n- H3: [T1] Q3 ≈ 3 (from runs/demo/analysis.json:results.q3)'
run_gate_expect_pass

echo "[ok] capsule headline tier smoke tests passed"
