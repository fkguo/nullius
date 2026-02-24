#!/usr/bin/env bash
set -euo pipefail

# Smoke test: project_stage=exploration enables a minimal Capsule gate
# while default stage=development remains strict.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
CAPSULE_GATE="${SKILL_ROOT}/scripts/gates/check_reproducibility_capsule.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeTest"

# Switch to exploration stage.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
data["project_stage"] = "exploration"
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print("[ok] set project_stage=exploration:", path)
PY

# Fill a minimal capsule (no headline numbers, no figures). Requires:
# - C) reproduction command exists
# - D) at least one output path exists on disk
# - A/B/G/H basic structure
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

- Milestone/tag: M0-exploration
- Date: 2026-01-24

### A) Model, normalization, units, and truncation
- Starting equations / model variant: (exploration) demo
- Normalization / units (explicit): (exploration) demo
- Retained terms (LO/NLO etc.; write what is kept): (exploration) demo
- Dropped terms / truncation (write what is discarded and why): (exploration) demo

### B) Exact inputs (numbers + scheme/scale)
| Name | Value | Units/Normalization | Notes (scheme/scale) |
|---|---:|---|---|
| a | 1.0 | demo | exploration |

### C) One-command reproduction (exact CLI)
```bash
python3 -c 'print(\"exploration\")'
```

### D) Expected outputs (paths) + provenance
- runs/exploration/manifest.json

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
print("[ok] wrote minimal capsule:", path)
PY

mkdir -p "${tmp_root}/runs/exploration"
cat > "${tmp_root}/runs/exploration/manifest.json" <<'JSON'
{"created_at":"2026-01-24T00:00:00Z","command":"python3 -c 'print(\"exploration\")'","outputs":["runs/exploration/manifest.json"]}
JSON

set +e
python3 "${CAPSULE_GATE}" --notes "${tmp_root}/Draft_Derivation.md" >"${tmp_root}/capsule_exploration_out.txt" 2>&1
code=$?
set -e

if [[ $code -ne 0 ]]; then
  echo "[smoke][fail] expected exploration minimal capsule to PASS; got exit=${code}" >&2
  sed -n '1,200p' "${tmp_root}/capsule_exploration_out.txt" >&2
  exit 1
fi
if ! grep -nF "Project stage=exploration" "${tmp_root}/capsule_exploration_out.txt" >/dev/null 2>&1; then
  echo "[smoke][fail] expected exploration stage hint in output; got:" >&2
  sed -n '1,120p' "${tmp_root}/capsule_exploration_out.txt" >&2
  exit 1
fi
echo "[smoke][ok] exploration minimal capsule PASS"

# Switch back to default strict development stage; the same capsule should FAIL.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
data["project_stage"] = "development"
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print("[ok] set project_stage=development:", path)
PY

set +e
python3 "${CAPSULE_GATE}" --notes "${tmp_root}/Draft_Derivation.md" >"${tmp_root}/capsule_development_out.txt" 2>&1
code2=$?
set -e

if [[ $code2 -eq 0 ]]; then
  echo "[smoke][fail] expected development stage to FAIL for minimal capsule; got exit=0" >&2
  sed -n '1,200p' "${tmp_root}/capsule_development_out.txt" >&2
  exit 1
fi
if ! grep -nF "Need at least" "${tmp_root}/capsule_development_out.txt" >/dev/null 2>&1; then
  echo "[smoke][fail] expected a strictness error message in development output; got:" >&2
  sed -n '1,200p' "${tmp_root}/capsule_development_out.txt" >&2
  exit 1
fi
echo "[smoke][ok] development strict capsule FAIL"

exit 0
