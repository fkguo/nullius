#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp1="$(mktemp -d)"
tmp2="$(mktemp -d)"
tmp3="$(mktemp -d)"
tmp4="$(mktemp -d)"
cleanup() { rm -rf "${tmp1}" "${tmp2}" "${tmp3}" "${tmp4}"; }
trap cleanup EXIT

echo "[smoke] tmp1=${tmp1}"
echo "[smoke] tmp2=${tmp2}"
echo "[smoke] tmp3=${tmp3}"
echo "[smoke] tmp4=${tmp4}"

echo "[test1] deterministic plan is profile-aware: toolkit_extraction includes toolkit framing + KB expansion"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp1}" --project "SmokePlanToolkit" --profile "toolkit_extraction" >/dev/null 2>&1
python3 "${BIN_DIR}/auto_fill_research_plan.py" --root "${tmp1}" --deterministic --force >/dev/null 2>&1
if ! grep -nF "Toolkit framing" "${tmp1}/research_plan.md" >/dev/null 2>&1; then
  echo "[fail] expected toolkit_extraction Task Board to include 'Toolkit framing'; got:" >&2
  sed -n '1,220p' "${tmp1}/research_plan.md" >&2 || true
  exit 1
fi
if ! grep -nF "literature_queries.md" "${tmp1}/research_plan.md" >/dev/null 2>&1; then
  echo "[fail] expected Task Board to include literature_queries.md link (KB expansion); got:" >&2
  sed -n '1,220p' "${tmp1}/research_plan.md" >&2 || true
  exit 1
fi
echo "[ok] toolkit_extraction plan ok"

echo "[test2] deterministic plan includes KB expansion even in theory_only"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp2}" --project "SmokePlanTheory" --profile "theory_only" >/dev/null 2>&1
python3 "${BIN_DIR}/auto_fill_research_plan.py" --root "${tmp2}" --deterministic --force >/dev/null 2>&1
if ! grep -nF "Milestone kind: theory" "${tmp2}/research_plan.md" >/dev/null 2>&1; then
  echo "[fail] expected theory_only Task Board to mention 'Milestone kind: theory'; got:" >&2
  sed -n '1,220p' "${tmp2}/research_plan.md" >&2 || true
  exit 1
fi
if ! grep -nF "literature_queries.md" "${tmp2}/research_plan.md" >/dev/null 2>&1; then
  echo "[fail] expected Task Board to include literature_queries.md link (KB expansion); got:" >&2
  sed -n '1,220p' "${tmp2}/research_plan.md" >&2 || true
  exit 1
fi
echo "[ok] theory_only plan ok"

echo "[test3] autopilot fallback Task Board injection is profile-aware (toolkit_extraction)"
cat > "${tmp3}/research_team_config.json" <<'EOF'
{"version": 1, "mode": "theory_numerics", "profile": "toolkit_extraction"}
EOF
cat > "${tmp3}/research_plan.md" <<'EOF'
# research_plan.md

Project: SmokeFallback

## Progress Log

- 2026-01-01 tag= status= task= note=
EOF
python3 - "${tmp3}/research_plan.md" "${BIN_DIR}" <<'PY'
import sys
from pathlib import Path

bin_dir = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(bin_dir))
import autopilot_loop  # type: ignore

plan_path = Path(sys.argv[1])
autopilot_loop._ensure_task_board(plan_path)  # type: ignore
PY
if ! grep -nF "Toolkit framing" "${tmp3}/research_plan.md" >/dev/null 2>&1; then
  echo "[fail] expected injected Task Board to be toolkit_extraction-aware; got:" >&2
  sed -n '1,220p' "${tmp3}/research_plan.md" >&2 || true
  exit 1
fi
echo "[ok] autopilot fallback injection ok"

echo "[test4] team packet includes mode/profile summary and profile-aware reviewer focus"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp4}" --project "SmokePacket" --profile "methodology_dev" >/dev/null 2>&1
python3 "${BIN_DIR}/generate_demo_milestone.py" --root "${tmp4}" --tag "M0-demo" >/dev/null 2>&1
python3 "${BIN_DIR}/build_team_packet.py" --tag "M0-demo" --notes "${tmp4}/research_contract.md" --out "${tmp4}/prompts/team_packet_M0-demo.txt" >/dev/null 2>&1
if ! grep -nF "Project mode/profile" "${tmp4}/prompts/team_packet_M0-demo.txt" >/dev/null 2>&1; then
  echo "[fail] expected team packet to include mode/profile section; got:" >&2
  sed -n '1,220p' "${tmp4}/prompts/team_packet_M0-demo.txt" >&2 || true
  exit 1
fi
if ! grep -nF "Profile: methodology_dev" "${tmp4}/prompts/team_packet_M0-demo.txt" >/dev/null 2>&1; then
  echo "[fail] expected team packet to include 'Profile: methodology_dev'; got:" >&2
  sed -n '1,220p' "${tmp4}/prompts/team_packet_M0-demo.txt" >&2 || true
  exit 1
fi
if ! grep -nF "Methodology development:" "${tmp4}/prompts/team_packet_M0-demo.txt" >/dev/null 2>&1; then
  echo "[fail] expected methodology_dev reviewer focus line in packet; got:" >&2
  sed -n '1,220p' "${tmp4}/prompts/team_packet_M0-demo.txt" >&2 || true
  exit 1
fi
echo "[ok] team packet mode/profile ok"

echo "[ok] profile-aware planning + packet smoke tests passed"
