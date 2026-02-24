#!/usr/bin/env bash
set -euo pipefail

# Smoke test: project_stage=exploration downgrades selected preflight gates to warn-only
# (with debt recorded), while development remains fail-fast.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeTest"

mkdir -p "${tmp_root}/runs/exploration" "${tmp_root}/scripts"
cat > "${tmp_root}/runs/exploration/manifest.json" <<'JSON'
{"created_at":"2026-01-25T00:00:00Z","demo_value":1.0}
JSON
cat > "${tmp_root}/runs/exploration/notes.txt" <<'TXT'
ok
TXT
cat > "${tmp_root}/scripts/demo.py" <<'PY'
print("demo")
PY

write_capsule() {
  python3 - "${tmp_root}/Draft_Derivation.md" <<'PY'
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

- Milestone/tag: M0-stage
- Date: 2026-01-25
- Milestone kind: theory
- Min headline numbers: 0
- Min nontrivial headlines: 0

### A) Model, normalization, units, and truncation
- Starting equations / model variant: demo
- Normalization / units (explicit): demo
- Retained terms (LO/NLO etc.; write what is kept): demo
- Dropped terms / truncation (write what is discarded and why): demo

### B) Exact inputs (numbers + scheme/scale)
| Name | Value | Units/Normalization | Notes (scheme/scale) |
|---|---:|---|---|
| a | 1.0 | demo | demo |

### C) One-command reproduction (exact CLI)
```bash
python3 -c 'print("ok")'
```

### D) Expected outputs (paths) + provenance
- runs/exploration/manifest.json
- runs/exploration/notes.txt

### F) Environment (versions + source pointers)
- python: 3.11
- numpy: 1.26
- Source pointers:
  - scripts/demo.py (commit=0000000)

### G) Sweep semantics / parameter dependence (MANDATORY)
- Scanned variables: baseline (no scan)
- Dependent recomputations: none (baseline)
- Held-fixed constants: all other params fixed (baseline)

### H) Branch Semantics / Multi-root Contract (MANDATORY)
- Multi-root quantities: none
- Bands shown: no
""".strip()

out = text[:a] + "\n\n" + capsule + "\n\n" + text[b:]
path.write_text(out, encoding="utf-8")
print("[ok] wrote capsule:", path)
PY
}

write_capsule

set_stage() {
  local stage="$1"
  python3 - "${tmp_root}/research_team_config.json" "${stage}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
stage = sys.argv[2]
data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
data["project_stage"] = stage
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print("[ok] set project_stage=" + stage + ":", path)
PY
}

tag_expl="M0-stage-exploration"
set_stage "exploration"

set +e
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag "${tag_expl}" \
  --notes "${tmp_root}/Draft_Derivation.md" \
  --out-dir "${tmp_root}/team" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --preflight-only >"${tmp_root}/exploration_out.txt" 2>&1
code_expl=$?
set -e

if [[ ${code_expl} -ne 0 ]]; then
  echo "[smoke][fail] expected exploration preflight-only to exit 0; got ${code_expl}" >&2
  sed -n '1,200p' "${tmp_root}/exploration_out.txt" >&2
  exit 1
fi
if ! grep -nF "Project stage=exploration" "${tmp_root}/exploration_out.txt" >/dev/null 2>&1; then
  echo "[smoke][fail] expected exploration stage hint in output" >&2
  sed -n '1,160p' "${tmp_root}/exploration_out.txt" >&2
  exit 1
fi
if ! grep -nF "[warn] (exploration) notebook integrity check failed; continuing" "${tmp_root}/exploration_out.txt" >/dev/null 2>&1; then
  echo "[smoke][fail] expected notebook integrity gate to be warn-only in exploration" >&2
  sed -n '1,220p' "${tmp_root}/exploration_out.txt" >&2
  exit 1
fi
if ! grep -nF "[warn] (exploration) project charter check failed; continuing" "${tmp_root}/exploration_out.txt" >/dev/null 2>&1; then
  echo "[smoke][fail] expected charter gate to be warn-only in exploration" >&2
  sed -n '1,200p' "${tmp_root}/exploration_out.txt" >&2
  exit 1
fi

debt_md="${tmp_root}/team/runs/${tag_expl}/${tag_expl}_exploration_debt.md"
if [[ ! -f "${debt_md}" ]]; then
  echo "[smoke][fail] expected exploration debt file to exist: ${debt_md}" >&2
  find "${tmp_root}/team/runs/${tag_expl}" -maxdepth 1 -type f -print >&2 || true
  exit 1
fi
if ! grep -nF "project_charter_gate" "${debt_md}" >/dev/null 2>&1; then
  echo "[smoke][fail] expected debt file to mention project_charter_gate" >&2
  sed -n '1,120p' "${debt_md}" >&2
  exit 1
fi
echo "[smoke][ok] exploration warn-only + debt recorded"

tag_dev="M0-stage-development"
set_stage "development"

set +e
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag "${tag_dev}" \
  --notes "${tmp_root}/Draft_Derivation.md" \
  --out-dir "${tmp_root}/team" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --preflight-only >"${tmp_root}/development_out.txt" 2>&1
code_dev=$?
set -e

if [[ ${code_dev} -eq 0 ]]; then
  echo "[smoke][fail] expected development preflight-only to FAIL (project charter is still DRAFT); got exit 0" >&2
  sed -n '1,200p' "${tmp_root}/development_out.txt" >&2
  exit 1
fi
if ! grep -nF "exploration debt still open" "${tmp_root}/development_out.txt" >/dev/null 2>&1; then
  echo "[smoke][fail] expected development failure to be exploration debt gate" >&2
  sed -n '1,220p' "${tmp_root}/development_out.txt" >&2
  exit 1
fi
echo "[smoke][ok] development remains fail-fast"

exit 0
