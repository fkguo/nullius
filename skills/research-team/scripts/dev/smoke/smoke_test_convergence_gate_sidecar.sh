#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

gen_log="${tmp_root}/smoke_conv_gate_gen.txt"
log_on="${tmp_root}/smoke_conv_gate_on.txt"
log_off="${tmp_root}/smoke_conv_gate_off.txt"
log_cfg_timeout="${tmp_root}/smoke_conv_gate_cfg_timeout.txt"
log_sidecar_fail="${tmp_root}/smoke_conv_gate_sidecar_fail.txt"
log_timeout_missing="${tmp_root}/smoke_sidecar_timeout_missing.txt"
log_timeout_invalid="${tmp_root}/smoke_sidecar_timeout_invalid.txt"

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeConvergenceGate"
python3 "${BIN_DIR}/generate_demo_milestone.py" --root "${tmp_root}" --tag M0-demo >"${gen_log}" 2>&1

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

# No --profile was passed to scaffold; the effective profile is derived from mode (theory_numerics -> mixed).
text = re.sub(r"^Declared profile:\s*.*$", "Declared profile: mixed", text, flags=re.MULTILINE)

text = re.sub(
    r"^Primary goal:\s*.*$",
    "Primary goal: smoke — ensure convergence gate runs even with sidecar enabled/timeout",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): smoke — deterministic run_team_cycle convergence gate behavior",
    text,
    flags=re.MULTILINE,
)

text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Do not allow sidecar behavior to block convergence gate execution.",
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
    "- Toolkit: run_team_cycle sidecar isolation + convergence gate logging (smoke target)",
    text,
    flags=re.MULTILINE,
)

path.write_text(text, encoding="utf-8")
print("patched:", path)
PY

cat >"${tmp_root}/scripts/dummy_team_runner.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# Dummy runner for smoke tests.
#
# NOTE: Include this literal string so run_team_cycle's sidecar fail-fast logic can detect support:
#   --max-retries

OUT=""
MODEL=""
SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUTPUT_FORMAT="text"
MAX_RETRIES="0"
SLEEP_SECS="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --output-format) OUTPUT_FORMAT="$2"; shift 2;;
    --max-retries) MAX_RETRIES="$2"; shift 2;;
    --sleep-secs) SLEEP_SECS="$2"; shift 2;;
    *) shift;;
  esac
done

if [[ -z "${OUT}" ]]; then
  echo "dummy runner: missing --out" >&2
  exit 2
fi

# Make sidecar run long enough to trigger the (warn-only) timeout path.
if [[ "${OUT}" == *"_member_c.md" ]]; then
  if [[ "${DUMMY_SIDECAR_FAIL:-}" == "1" ]]; then
    echo "dummy runner: sidecar forced failure (out=${OUT})" >&2
    exit 3
  fi
  echo "dummy runner: sidecar forced slow run (out=${OUT})" >&2
  sleep 5
  exit 0
fi

mkdir -p "$(dirname "${OUT}")"
{
  echo "# Dummy team report"
  echo
  echo "## Reproduction Summary"
  echo
  echo "| Check | Result | Notes |"
  echo "|---|---|---|"
  echo "| Derivation replication | pass | ok |"
  echo "| Computation replication | pass | ok |"
  echo
  echo "## Derivation Replication"
  echo "Comparison: match"
  echo
  echo "## Computation Replication"
  echo "Comparison: match"
  echo
  echo "## Sweep Semantics / Parameter Dependence"
  echo "Consistency verdict: pass"
  echo
  echo "Verdict: ready for next milestone"
} >"${OUT}"
EOF
chmod +x "${tmp_root}/scripts/dummy_team_runner.sh"

python3 - <<PY
import json
from pathlib import Path

cfg_path = Path("${tmp_root}") / "research_team_config.json"
cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
cfg["review_access_mode"] = "packet_only"
sc = cfg.get("sidecar_review") if isinstance(cfg.get("sidecar_review"), dict) else {}
sc["enabled"] = True
sc["runner"] = "claude"
sc["model"] = "sonnet-4.5"
sc["system_prompt"] = "prompts/_system_member_c_numerics.txt"
sc["output_format"] = "text"
sc["tag_suffix"] = "member_c"
# Keep config timeout disabled so the CLI override path is exercised.
sc["timeout_secs"] = 0
cfg["sidecar_review"] = sc
cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
PY

