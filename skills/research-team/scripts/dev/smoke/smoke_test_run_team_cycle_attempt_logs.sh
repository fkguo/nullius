#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

tag="M4-r1"

echo "[setup] scaffold + demo milestone"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeAttemptLogs" --profile "mixed" >/dev/null 2>&1
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

d["sidecar_review"] = {"enabled": False}
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
    "Primary goal: smoke — verify per-attempt runner logs + cycle_state diagnostics",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): smoke — run_team_cycle writes member-scoped attempt logs and cycle_state diagnostics",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Attempt logging diagnostics are best-effort and do not break convergence.",
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
    "- Toolkit: run_team_cycle attempt-log diagnostics (smoke target)",
    text,
    flags=re.MULTILINE,
)
path.write_text(text, encoding="utf-8")
print("patched:", path)
PY

mkdir -p "${tmp_root}/bin"
cat >"${tmp_root}/bin/claude" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

state_dir="${RESEARCH_TEAM_STUB_STATE_DIR:-/tmp/research_team_stub_state}"
mkdir -p "${state_dir}"

prefix_raw="${RESEARCH_TEAM_ATTEMPT_LOG_PREFIX:-default}"
prefix="$(printf '%s' "${prefix_raw}" | tr -c 'A-Za-z0-9._-' '_')"
count_file="${state_dir}/${prefix}.count"

count=0
if [[ -f "${count_file}" ]]; then
  count="$(cat "${count_file}")"
fi
count=$((count + 1))
echo "${count}" >"${count_file}"

if [[ "${count}" -eq 1 ]]; then
  echo "simulated transient claude failure prefix=${prefix_raw}" >&2
  exit 1
fi

cat <<'MD'
# Member Report

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
ready for next milestone
MD
exit 0
SH
chmod +x "${tmp_root}/bin/claude"

cat >"${tmp_root}/stub_claude_runner.sh" <<SH
#!/usr/bin/env bash
set -euo pipefail
bash "${tmp_root}/scripts/run_claude.sh" --max-retries 2 --sleep-secs 0 "\$@"
SH
chmod +x "${tmp_root}/stub_claude_runner.sh"

echo "[run] run_team_cycle with claude runners for both members"
(
  cd "${tmp_root}"
  PATH="${tmp_root}/bin:${PATH}" \
  RESEARCH_TEAM_STUB_STATE_DIR="${tmp_root}/stub_state" \
  bash "${BIN_DIR}/run_team_cycle.sh" \
    --tag "${tag}" \
    --notes Draft_Derivation.md \
    --out-dir team \
    --member-a-system prompts/_system_member_a.txt \
    --member-b-system prompts/_system_member_b.txt \
    --member-b-runner-kind claude \
    --member-a-runner "${tmp_root}/stub_claude_runner.sh" \
    --member-b-runner "${tmp_root}/stub_claude_runner.sh" \
    --no-sidecar
)

run_dir="${tmp_root}/team/runs/${tag}"
logs_dir="${run_dir}/logs"
cycle_state="${run_dir}/cycle_state.json"

echo "[assert] attempt logs exist and are member-prefixed"
test -d "${logs_dir}" || { echo "[fail] logs dir missing: ${logs_dir}" >&2; exit 1; }
test -f "${logs_dir}/${tag}_member_a_attempt_01.stderr.log" || { echo "[fail] missing member_a attempt stderr log" >&2; exit 1; }
test -f "${logs_dir}/${tag}_member_a_attempt_02.stdout.log" || { echo "[fail] missing member_a success stdout log" >&2; exit 1; }
test -f "${logs_dir}/${tag}_member_b_attempt_01.stderr.log" || { echo "[fail] missing member_b attempt stderr log" >&2; exit 1; }
test -f "${logs_dir}/${tag}_member_b_attempt_02.stdout.log" || { echo "[fail] missing member_b success stdout log" >&2; exit 1; }

echo "[assert] no prefix clobbering (member_a and member_b logs both present)"
count_a="$(ls "${logs_dir}/${tag}_member_a_attempt_"*.meta.json 2>/dev/null | wc -l | tr -d ' ')"
count_b="$(ls "${logs_dir}/${tag}_member_b_attempt_"*.meta.json 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${count_a}" -lt 2 || "${count_b}" -lt 2 ]]; then
  echo "[fail] expected >=2 attempt metas per member; got member_a=${count_a}, member_b=${count_b}" >&2
  exit 1
fi

echo "[assert] cycle_state has attempt diagnostics"
python3 - "${cycle_state}" <<'PY'
import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
obj = json.loads(p.read_text(encoding="utf-8", errors="replace"))
r = obj.get("runners", {})
for m in ("member_a", "member_b"):
    md = r.get(m, {})
    at = md.get("attempts_total")
    fa = md.get("failed_attempts")
    if not isinstance(at, int) or at < 2:
        raise SystemExit(f"missing/invalid attempts_total for {m}: {at!r}")
    if not isinstance(fa, int) or fa < 1:
        raise SystemExit(f"missing/invalid failed_attempts for {m}: {fa!r}")
PY

echo "[ok] attempt log smoke test passed"
