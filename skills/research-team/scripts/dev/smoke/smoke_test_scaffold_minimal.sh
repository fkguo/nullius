#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SCAFFOLD="${SKILL_ROOT}/scripts/bin/scaffold_research_workflow.sh"
CHECK="${SKILL_ROOT}/scripts/dev/check_scaffold_output_contract.sh"
DEMO="${SKILL_ROOT}/scripts/bin/generate_demo_milestone.sh"
RUN_CYCLE="${SKILL_ROOT}/scripts/bin/run_team_cycle.sh"

if [[ ! -f "${SCAFFOLD}" || ! -f "${CHECK}" || ! -f "${DEMO}" || ! -f "${RUN_CYCLE}" ]]; then
  echo "ERROR: missing required scripts under: ${SKILL_ROOT}" >&2
  exit 2
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

echo "[smoke] tmp_root=${tmp_root}"

proj="${tmp_root}/proj"
bash "${SCAFFOLD}" --root "${proj}" --project "SmokeProject" --profile "mixed" --minimal
bash "${CHECK}" --root "${proj}" --variant minimal

# Fill Capsule + generate minimal deterministic artifacts so preflight-only can pass.
bash "${DEMO}" --root "${proj}" --tag "R0-demo" --force >/dev/null

echo "[setup] approve PROJECT_CHARTER.md (required by project_charter_gate)"
python3 - "${proj}/PROJECT_CHARTER.md" <<'PY'
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
text = re.sub(r"^Declared profile:\s*.*$", "Declared profile: mixed", text, flags=re.MULTILINE)

text = re.sub(
    r"^Primary goal:\s*.*$",
    "Primary goal: smoke — ensure minimal scaffold can run deterministic preflight-only team cycle",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): smoke — run_team_cycle preflight-only passes after demo milestone fill",
    text,
    flags=re.MULTILINE,
)

text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Do not regress the ability to run preflight-only in a minimal scaffold (no wrappers, no draft prompts).",
    text,
    flags=re.MULTILINE,
)

text = re.sub(
    r"^\s*-\s*\(fill; KB:.*$",
    "- KB: [Bezanson2017](knowledge_base/literature/bezanson2017_julia.md) — demo literature note",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; Method:.*$",
    "- Method: [demo_trace](knowledge_base/methodology_traces/demo_trace.md) — demo methodology trace",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; Toolkit:.*$",
    "- Toolkit: minimal scaffold + preflight-only team cycle (smoke target)",
    text,
    flags=re.MULTILINE,
)

path.write_text(text, encoding="utf-8")
print("patched:", path)
PY

bash "${RUN_CYCLE}" \
  --tag "R0-demo" \
  --notes "${proj}/Draft_Derivation.md" \
  --out-dir "${proj}/team" \
  --member-a-system "${proj}/prompts/_system_member_a.txt" \
  --member-b-system "${proj}/prompts/_system_member_b.txt" \
  --preflight-only >/dev/null

echo "[ok] minimal scaffold smoke test passed"