echo "[test1] full cycle with sidecar forced on reaches convergence gate"
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0-demo \
  --notes "${tmp_root}/Draft_Derivation.md" \
  --out-dir "${tmp_root}/team_sidecar_on" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --member-a-runner "${tmp_root}/scripts/dummy_team_runner.sh" \
  --member-b-runner "${tmp_root}/scripts/dummy_team_runner.sh" \
  --sidecar \
  --sidecar-timeout 1 \
  >"${log_on}" 2>&1

if ! grep -nF "[gate] running convergence gate:" "${log_on}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log; got:" >&2
  sed -n '1,220p' "${log_on}" >&2
  exit 1
fi
if ! grep -nF "sidecar timeout after 1s" "${log_on}" >/dev/null 2>&1; then
  echo "[fail] expected sidecar timeout warning; got:" >&2
  sed -n '1,220p' "${log_on}" >&2
  exit 1
fi

python3 - <<PY
import json
from pathlib import Path

p = Path("${tmp_root}") / "team_sidecar_on" / "trajectory_index.json"
obj = json.loads(p.read_text(encoding="utf-8"))
found = any(r.get("tag") == "M0-demo" and r.get("stage") == "converged" for r in obj.get("runs", []))
if not found:
  raise SystemExit(f"missing converged stage for M0-demo in {p}")
PY

echo "[test2] full cycle with --no-sidecar reaches convergence gate"
bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0-demo \
  --notes "${tmp_root}/Draft_Derivation.md" \
  --out-dir "${tmp_root}/team_sidecar_off" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --member-a-runner "${tmp_root}/scripts/dummy_team_runner.sh" \
  --member-b-runner "${tmp_root}/scripts/dummy_team_runner.sh" \
  --no-sidecar \
  >"${log_off}" 2>&1

if ! grep -nF "[gate] running convergence gate:" "${log_off}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log; got:" >&2
  sed -n '1,220p' "${log_off}" >&2
  exit 1
fi

python3 - <<PY
import json
from pathlib import Path

p = Path("${tmp_root}") / "team_sidecar_off" / "trajectory_index.json"
obj = json.loads(p.read_text(encoding="utf-8"))
found = any(r.get("tag") == "M0-demo" and r.get("stage") == "converged" for r in obj.get("runs", []))
if not found:
  raise SystemExit(f"missing converged stage for M0-demo in {p}")
PY

echo "[test2b] full cycle with config timeout reaches convergence gate"
python3 - <<PY
import json
from pathlib import Path

cfg_path = Path("${tmp_root}") / "research_team_config.json"
cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
sc = cfg.get("sidecar_review") if isinstance(cfg.get("sidecar_review"), dict) else {}
sc["timeout_secs"] = 1
cfg["sidecar_review"] = sc
cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
PY

bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0-demo \
  --notes "${tmp_root}/Draft_Derivation.md" \
  --out-dir "${tmp_root}/team_sidecar_cfg_timeout" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --member-a-runner "${tmp_root}/scripts/dummy_team_runner.sh" \
  --member-b-runner "${tmp_root}/scripts/dummy_team_runner.sh" \
  --sidecar \
  >"${log_cfg_timeout}" 2>&1

if ! grep -nF "[gate] running convergence gate:" "${log_cfg_timeout}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log; got:" >&2
  sed -n '1,220p' "${log_cfg_timeout}" >&2
  exit 1
fi
if ! grep -nF "sidecar timeout after 1s" "${log_cfg_timeout}" >/dev/null 2>&1; then
  echo "[fail] expected sidecar config-timeout warning; got:" >&2
  sed -n '1,220p' "${log_cfg_timeout}" >&2
  exit 1
fi

python3 - <<PY
import json
from pathlib import Path

p = Path("${tmp_root}") / "team_sidecar_cfg_timeout" / "trajectory_index.json"
obj = json.loads(p.read_text(encoding="utf-8"))
found = any(r.get("tag") == "M0-demo" and r.get("stage") == "converged" for r in obj.get("runs", []))
if not found:
  raise SystemExit(f"missing converged stage for M0-demo in {p}")
