#!/usr/bin/env bash
set -euo pipefail

# Minimal smoke test for:
# scaffold → build_team_packet → run_team_cycle (fails fast when capsule incomplete)
#
# This test does NOT require claude/gemini CLIs because the capsule gate runs before any external calls.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeTest"

# 1) Build packet from the scaffolded research_contract.md (capsule is present but unfilled) and verify run_team_cycle fails fast.
python3 "${BIN_DIR}/build_team_packet.py" --tag M0 --notes "${tmp_root}/research_contract.md" --out "${tmp_root}/prompts/team_packet_M0.txt"

set +e
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0 \
  --packet "${tmp_root}/prompts/team_packet_M0.txt" \
  --out-dir "${tmp_root}/team" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  >/tmp/smoke_out.txt 2>&1
code=$?
set -e

if [[ $code -eq 0 ]]; then
  echo "[smoke][fail] expected non-zero exit when capsule is incomplete" >&2
  exit 1
fi
if ! grep -n "Reproducibility Capsule incomplete" /tmp/smoke_out.txt >/dev/null 2>&1; then
  echo "[smoke][fail] expected fail-fast capsule message; got:" >&2
  sed -n '1,120p' /tmp/smoke_out.txt >&2
  exit 1
fi
# Path-resolution hint should be present.
if ! grep -n "Relative paths are resolved relative to:" /tmp/smoke_out.txt >/dev/null 2>&1; then
  echo "[smoke][fail] expected path-resolution hint in capsule failure output; got:" >&2
  sed -n '1,120p' /tmp/smoke_out.txt >&2
  exit 1
fi
echo "[smoke][ok] capsule gate fails fast as expected"

# 2) Fill the capsule minimally so the capsule gate passes, then verify failure happens later (system/tools),
# without the capsule-incomplete message. We only edit the capsule block.
python3 - "${tmp_root}/research_contract.md" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace")

start = "<!-- REPRO_CAPSULE_START -->"
end = "<!-- REPRO_CAPSULE_END -->"
if start not in text or end not in text:
    raise SystemExit("missing capsule markers in template")

a = text.index(start) + len(start)
b = text.index(end)
capsule = f"""
## Reproducibility Capsule (MANDATORY, per milestone/tag)

- Milestone/tag: M0-r1
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

### I) Knowledge base references (MANDATORY when enabled)

Literature:
- knowledge_base/literature/demo.md

Methodology traces:
- knowledge_base/methodology_traces/M0/trace.md

Priors:
- knowledge_base/priors/conventions.md

### C) One-command reproduction (exact CLI)

```bash
echo demo
```

### D) Expected outputs (paths) + provenance

- runs/demo/manifest.json
- runs/demo/summary.json
- runs/demo/analysis.json
- figures/demo/main.png

### E) Headline numbers (at least 3; copied from artifacts, not “see file”)

- Min nontrivial headlines: 1
- H1: [T1] Q1 = 1 (from runs/demo/summary.json:stats.q1)
- H2: [T1] Q2 = 2 (from runs/demo/summary.json:stats.q2)
- H3: [T2] Q3 ≈ 3 (from runs/demo/headlines.csv?where=m_pi_gev:0.14&field=sA_re)

### F) Environment versions + key source pointers (paths; include hash/commit if possible)

- Environment:
  - python: 3.11
  - numpy: 1.26
- Manifest.toml: sha256=deadbeef
- Source pointers (include hash/commit if possible):
  - scripts/demo.py (git=deadbeef)
""".strip()

out = text[:a] + "\n\n" + capsule + "\n\n" + text[b:]
path.write_text(out, encoding="utf-8")
print("filled capsule:", path)
PY

mkdir -p "${tmp_root}/knowledge_base/literature" "${tmp_root}/knowledge_base/methodology_traces/M0" "${tmp_root}/knowledge_base/priors"
echo "# demo lit" > "${tmp_root}/knowledge_base/literature/demo.md"
echo "# demo trace" > "${tmp_root}/knowledge_base/methodology_traces/M0/trace.md"
echo "# demo priors" > "${tmp_root}/knowledge_base/priors/conventions.md"

mkdir -p "${tmp_root}/runs/demo"
mkdir -p "${tmp_root}/scripts"
cat > "${tmp_root}/runs/demo/manifest.json" <<'JSON'
{"created_at":"2026-01-13T00:00:00Z","command":"echo demo","outputs":["runs/demo/summary.json","runs/demo/analysis.json"]}
JSON
cat > "${tmp_root}/runs/demo/summary.json" <<'JSON'
{"stats":{"q1":1,"q2":2}}
JSON
cat > "${tmp_root}/runs/demo/analysis.json" <<'JSON'
{"results":{"q3":3}}
JSON
cat > "${tmp_root}/runs/demo/headlines.csv" <<'CSV'
m_pi_gev,sA_re
0.14,3
CSV
echo "# demo" > "${tmp_root}/scripts/demo.py"
mkdir -p "${tmp_root}/figures/demo"
printf '\x89PNG\r\n\x1a\n' > "${tmp_root}/figures/demo/main.png"

# Embed the main figure in the notebook (required by capsule gate).
printf '\n\n## 7. Results\n\n![](figures/demo/main.png)\n' >> "${tmp_root}/research_contract.md"

python3 "${BIN_DIR}/build_team_packet.py" --tag M0 --notes "${tmp_root}/research_contract.md" --out "${tmp_root}/prompts/team_packet_M0b.txt"

set +e
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0 \
  --packet "${tmp_root}/prompts/team_packet_M0b.txt" \
  --out-dir "${tmp_root}/team" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --member-a-runner /bin/false \
  --member-b-runner /bin/false \
  >/tmp/smoke_out2.txt 2>&1
code2=$?
set -e

if grep -n "Reproducibility Capsule incomplete" /tmp/smoke_out2.txt >/dev/null 2>&1; then
  echo "[smoke][fail] expected capsule gate to pass after filling; got:" >&2
  sed -n '1,120p' /tmp/smoke_out2.txt >&2
  exit 1
fi

echo "[smoke][ok] capsule gate passes after filling (subsequent failures, if any, are unrelated)"
exit 0
