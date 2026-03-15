#!/usr/bin/env bash
set -euo pipefail

# Smoke tests for Claim DAG MVP:
# - scaffold creates knowledge_graph/
# - claim/evidence gates run deterministically (pass + fail cases)
# - run_team_cycle.sh supports --preflight-only to avoid external LLM calls

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATES_DIR="${SKILL_ROOT}/scripts/gates"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeClaimDAG"

# Fill the capsule minimally + create required artifacts so deterministic gates can run.
python3 - "${tmp_root}/research_contract.md" <<'PY'
from __future__ import annotations

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
capsule = """
## Reproducibility Capsule (MANDATORY, per milestone/tag)

- Milestone/tag: M0
- Date: 2026-01-14

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
- Source pointers (include hash/commit if possible):
  - scripts/demo.py (git=deadbeef)
""".strip()

out = text[:a] + "\n\n" + capsule + "\n\n" + text[b:]
path.write_text(out, encoding="utf-8")
print("filled capsule:", path)
PY

# Fill required marker blocks so notebook_integrity_gate can pass.
python3 - "${tmp_root}/research_contract.md" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8", errors="replace")

def replace_block(start: str, end: str, body: str) -> str:
    if start not in text or end not in text:
        raise SystemExit(f"missing markers: {start} ... {end}")
    a = text.index(start) + len(start)
    b = text.index(end)
    return text[:a] + "\n" + body.strip() + "\n" + text[b:]

EXCERPT_START = "<!-- REVIEW_EXCERPT_START -->"
EXCERPT_END = "<!-- REVIEW_EXCERPT_END -->"
AUDIT_START = "<!-- AUDIT_SLICES_START -->"
AUDIT_END = "<!-- AUDIT_SLICES_END -->"

text = replace_block(
    EXCERPT_START,
    EXCERPT_END,
    """Smoke-test excerpt: demo artifact-backed headline numbers.

$$
Q1 = 1, \\quad Q2 = 2, \\quad Q3 = 3.
$$
""",
)
text = replace_block(
    AUDIT_START,
    AUDIT_END,
    """- Key algorithm steps to cross-check:
  - Open `runs/demo/summary.json` and verify `stats.q1=1`, `stats.q2=2`.
  - Open `runs/demo/analysis.json` and verify `results.q3=3`.
- Proxy headline numbers (audit quantities; fast to verify by hand/estimate):
  - Q1 + Q2 = 3 (sanity check).
""",
)

p.write_text(text, encoding="utf-8")
print("filled excerpt/audit blocks:", p)
PY

mkdir -p "${tmp_root}/knowledge_base/literature" "${tmp_root}/knowledge_base/methodology_traces/M0" "${tmp_root}/knowledge_base/priors"
cat > "${tmp_root}/knowledge_base/literature/demo.md" <<'EOF'
# demo lit

RefKey: DemoLit2026
Authors: A. Author et al.
Publication: Unpublished (2026)
Links:
- arXiv: https://arxiv.org/abs/0711.1635
EOF
cat > "${tmp_root}/knowledge_base/literature/bezanson2017_julia.md" <<'EOF'
# Bezanson et al. 2017 — Julia: A Fresh Approach to Numerical Computing

RefKey: Bezanson2017
Authors: J. Bezanson et al.
Publication: SIAM Rev. 59 (2017) 65
Links:
- DOI: https://doi.org/10.1137/141000671
EOF
echo "# demo trace" > "${tmp_root}/knowledge_base/methodology_traces/M0/trace.md"
echo "# demo priors" > "${tmp_root}/knowledge_base/priors/conventions.md"

mkdir -p "${tmp_root}/runs/demo" "${tmp_root}/scripts" "${tmp_root}/figures/demo"
cat > "${tmp_root}/runs/demo/manifest.json" <<'JSON'
{"created_at":"2026-01-14T00:00:00Z","command":"echo demo","outputs":["runs/demo/summary.json","runs/demo/analysis.json"]}
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
printf '\x89PNG\r\n\x1a\n' > "${tmp_root}/figures/demo/main.png"
printf '\n\n## 7. Results\n\n![](figures/demo/main.png)\n' >> "${tmp_root}/research_contract.md"

# Enable Claim DAG gates in config; also disable pointer lint to keep the smoke test hermetic.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
cfg = json.loads(path.read_text(encoding="utf-8", errors="replace"))
cfg["profile"] = "methodology_dev"
cfg["features"] = cfg.get("features") or {}
cfg["features"]["pointer_lint_gate"] = False
cfg["features"]["packet_completeness_gate"] = False
cfg["features"]["claim_graph_gate"] = True
cfg["features"]["evidence_manifest_gate"] = True
cfg["features"]["claim_trajectory_link_gate"] = True
path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print("updated config:", path)
PY

echo "[setup] approve project_charter.md (required by project_charter_gate)"
python3 - "${tmp_root}/project_charter.md" <<'PY'
from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
today = date.today().isoformat()

text = re.sub(r"^Status:\s*DRAFT\b.*$", "Status: APPROVED", text, flags=re.MULTILINE)
text = re.sub(r"^Created:\s*.*$", f"Created: {today}", text, flags=re.MULTILINE)
text = re.sub(r"^Last updated:\s*.*$", f"Last updated: {today}", text, flags=re.MULTILINE)