PY

python3 - <<PY
import json
from pathlib import Path

cfg_path = Path("${tmp_root}") / "research_team_config.json"
cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
sc = cfg.get("sidecar_review") if isinstance(cfg.get("sidecar_review"), dict) else {}
sc["timeout_secs"] = 0
cfg["sidecar_review"] = sc
cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
PY

echo "[test2c] full cycle with sidecar failure remains non-blocking"
set +e
DUMMY_SIDECAR_FAIL=1 bash "${BIN_DIR}/run_team_cycle.sh" \
  --tag M0-demo \
  --notes "${tmp_root}/Draft_Derivation.md" \
  --out-dir "${tmp_root}/team_sidecar_fail" \
  --member-a-system "${tmp_root}/prompts/_system_member_a.txt" \
  --member-b-system "${tmp_root}/prompts/_system_member_b.txt" \
  --member-a-runner "${tmp_root}/scripts/dummy_team_runner.sh" \
  --member-b-runner "${tmp_root}/scripts/dummy_team_runner.sh" \
  --sidecar \
  >"${log_sidecar_fail}" 2>&1
rc_sidecar_fail=$?
set -e
if [[ ${rc_sidecar_fail} -ne 0 ]]; then
  echo "[fail] expected main exit code 0 despite sidecar failure; got ${rc_sidecar_fail}" >&2
  sed -n '1,260p' "${log_sidecar_fail}" >&2
  exit 1
fi

if ! grep -nF "[member-c] tag=" "${log_sidecar_fail}" >/dev/null 2>&1; then
  echo "[fail] expected sidecar to start ([member-c] log missing); got:" >&2
  sed -n '1,260p' "${log_sidecar_fail}" >&2
  exit 1
fi
if ! grep -nF "dummy runner: sidecar forced failure" "${log_sidecar_fail}" >/dev/null 2>&1; then
  echo "[fail] expected dummy sidecar failure marker; got:" >&2
  sed -n '1,260p' "${log_sidecar_fail}" >&2
  exit 1
fi
if ! grep -nF "[gate] running convergence gate:" "${log_sidecar_fail}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log; got:" >&2
  sed -n '1,220p' "${log_sidecar_fail}" >&2
  exit 1
fi
if ! grep -nF "[warn] sidecar attempt failed" "${log_sidecar_fail}" >/dev/null 2>&1; then
  echo "[fail] expected sidecar attempt failure warning; got:" >&2
  sed -n '1,260p' "${log_sidecar_fail}" >&2
  exit 1
fi

python3 - <<PY
import json
from pathlib import Path

p = Path("${tmp_root}") / "team_sidecar_fail" / "trajectory_index.json"
obj = json.loads(p.read_text(encoding="utf-8"))
found = any(r.get("tag") == "M0-demo" and r.get("stage") == "converged" for r in obj.get("runs", []))
if not found:
  raise SystemExit(f"missing converged stage for M0-demo in {p}")
PY

echo "[test3] --sidecar-timeout missing value fails fast"
set +e
bash "${BIN_DIR}/run_team_cycle.sh" --sidecar-timeout >"${log_timeout_missing}" 2>&1
code_missing=$?
set -e
if [[ ${code_missing} -ne 2 ]]; then
  echo "[fail] expected exit code 2 for missing --sidecar-timeout value; got ${code_missing}" >&2
  sed -n '1,120p' "${log_timeout_missing}" >&2
  exit 1
fi

echo "[test4] --sidecar-timeout invalid value fails fast"
set +e
bash "${BIN_DIR}/run_team_cycle.sh" --sidecar-timeout abc >"${log_timeout_invalid}" 2>&1
code_invalid=$?
set -e
if [[ ${code_invalid} -ne 2 ]]; then
  echo "[fail] expected exit code 2 for invalid --sidecar-timeout value; got ${code_invalid}" >&2
  sed -n '1,120p' "${log_timeout_invalid}" >&2
  exit 1
fi

echo "[ok] convergence gate + sidecar smoke tests passed"
