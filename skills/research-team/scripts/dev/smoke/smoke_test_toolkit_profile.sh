#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

echo "[test1] scaffold with profile=toolkit_extraction"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeToolkit" --profile "toolkit_extraction"
if [[ ! -f "${tmp_root}/TOOLKIT_API.md" ]]; then
  echo "[fail] expected TOOLKIT_API.md to be scaffolded for profile=toolkit_extraction" >&2
  exit 1
fi

echo "[test2] generate demo milestone fills capsule + creates KB entries"
python3 "${BIN_DIR}/generate_demo_milestone.py" --root "${tmp_root}" --tag "M0-demo" >/tmp/smoke_toolkit_out1.txt 2>&1
if ! grep -nF "[ok] demo milestone generated" /tmp/smoke_toolkit_out1.txt >/dev/null 2>&1; then
  echo "[fail] expected demo generator success; got:" >&2
  sed -n '1,200p' /tmp/smoke_toolkit_out1.txt >&2
  exit 1
fi

echo "[setup] approve PROJECT_CHARTER.md (required by project_charter_gate)"
python3 - "${tmp_root}/PROJECT_CHARTER.md" <<'PY'
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

text = re.sub(
    r"^Primary goal:\s*.*$",
    "Primary goal: demo — toolkit_extraction profile must produce reusable API/module index + KB evidence (not validation-only)",
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
    "- Do not optimize for validation-only progress without extracting reusable toolkit components and KB evidence.",
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

echo "[test3] deterministic auto-fill RESEARCH_PLAN.md (removes template markers)"
python3 "${BIN_DIR}/auto_fill_research_plan.py" --root "${tmp_root}" --deterministic --force >/tmp/smoke_toolkit_out_plan.txt 2>&1
if ! grep -nF "[ok] auto-filled RESEARCH_PLAN.md (deterministic)" /tmp/smoke_toolkit_out_plan.txt >/dev/null 2>&1; then
  echo "[fail] expected deterministic auto-fill success; got:" >&2
  sed -n '1,200p' /tmp/smoke_toolkit_out_plan.txt >&2
  exit 1
fi

echo "[test3b] preflight-only fails when Toolkit delta is still placeholders"
set +e
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag "M0-demo" \
  --notes "${tmp_root}/Draft_Derivation.md" \
  --out-dir "${tmp_root}/team" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --preflight-only \
  >/tmp/smoke_toolkit_out_fail.txt 2>&1
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "[fail] expected preflight-only to FAIL before filling Toolkit delta; got:" >&2
  sed -n '1,220p' /tmp/smoke_toolkit_out_fail.txt >&2
  exit 1
fi
if ! grep -nF "Toolkit delta" /tmp/smoke_toolkit_out_fail.txt >/dev/null 2>&1; then
  echo "[warn] preflight failed as expected, but did not mention 'Toolkit delta' (output follows):" >&2
  sed -n '1,220p' /tmp/smoke_toolkit_out_fail.txt >&2
else
  echo "[ok] placeholder Toolkit delta correctly rejected"
fi

echo "[test4] fill Toolkit delta (required under toolkit_extraction)"
python3 - "${tmp_root}/RESEARCH_PLAN.md" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

plan = Path(sys.argv[1])
text = plan.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

# Replace the three placeholder bullets under M0 -> Toolkit delta with concrete entries.
pattern = re.compile(
    r"(^###\s+M0\b[\s\S]*?^\s*-\s*Toolkit delta\s*:\s*$\n)"
    r"(^\s{2}-\s*API spec\s*:[^\n]*\n)"
    r"(^\s{2}-\s*Code snippet index\s*:[^\n]*\n)"
    r"(^\s{2}-\s*KB evidence links\s*:[^\n]*\n)",
    flags=re.MULTILINE,
)

m = pattern.search(text)
if not m:
    raise SystemExit("ERROR: could not find M0 Toolkit delta placeholder block in RESEARCH_PLAN.md")

replacement = (
    m.group(1)
    + "  - API spec: [TOOLKIT_API.md](TOOLKIT_API.md) (demo stub; replace with real API)\n"
    + "  - Code snippet index: scripts/make_demo_artifacts.py (demo; replace with src/ or toolkit/)\n"
    + "  - KB evidence links: [demo_trace](knowledge_base/methodology_traces/demo_trace.md)\n"
)

text2 = pattern.sub(replacement, text, count=1)
plan.write_text(text2, encoding="utf-8")
print("patched:", plan)
PY

echo "[test5] preflight-only passes under toolkit_extraction after filling Toolkit delta"
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag "M0-demo" \
  --notes "${tmp_root}/Draft_Derivation.md" \
  --out-dir "${tmp_root}/team" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --preflight-only \
  >/tmp/smoke_toolkit_out2.txt 2>&1

if ! grep -nF "preflight-only" /tmp/smoke_toolkit_out2.txt >/dev/null 2>&1; then
  echo "[fail] expected preflight-only success message; got:" >&2
  sed -n '1,260p' /tmp/smoke_toolkit_out2.txt >&2
  exit 1
fi

echo "[ok] toolkit profile smoke tests passed"
