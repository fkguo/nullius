#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
LEGACY_RUN="${SKILL_ROOT}/scripts/run_team_cycle.sh"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

tag="M3-r1"

echo "[setup] scaffold + demo milestone"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeRunTeamCycle" --profile "mixed" >/dev/null 2>&1
bash "${BIN_DIR}/generate_demo_milestone.sh" --root "${tmp_root}" --tag "${tag}" >/dev/null 2>&1

echo "[setup] relax non-essential gates for deterministic smoke test"
python3 - <<PY
import json
from pathlib import Path

p = Path("${tmp_root}") / "research_team_config.json"
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d["review_access_mode"] = "packet_only"

d.setdefault("features", {})
for k in (
    "agents_anchor_gate",
    "notebook_integrity_gate",
    "research_plan_gate",
    "milestone_dod_gate",
    "packet_completeness_gate",
    "problem_framing_snapshot_gate",
    "knowledge_layers_gate",
    "references_gate",
):
    d["features"][k] = False
d["features"]["trajectory_index"] = True

d["plan_tracking"] = {
    "enabled": False,
    "require_task_board": False,
    "require_progress_log": False,
    "log_on_fail": False,
}

sc = d.get("sidecar_review", {}) if isinstance(d.get("sidecar_review", {}), dict) else {}
sc["enabled"] = True
sc.setdefault("runner", "claude")
sc.setdefault("tag_suffix", "member_c")
sc.setdefault("timeout_secs", 5)
d["sidecar_review"] = sc

p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

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
    "Primary goal: smoke — ensure run_team_cycle reaches convergence gate and updates trajectory deterministically",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): smoke — pass convergence gate based on stub member reports",
    text,
    flags=re.MULTILINE,
)

text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Do not regress convergence gate execution even when optional sidecar fails.",
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
    "- Toolkit: trajectory index + convergence gate invariants (smoke target)",
    text,
    flags=re.MULTILINE,
)

path.write_text(text, encoding="utf-8")
print("patched:", path)
PY

cat >"${tmp_root}/stub_member_a.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model|--system-prompt-file|--prompt-file|--tools|--max-retries|--sleep-secs) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub_member_a: missing --out" >&2
  exit 2
fi

if [[ "${RESEARCH_TEAM_STUB_FAIL_SIDECAR:-0}" == "1" && "${out}" == *member_c* ]]; then
  echo "stub_member_a: intentional sidecar failure (${out})" >&2
  exit 7
fi

cat >"${out}" <<'MD'
# Member A Report

| Check | Result |
|---|---|
| Derivation replication | pass |
| Computation replication | pass |

## Derivation Replication
Comparison: match

## Computation Replication
Comparison: match

## Sweep Semantics / Parameter Dependence
Consistency verdict: pass

## Verdict

Verdict: ready for next milestone
MD
exit 0
SH
chmod +x "${tmp_root}/stub_member_a.sh"

cat >"${tmp_root}/stub_member_b.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model|--output-format|--prompt-file|--system-prompt-file) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub_member_b: missing --out" >&2
  exit 2
fi

cat >"${out}" <<'MD'
# Member B Report

| Check | Result |
|---|---|
| Derivation replication | pass |
| Computation replication | pass |

## Derivation Replication
Comparison: match

## Computation Replication
Comparison: match

## Sweep Semantics / Parameter Dependence
Consistency verdict: pass

## Verdict

Verdict: ready for next milestone
MD
exit 0
SH
chmod +x "${tmp_root}/stub_member_b.sh"

check_trajectory_converged() {
  local traj="$1"
  python3 - <<PY
import json
from pathlib import Path

p = Path("${traj}")
obj = json.loads(p.read_text(encoding="utf-8", errors="replace"))
stages = [e.get("stage") for e in obj.get("runs", [])]
assert "member_reports" in stages, f"missing member_reports in {stages}"
assert "converged" in stages, f"missing converged in {stages}"
PY
}

echo "[test0] legacy wrapper path should reach convergence gate + trajectory=converged"
if [[ ! -x "${LEGACY_RUN}" ]]; then
  echo "[fail] legacy wrapper missing/not executable: ${LEGACY_RUN}" >&2
  exit 1