# This smoke test forces the config profile to methodology_dev; the charter must match.
text = re.sub(r"^Declared profile:\s*.*$", "Declared profile: methodology_dev", text, flags=re.MULTILINE)

text = re.sub(
    r"^Primary goal:\s*.*$",
    "Primary goal: smoke — validate claim DAG gates while preserving reusable KB/methodology trace patterns",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): smoke — run deterministic claim/evidence gates on a minimal demo graph",
    text,
    flags=re.MULTILINE,
)

text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Do not treat passing a single gate as sufficient; preserve reusable patterns and evidence trails.",
    text,
    flags=re.MULTILINE,
)

# Replace the three template commitments with concrete demo links.
text = re.sub(
    r"^\s*-\s*\(fill; KB:.*$",
    "- KB: [demo lit](knowledge_base/literature/demo.md) — minimal literature note schema",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; Method:.*$",
    "- Method: [demo trace](knowledge_base/methodology_traces/M0/trace.md) — minimal methodology trace",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; Toolkit:.*$",
    "- Toolkit: knowledge_graph/*.jsonl contract + gate semantics (no code extraction in this smoke test)",
    text,
    flags=re.MULTILINE,
)

path.write_text(text, encoding="utf-8")
print("patched:", path)
PY

# Minimal evidence + claim + trajectory tag.
mkdir -p "${tmp_root}/knowledge_graph" "${tmp_root}/team"
cat > "${tmp_root}/knowledge_graph/evidence_manifest.jsonl" <<'JSONL'
{"id":"EVD-001","type":"artifact","path":"runs/demo/summary.json","created_at":"2026-01-14T00:00:00Z","description":"demo summary stats"}
JSONL
cat > "${tmp_root}/knowledge_graph/claims.jsonl" <<'JSONL'
{"id":"CLM-001","statement":"demo claim: Q1,Q2 are extracted deterministically from summary.json","profile":"mixed","status":"active","confidence":0.6,"dependencies":[],"supports_evidence":["EVD-001"],"contradicts_evidence":[],"kill_criteria":[{"id":"KC-001","condition":"summary.json missing required keys","threshold":"missing stats.q1 or stats.q2","action":"refute","checked":false,"last_check":null}],"linked_trajectories":["M0"],"owner":"leader","tags":["smoke"] ,"created_at":"2026-01-14T00:00:00Z","updated_at":"2026-01-14T00:00:00Z"}
JSONL
printf '\n' > "${tmp_root}/knowledge_graph/edges.jsonl"
cat > "${tmp_root}/team/trajectory_index.json" <<'JSON'
{"version":1,"runs":[{"tag":"M0","stage":"preflight_ok","updated_at":"2026-01-14T00:00:00Z","packet":null,"member_a":null,"member_b":null,"adjudication":null,"gate":"preflight_ok"}]}
JSON

echo "[test1] run_team_cycle preflight-only passes with claim gates enabled"
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0 \
  --notes "${tmp_root}/research_contract.md" \
  --out-dir "${tmp_root}/team" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --preflight-only \
  >/tmp/smoke_claim_dag_out.txt 2>&1

if ! grep -n "preflight-only" /tmp/smoke_claim_dag_out.txt >/dev/null 2>&1; then
  echo "[smoke][fail] expected preflight-only success message; got:" >&2
  sed -n '1,160p' /tmp/smoke_claim_dag_out.txt >&2
  exit 1
fi
echo "[smoke][ok] preflight-only passes"

echo "[test2] claim graph gate fails on unknown dependency"
cat > "${tmp_root}/knowledge_graph/claims.jsonl" <<'JSONL'
{"id":"CLM-001","statement":"demo claim with bad dependency","profile":"mixed","status":"active","confidence":0.6,"dependencies":["CLM-DOES-NOT-EXIST"],"supports_evidence":["EVD-001"],"contradicts_evidence":[],"kill_criteria":[{"id":"KC-001","condition":"demo","threshold":"demo","action":"refute","checked":false,"last_check":null}],"linked_trajectories":["M0"],"owner":"leader","tags":["smoke"] ,"created_at":"2026-01-14T00:00:00Z","updated_at":"2026-01-14T00:00:00Z"}
JSONL

set +e
python3 "${GATES_DIR}/check_claim_graph.py" --notes "${tmp_root}/research_contract.md" >/tmp/smoke_claim_dag_out2.txt 2>&1
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "[smoke][fail] expected non-zero exit for invalid claim graph" >&2
  cat /tmp/smoke_claim_dag_out2.txt >&2
  exit 1
fi
if ! grep -n "unknown dependency claim id" /tmp/smoke_claim_dag_out2.txt >/dev/null 2>&1; then
  echo "[smoke][fail] expected unknown dependency error; got:" >&2
  sed -n '1,160p' /tmp/smoke_claim_dag_out2.txt >&2
  exit 1
fi
echo "[smoke][ok] claim graph gate fails (fixable) as expected"

echo "[smoke][ok] all claim DAG smoke tests passed"
