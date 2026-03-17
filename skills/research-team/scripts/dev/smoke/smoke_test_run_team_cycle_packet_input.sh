#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

tag="M0-demo"

echo "[setup] scaffold + demo milestone"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokePacketInput" --profile "mixed" >/dev/null 2>&1
bash "${BIN_DIR}/generate_demo_milestone.sh" --root "${tmp_root}" --tag "${tag}" >/dev/null 2>&1

echo "[setup] focus the smoke on packet input + explicit hep-provider gating"
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    "mode": "generic",
    "features": {
        "hep_workspace_gate": False,
        "project_charter_gate": False,
        "project_map_gate": True,
    },
}
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print("wrote:", path)
PY

mkdir -p "${tmp_root}/prompts"
printf '%s\n' "System prompt A (smoke)." > "${tmp_root}/prompts/_system_member_a.txt"
printf '%s\n' "System prompt B (smoke)." > "${tmp_root}/prompts/_system_member_b.txt"

echo "[setup] build a packet (intentionally with wrong Tag line to exercise patcher)"
src_packet="${tmp_root}/team_packet_src.txt"
python3 "${BIN_DIR}/build_team_packet.py" --tag "${tag}" --notes "${tmp_root}/research_contract.md" --out "${src_packet}" >/dev/null 2>&1

python3 - "${src_packet}" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
text = re.sub(r"^Tag:\s*.*$", "Tag: WRONG-TAG", text, flags=re.MULTILINE)
text = re.sub(r"^-\s+Round/tag:\s*.*$", "- Round/tag: WRONG-TAG", text, flags=re.MULTILINE)
p.write_text(text, encoding="utf-8")
PY

echo "[test] run_team_cycle using --packet (no --notes) reaches preflight-only success"
out_dir="${tmp_root}/team_packet_input"
set +e
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag "${tag}" \
  --packet "${src_packet}" \
  --out-dir "${out_dir}" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --preflight-only \
  >"${tmp_root}/run.log" 2>&1
code=$?
set -e
if [[ ${code} -ne 0 ]]; then
  echo "[fail] expected preflight-only success; got exit=${code} and log:" >&2
  sed -n '1,240p' "${tmp_root}/run.log" >&2 || true
  exit 1
fi

if ! grep -nF "preflight-only" "${tmp_root}/run.log" >/dev/null 2>&1; then
  echo "[fail] expected preflight-only success message; got:" >&2
  sed -n '1,240p' "${tmp_root}/run.log" >&2 || true
  exit 1
fi

patched="${out_dir}/runs/${tag}/team_packet_${tag}.txt"
if [[ ! -f "${patched}" ]]; then
  echo "[fail] expected patched packet file: ${patched}" >&2
  exit 1
fi

python3 - "${patched}" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8", errors="replace")
if not re.search(r"^Tag:\s*M0-demo\s*$", text, flags=re.MULTILINE):
    lines = text.splitlines()
    tag_lines = [ln for ln in lines if "Tag:" in ln][:5]
    debug = "\n".join(repr(ln) for ln in tag_lines) or "(no Tag: line found)"
    head = "\n".join(lines[:40])
    raise AssertionError("Tag line not patched to M0-demo.\nTag-line reprs:\n" + debug + "\n\nPacket head:\n" + head)
if not re.search(r"^-\s+Round/tag:\s*M0-demo\s*$", text, flags=re.MULTILINE):
    raise AssertionError("Round/tag line not patched to M0-demo")
print("[ok] packet input + patcher behavior ok")
PY

echo "[ok] run_team_cycle --packet smoke test passed"

echo "[test] explicit hep provider opt-in should fail-fast when .hep/workspace.json is missing"
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    "mode": "generic",
    "features": {
        "hep_workspace_gate": True,
    },
}
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
set +e
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag "M0-demo-missing-hep" \
  --packet "${src_packet}" \
  --out-dir "${out_dir}" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --preflight-only \
  >"${tmp_root}/run_missing_hep.log" 2>&1
code2=$?
set -e
if [[ ${code2} -eq 0 ]]; then
  echo "[fail] expected hep workspace gate failure; got exit=0 and log:" >&2
  sed -n '1,240p' "${tmp_root}/run_missing_hep.log" >&2 || true
  exit 1
fi
if ! grep -nF "missing hep workspace file" "${tmp_root}/run_missing_hep.log" >/dev/null 2>&1; then
  echo "[fail] expected missing hep workspace diagnostic in log; got:" >&2
  sed -n '1,260p' "${tmp_root}/run_missing_hep.log" >&2 || true
  exit 1
fi
echo "[ok] explicit hep provider gate fail-fast behavior ok"
