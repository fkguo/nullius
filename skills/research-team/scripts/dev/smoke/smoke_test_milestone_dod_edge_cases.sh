#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
GATES_DIR="${SKILL_ROOT}/scripts/gates"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

cd "${tmp_root}"

cat >research_team_config.json <<'EOF'
{
  "version": 1,
  "mode": "theory_numerics",
  "profile": "toolkit_extraction",
  "features": {
    "milestone_dod_gate": true
  }
}
EOF

cat >Draft_Derivation.md <<'EOF'
<!-- REPRO_CAPSULE_START -->
- Milestone kind: computational
<!-- REPRO_CAPSULE_END -->
EOF

mkdir -p knowledge_base/methodology_traces
cat >knowledge_base/methodology_traces/M2_trace.md <<'EOF'
# M2 trace (smoke)
EOF

cat >TOOLKIT_API.md <<'EOF'
# TOOLKIT API (smoke)
EOF

echo "[test1] multi-paragraph bullets + nested bullets (PASS)"
cat >RESEARCH_PLAN.md <<'EOF'
# RESEARCH_PLAN.md

## 3. Milestones

### M2 — DoD Edge Cases (multi-paragraph + nested)

Deliverables:
  - `artifacts/M2-r1/analysis.json`

    Continuation paragraph that should stay attached to the same bullet.
      - Nested detail bullet (should not count as a separate deliverable).

Acceptance:
  - `python3 scripts/run.sh --tag M2-r1` exits 0

    Another paragraph; still part of the same acceptance bullet.

Toolkit delta:
  - API spec pointer: [TOOLKIT_API.md](TOOLKIT_API.md)
  - Code snippet index:
    - `threebody_toolkit/benchmarks/n11be_j1.py`
    - `threebody_toolkit/util.py`
  - KB evidence links: [M2 trace](knowledge_base/methodology_traces/M2_trace.md)
EOF

python3 "${GATES_DIR}/check_milestone_dod.py" --notes Draft_Derivation.md --tag "M2-r1" >smoke_dod_out1.txt 2>&1
if ! grep -nF "Gate: PASS" smoke_dod_out1.txt >/dev/null 2>&1; then
  echo "[fail] expected PASS; got:" >&2
  sed -n '1,220p' smoke_dod_out1.txt >&2
  exit 1
fi

echo "[test2] label variants + ordered lists (PASS)"
cat >RESEARCH_PLAN.md <<'EOF'
# RESEARCH_PLAN.md

## Milestones

### M2 — DoD Edge Cases (label variants)

- Deliverables:
  1. `artifacts/M2-r1/analysis.json` (exists in real project; smoke only)

Acceptance:
  * `bash scripts/run.sh` returns 0 (smoke-only contract)

Toolkit delta:
  - API spec pointer: [TOOLKIT_API.md](TOOLKIT_API.md)
  - Code snippet index: `src/toolkit.py` (smoke-only pointer)
  - KB evidence link: [trace](knowledge_base/methodology_traces/M2_trace.md)
EOF

python3 "${GATES_DIR}/check_milestone_dod.py" --notes Draft_Derivation.md --tag "M2-r1" >smoke_dod_out2.txt 2>&1
if ! grep -nF "Gate: PASS" smoke_dod_out2.txt >/dev/null 2>&1; then
  echo "[fail] expected PASS; got:" >&2
  sed -n '1,220p' smoke_dod_out2.txt >&2
  exit 1
fi

echo "[test3] Chinese Toolkit label variant (PASS)"
cat >RESEARCH_PLAN.md <<'EOF'
# RESEARCH_PLAN.md

## 3. Milestones

### M2 — DoD Edge Cases (中文 label)

Deliverables:
  - `artifacts/M2-r1/analysis.json`

Acceptance:
  - `python3 scripts/run.sh` exits 0

工具包增量:
  - API spec pointer: [TOOLKIT_API.md](TOOLKIT_API.md)
  - Code snippet index: `threebody_toolkit/benchmarks/n11be_j1.py`
  - KB evidence link: [trace](knowledge_base/methodology_traces/M2_trace.md)
EOF

python3 "${GATES_DIR}/check_milestone_dod.py" --notes Draft_Derivation.md --tag "M2-r1" >smoke_dod_out3.txt 2>&1
if ! grep -nF "Gate: PASS" smoke_dod_out3.txt >/dev/null 2>&1; then
  echo "[fail] expected PASS; got:" >&2
  sed -n '1,220p' smoke_dod_out3.txt >&2
  exit 1
fi

echo "[test4] rejects backtick-wrapped knowledge_base link (FAIL)"
cat >RESEARCH_PLAN.md <<'EOF'
# RESEARCH_PLAN.md

## 3. Milestones

### M2 — DoD Edge Cases (link hygiene)

Deliverables:
  - `artifacts/M2-r1/analysis.json`

Acceptance:
  - `python3 scripts/run.sh` exits 0

Toolkit delta:
  - API spec pointer: [TOOLKIT_API.md](TOOLKIT_API.md)
  - Code snippet index: `threebody_toolkit/benchmarks/n11be_j1.py`
  - KB evidence link: `[trace](knowledge_base/methodology_traces/M2_trace.md)`
EOF

set +e
python3 "${GATES_DIR}/check_milestone_dod.py" --notes Draft_Derivation.md --tag "M2-r1" >smoke_dod_out4.txt 2>&1
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "[fail] expected FAIL; got:" >&2
  sed -n '1,220p' smoke_dod_out4.txt >&2
  exit 1
fi
if ! grep -nF "backticks" smoke_dod_out4.txt >/dev/null 2>&1; then
  echo "[fail] expected failure to mention backticks; output follows:" >&2
  sed -n '1,220p' smoke_dod_out4.txt >&2
  exit 1
fi

echo "[test5] rejects missing Acceptance label (FAIL)"
cat >RESEARCH_PLAN.md <<'EOF'
# RESEARCH_PLAN.md

## 3. Milestones

### M2 — DoD Edge Cases (missing Acceptance)

Deliverables:
  - `artifacts/M2-r1/analysis.json`

Toolkit delta:
  - API spec pointer: [TOOLKIT_API.md](TOOLKIT_API.md)
  - Code snippet index: `threebody_toolkit/benchmarks/n11be_j1.py`
  - KB evidence link: [trace](knowledge_base/methodology_traces/M2_trace.md)
EOF

set +e
python3 "${GATES_DIR}/check_milestone_dod.py" --notes Draft_Derivation.md --tag "M2-r1" >smoke_dod_out5.txt 2>&1
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "[fail] expected FAIL; got:" >&2
  sed -n '1,220p' smoke_dod_out5.txt >&2
  exit 1
fi
if ! grep -nF "Acceptance" smoke_dod_out5.txt >/dev/null 2>&1; then
  echo "[fail] expected failure to mention 'Acceptance'; output follows:" >&2
  sed -n '1,220p' smoke_dod_out5.txt >&2
  exit 1
fi

echo "[ok] milestone DoD edge-case smoke tests passed"