fi
log0="${tmp_root}/run_legacy_wrapper.log"
(
  cd "${tmp_root}"
  bash "${LEGACY_RUN}" \
    --tag "${tag}" \
    --notes Draft_Derivation.md \
    --out-dir team_legacy_wrapper \
    --member-a-system prompts/_system_member_a.txt \
    --member-b-system prompts/_system_member_b.txt \
    --member-a-runner "${tmp_root}/stub_member_a.sh" \
    --member-b-runner "${tmp_root}/stub_member_b.sh" \
    --member-b-runner-kind claude \
    --no-sidecar
) >"${log0}" 2>&1

if ! grep -nF "[gate] running convergence gate" "${log0}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log in ${log0}; got:" >&2
  sed -n '1,240p' "${log0}" >&2 || true
  exit 1
fi
check_trajectory_converged "${tmp_root}/team_legacy_wrapper/trajectory_index.json"
python3 "${SKILL_ROOT}/scripts/check_team_convergence.py" \
  --member-a "${tmp_root}/team_legacy_wrapper/runs/${tag}/${tag}_member_a.md" \
  --member-b "${tmp_root}/team_legacy_wrapper/runs/${tag}/${tag}_member_b.md" \
  >/dev/null 2>&1

echo "[test1] sidecar OFF should still reach convergence gate + trajectory=converged"
log1="${tmp_root}/run_no_sidecar.log"
(
  cd "${tmp_root}"
  bash "${BIN_DIR}/run_team_cycle.sh" \
    --tag "${tag}" \
    --notes Draft_Derivation.md \
    --out-dir team_no_sidecar \
    --member-a-system prompts/_system_member_a.txt \
    --member-b-system prompts/_system_member_b.txt \
    --member-a-runner "${tmp_root}/stub_member_a.sh" \
    --member-b-runner "${tmp_root}/stub_member_b.sh" \
    --member-b-runner-kind claude \
    --no-sidecar
) >"${log1}" 2>&1

if ! grep -nF "[gate] running convergence gate" "${log1}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log in ${log1}; got:" >&2
  sed -n '1,240p' "${log1}" >&2 || true
  exit 1
fi
check_trajectory_converged "${tmp_root}/team_no_sidecar/trajectory_index.json"

if [[ -f "${tmp_root}/team_no_sidecar/runs/${tag}/${tag}_member_c.md" ]]; then
  echo "[fail] sidecar report unexpectedly created under --no-sidecar: ${tmp_root}/team_no_sidecar/runs/${tag}/${tag}_member_c.md" >&2
  exit 1
fi

echo "[test2] sidecar ON (even if it fails) must not block convergence gate"
log2="${tmp_root}/run_sidecar_fail.log"
(
  cd "${tmp_root}"
  RESEARCH_TEAM_STUB_FAIL_SIDECAR=1 bash "${BIN_DIR}/run_team_cycle.sh" \
    --tag "${tag}" \
    --notes Draft_Derivation.md \
    --out-dir team_sidecar_fail \
    --member-a-system prompts/_system_member_a.txt \
    --member-b-system prompts/_system_member_b.txt \
    --member-a-runner "${tmp_root}/stub_member_a.sh" \
    --member-b-runner "${tmp_root}/stub_member_b.sh" \
    --member-b-runner-kind claude \
    --sidecar
) >"${log2}" 2>&1

if ! grep -nF "[gate] running convergence gate" "${log2}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log in ${log2}; got:" >&2
  sed -n '1,260p' "${log2}" >&2 || true
  exit 1
fi
if ! grep -nF "[member-c] tag=${tag}" "${log2}" >/dev/null 2>&1; then
  echo "[fail] expected sidecar to start in ${log2}; got:" >&2
  sed -n '1,260p' "${log2}" >&2 || true
  exit 1
fi
if ! grep -nF "intentional sidecar failure" "${log2}" >/dev/null 2>&1; then
  echo "[fail] expected sidecar runner to be invoked (intentional failure message missing) in ${log2}; got:" >&2
  sed -n '1,320p' "${log2}" >&2 || true
  exit 1
fi
check_trajectory_converged "${tmp_root}/team_sidecar_fail/trajectory_index.json"

echo "[ok] run_team_cycle convergence smoke tests passed"
