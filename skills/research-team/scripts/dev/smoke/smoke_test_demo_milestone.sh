#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeDemo" --full

echo "[test1] generate demo milestone fills capsule + creates artifacts"
python3 "${BIN_DIR}/generate_demo_milestone.py" --root "${tmp_root}" --tag M0-demo >/tmp/smoke_demo_out1.txt 2>&1
if ! grep -nF "[ok] demo milestone generated" /tmp/smoke_demo_out1.txt >/dev/null 2>&1; then
  echo "[fail] expected demo generator success; got:" >&2
  sed -n '1,200p' /tmp/smoke_demo_out1.txt >&2
  exit 1
fi

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

# No --profile was passed to scaffold; the effective profile is derived from mode (theory_numerics -> mixed).
text = re.sub(r"^Declared profile:\s*.*$", "Declared profile: mixed", text, flags=re.MULTILINE)

text = re.sub(
    r"^Primary goal:\s*.*$",
    "Primary goal: demo — enforce goal hierarchy + reusable deltas (KB/toolkit), not validation-only progress",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): demo — reproduce deterministic artifact outputs for tag M0-demo (validation only)",
    text,
    flags=re.MULTILINE,
)

text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Do not optimize for validation-only progress without adding reusable KB/toolkit deltas.",
    text,
    flags=re.MULTILINE,
)

# Replace the three template commitments with concrete demo links.
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
    "- Toolkit: scripts/make_demo_artifacts.py — demo reusable artifact generator entrypoint",
    text,
    flags=re.MULTILINE,
)

path.write_text(text, encoding="utf-8")
print("patched:", path)
PY

echo "[test2] run_team_cycle preflight-only passes after demo bootstrap"
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0-demo \
  --notes "${tmp_root}/research_contract.md" \
  --out-dir "${tmp_root}/team" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --preflight-only \
  >/tmp/smoke_demo_out2.txt 2>&1

if ! grep -nF "preflight-only" /tmp/smoke_demo_out2.txt >/dev/null 2>&1; then
  echo "[fail] expected preflight-only success message; got:" >&2
  sed -n '1,220p' /tmp/smoke_demo_out2.txt >&2
  exit 1
fi

echo "[ok] demo milestone smoke tests passed"
