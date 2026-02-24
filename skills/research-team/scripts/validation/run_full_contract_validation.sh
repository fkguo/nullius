#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

SCAFFOLD="${BIN_DIR}/scaffold_research_workflow.sh"
DEMO="${BIN_DIR}/generate_demo_milestone.sh"
RUN_TEAM="${BIN_DIR}/run_team_cycle.sh"
RUN_DRAFT="${BIN_DIR}/run_draft_cycle.sh"
SMOKE_ALL="${SKILL_ROOT}/scripts/dev/run_all_smoke_tests.sh"

KEEP_TMP=0
SKIP_SMOKE=0
REPORT_PATH=""

usage() {
  cat <<'EOF'
run_full_contract_validation.sh

Runs a deterministic, one-shot validation harness for the research-team skill:
- smoke suite (optional)
- three-profile preflight-only + full-cycle runs (stub runners)
- brake checks:
  - forced not_converged propagates exit + trajectory stage
  - sidecar failure is warn-only (does not block convergence)
  - failing preflight fails fast without calling runners
  - plan_tracking sentinel preserved verbatim

Usage:
  bash scripts/validation/run_full_contract_validation.sh [--skip-smoke] [--keep-tmp] [--report PATH]

Options:
  --skip-smoke     Skip scripts/dev/run_all_smoke_tests.sh
  --keep-tmp       Keep the temporary scaffolded projects (prints path)
  --report PATH    Write a markdown summary to PATH (optional)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
    --report) REPORT_PATH="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ ! -f "${SCAFFOLD}" || ! -f "${DEMO}" || ! -f "${RUN_TEAM}" || ! -f "${RUN_DRAFT}" ]]; then
  echo "ERROR: missing expected skill scripts under ${BIN_DIR}" >&2
  exit 2
fi

tmp_root="$(mktemp -d)"
cleanup() {
  if [[ "${KEEP_TMP}" -eq 1 ]]; then
    echo "[info] keeping tmp_root=${tmp_root}"
    return 0
  fi
  rm -rf "${tmp_root}"
}
trap cleanup EXIT

report_tmp="${tmp_root}/validation_summary.md"
report_append() { printf '%s\n' "$*" >>"${report_tmp}"; }

report_append "# research-team deterministic contract validation"
report_append ""
report_append "- skill_root: ${SKILL_ROOT}"
report_append "- tmp_root: ${tmp_root}"
report_append ""

if [[ "${SKIP_SMOKE}" -ne 1 ]]; then
  report_append "## Smoke suite"
  report_append ""
  smoke_log="${tmp_root}/smoke_suite.log"
  if bash "${SMOKE_ALL}" >"${smoke_log}" 2>&1; then
    report_append "- status: PASS"
  else
    report_append "- status: FAIL"
    report_append "- log: ${smoke_log}"
    echo "[fail] smoke suite failed; see ${smoke_log}" >&2
    exit 1
  fi
  report_append ""
fi

cat >"${tmp_root}/stub_member_a.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
marker="${RESEARCH_TEAM_STUB_MARKER:-}"

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

if [[ -n "${marker}" ]]; then
  echo "invoked" >>"${marker}"
fi

if [[ "${RESEARCH_TEAM_STUB_FAIL_SIDECAR:-0}" == "1" && "${out}" == *"_member_c.md" ]]; then
  echo "stub_member_a: intentional sidecar failure (${out})" >&2
  exit 7
fi

mkdir -p "$(dirname "${out}")"
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

Verdict: ready for next milestone
MD
exit 0
SH
chmod +x "${tmp_root}/stub_member_a.sh"

cat >"${tmp_root}/stub_member_b.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
marker="${RESEARCH_TEAM_STUB_MARKER:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model|--output-format|--prompt-file) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub_member_b: missing --out" >&2
  exit 2
fi

if [[ -n "${marker}" ]]; then
  echo "invoked" >>"${marker}"
fi

mkdir -p "$(dirname "${out}")"

if [[ "${RESEARCH_TEAM_STUB_FORCE_NOT_CONVERGED:-0}" == "1" ]]; then
  cat >"${out}" <<'MD'
# Member B Report

| Check | Result |
|---|---|
| Derivation replication | fail |
| Computation replication | pass |

## Derivation Replication
Comparison: mismatch

## Computation Replication
Comparison: match

## Sweep Semantics / Parameter Dependence
Consistency verdict: pass

Verdict: needs revision
MD
  exit 0
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

Verdict: ready for next milestone
MD
exit 0
SH
chmod +x "${tmp_root}/stub_member_b.sh"

cat >"${tmp_root}/stub_draft_claude.sh" <<'SH'
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
  echo "stub_draft_claude: missing --out" >&2
  exit 2
fi

mkdir -p "$(dirname "${out}")"

if [[ "${RESEARCH_TEAM_STUB_DRAFT_NEEDS_REVISION:-0}" == "1" ]]; then
  cat >"${out}" <<'MD'
## Blocking Issues (Must Fix)
- (Sec. 2, Eq. (1)): sign error; fix normalization and update downstream text (Correctness-Blocking)

## Minimal Fix List
1. (Sec. 2, Eq. (1)): flip the sign and propagate to Eq. (3).

## Verdict
Verdict: needs revision
Blocking issues count: 1
Rationale: correctness-blocking issue present
MD
  exit 0
fi

cat >"${out}" <<'MD'
## Blocking Issues (Must Fix)
(none)

## Minimal Fix List
1. (Sec. 1): tighten definitions (non-blocking).

## Verdict
Verdict: ready for review cycle
Blocking issues count: 0
Rationale: no correctness-blocking issues found in the packet excerpts
MD
exit 0
SH
chmod +x "${tmp_root}/stub_draft_claude.sh"

cat >"${tmp_root}/stub_draft_gemini.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model|--output-format|--prompt-file) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub_draft_gemini: missing --out" >&2
  exit 2
fi

mkdir -p "$(dirname "${out}")"

if [[ "${RESEARCH_TEAM_STUB_DRAFT_NEEDS_REVISION:-0}" == "1" ]]; then
  cat >"${out}" <<'MD'
## Blocking Evidence Gaps
- (Fig. 1): referenced but missing file; results interpretation not verifiable

## Minimal Fix List
1. (Fig. 1): add the figure source and ensure it is included via \includegraphics.

## Verdict
Verdict: needs revision
Blocking issues count: 1
Rationale: blocking evidence gap
MD
  exit 0
fi

cat >"${out}" <<'MD'
## Blocking Evidence Gaps
(none)

## Minimal Fix List
1. (Intro): add one paragraph to scope the novelty (non-blocking).

## Verdict
Verdict: ready for review cycle
Blocking issues count: 0
Rationale: evidence sufficient for this review slice
MD
exit 0
SH
chmod +x "${tmp_root}/stub_draft_gemini.sh"

approve_project_charter() {
  local root="$1"
  local profile="$2"
  python3 - "${root}/PROJECT_CHARTER.md" "${profile}" <<'PY'
from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path

path = Path(sys.argv[1])
profile = sys.argv[2].strip()
text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
today = date.today().isoformat()

text = re.sub(r"^Status:\s*DRAFT\b.*$", "Status: APPROVED", text, flags=re.MULTILINE)
text = re.sub(r"^Created:\s*.*$", f"Created: {today}", text, flags=re.MULTILINE)
text = re.sub(r"^Last updated:\s*.*$", f"Last updated: {today}", text, flags=re.MULTILINE)
if profile:
    text = re.sub(r"^Declared profile:\s*.*$", f"Declared profile: {profile}", text, flags=re.MULTILINE)

text = re.sub(
    r"^Primary goal:\s*.*$",
    "Primary goal: deterministic validation harness for research-team workflow",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): exercise preflight gates, trajectory logging, and convergence gate semantics under stub runners",
    text,
    flags=re.MULTILINE,
)

text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Avoid goal drift: validate workflow contracts, not a specific scientific claim.",
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
    "- Toolkit: convergence gate + trajectory invariants exercised by deterministic harness",
    text,
    flags=re.MULTILINE,
)

path.write_text(text, encoding="utf-8")
print("patched:", path)
PY
}

assert_traj_stage() {
  local traj="$1"
  local tag="$2"
  local stage="$3"
  python3 - "${traj}" "${tag}" "${stage}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

traj = Path(sys.argv[1])
tag = sys.argv[2]
stage = sys.argv[3]

obj = json.loads(traj.read_text(encoding="utf-8", errors="replace"))
runs = obj.get("runs", [])
ok = any(r.get("tag") == tag and r.get("stage") == stage for r in runs if isinstance(r, dict))
if not ok:
    raise SystemExit(f"missing stage={stage} for tag={tag} in {traj}")
PY
}

run_profile() {
  local profile="$1"
  local root="${tmp_root}/proj_${profile}"
  local out_dir="team"
  local tag_preflight="V1-${profile}-preflight-r1"
  local tag_full="V1-${profile}-full-r1"
  local log_pre="${tmp_root}/${profile}_preflight.log"
  local log_full="${tmp_root}/${profile}_full.log"

  report_append "## Profile: ${profile}"
  report_append ""

  bash "${SCAFFOLD}" --root "${root}" --project "ContractValidation-${profile}" --profile "${profile}" >/dev/null 2>&1
  bash "${DEMO}" --root "${root}" --tag "${tag_full}" >/dev/null 2>&1
  approve_project_charter "${root}" "${profile}" >/dev/null 2>&1

  (
    cd "${root}"
    bash "${RUN_TEAM}" \
      --tag "${tag_preflight}" \
      --notes Draft_Derivation.md \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_member_a.txt \
      --member-b-system prompts/_system_member_b.txt \
      --member-a-runner "${tmp_root}/stub_member_a.sh" \
      --member-b-runner "${tmp_root}/stub_member_b.sh" \
      --no-sidecar \
      --preflight-only
  ) >"${log_pre}" 2>&1
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag_preflight}" "preflight_ok"
  report_append "- preflight-only: PASS (${tag_preflight})"

  (
    cd "${root}"
    bash "${RUN_TEAM}" \
      --tag "${tag_full}" \
      --notes Draft_Derivation.md \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_member_a.txt \
      --member-b-system prompts/_system_member_b.txt \
      --member-a-runner "${tmp_root}/stub_member_a.sh" \
      --member-b-runner "${tmp_root}/stub_member_b.sh" \
      --no-sidecar
  ) >"${log_full}" 2>&1
  if ! grep -nF "[gate] running convergence gate" "${log_full}" >/dev/null 2>&1; then
    echo "[fail] missing convergence gate log for profile=${profile}; see ${log_full}" >&2
    exit 1
  fi
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag_full}" "member_reports"
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag_full}" "converged"
  report_append "- full cycle: PASS (${tag_full})"
  report_append ""
}

run_brake_not_converged() {
  local root="${tmp_root}/proj_brake_not_converged"
  local out_dir="team"
  local tag="V1-brake-not-converged-r1"
  local log="${tmp_root}/brake_not_converged.log"

  report_append "## Brake check: not_converged propagation"
  report_append ""

  bash "${SCAFFOLD}" --root "${root}" --project "ContractValidation-BrakeNotConverged" --profile "mixed" >/dev/null 2>&1
  bash "${DEMO}" --root "${root}" --tag "${tag}" >/dev/null 2>&1
  approve_project_charter "${root}" "mixed" >/dev/null 2>&1

  set +e
  (
    cd "${root}"
    RESEARCH_TEAM_STUB_FORCE_NOT_CONVERGED=1 bash "${RUN_TEAM}" \
      --tag "${tag}" \
      --notes Draft_Derivation.md \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_member_a.txt \
      --member-b-system prompts/_system_member_b.txt \
      --member-a-runner "${tmp_root}/stub_member_a.sh" \
      --member-b-runner "${tmp_root}/stub_member_b.sh" \
      --no-sidecar
  ) >"${log}" 2>&1
  code=$?
  set -e

  if [[ ${code} -eq 0 ]]; then
    echo "[fail] expected not_converged to exit non-zero; got exit=0 (log=${log})" >&2
    exit 1
  fi
  if ! grep -nF "[gate] running convergence gate" "${log}" >/dev/null 2>&1; then
    echo "[fail] missing convergence gate log for not_converged brake check; see ${log}" >&2
    exit 1
  fi
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag}" "member_reports"
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag}" "not_converged"

  report_append "- status: PASS (exit=${code}; stage=not_converged recorded)"
  report_append ""
}

run_brake_sidecar_warn_only() {
  local root="${tmp_root}/proj_brake_sidecar_warn_only"
  local out_dir="team"
  local tag="V1-brake-sidecar-warn-only-r1"
  local log="${tmp_root}/brake_sidecar_warn_only.log"

  report_append "## Brake check: sidecar warn-only (failure does not block convergence)"
  report_append ""

  bash "${SCAFFOLD}" --root "${root}" --project "ContractValidation-BrakeSidecarWarnOnly" --profile "mixed" >/dev/null 2>&1
  bash "${DEMO}" --root "${root}" --tag "${tag}" >/dev/null 2>&1
  approve_project_charter "${root}" "mixed" >/dev/null 2>&1

  (
    cd "${root}"
    RESEARCH_TEAM_STUB_FAIL_SIDECAR=1 bash "${RUN_TEAM}" \
      --tag "${tag}" \
      --notes Draft_Derivation.md \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_member_a.txt \
      --member-b-system prompts/_system_member_b.txt \
      --member-a-runner "${tmp_root}/stub_member_a.sh" \
      --member-b-runner "${tmp_root}/stub_member_b.sh" \
      --sidecar
  ) >"${log}" 2>&1

  if ! grep -nF "[member-c] tag=${tag}" "${log}" >/dev/null 2>&1; then
    echo "[fail] expected sidecar to start for warn-only brake check; see ${log}" >&2
    exit 1
  fi
  if ! grep -nF "intentional sidecar failure" "${log}" >/dev/null 2>&1; then
    echo "[fail] expected sidecar failure message missing for warn-only brake check; see ${log}" >&2
    exit 1
  fi
  if ! grep -nF "[gate] running convergence gate" "${log}" >/dev/null 2>&1; then
    echo "[fail] missing convergence gate log for warn-only brake check; see ${log}" >&2
    exit 1
  fi

  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag}" "converged"
  report_append "- status: PASS (sidecar failed; convergence still recorded)"
  report_append ""
}

run_brake_preflight_fail_fast() {
  local root="${tmp_root}/proj_brake_preflight_fail"
  local out_dir="team"
  local tag="V1-brake-preflight-fail-r1"
  local log="${tmp_root}/brake_preflight_fail.log"
  local marker="${tmp_root}/brake_preflight_fail_marker.txt"

  report_append "## Brake check: preflight fail-fast (no runner calls)"
  report_append ""

  bash "${SCAFFOLD}" --root "${root}" --project "ContractValidation-BrakePreflightFail" --profile "mixed" >/dev/null 2>&1
  rm -f "${marker}"

  set +e
  (
    cd "${root}"
    RESEARCH_TEAM_STUB_MARKER="${marker}" bash "${RUN_TEAM}" \
      --tag "${tag}" \
      --notes Draft_Derivation.md \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_member_a.txt \
      --member-b-system prompts/_system_member_b.txt \
      --member-a-runner "${tmp_root}/stub_member_a.sh" \
      --member-b-runner "${tmp_root}/stub_member_b.sh" \
      --no-sidecar
  ) >"${log}" 2>&1
  code=$?
  set -e

  if [[ ${code} -eq 0 ]]; then
    echo "[fail] expected preflight failure; got exit=0 (log=${log})" >&2
    exit 1
  fi
  if [[ -f "${marker}" ]]; then
    echo "[fail] stub runners were invoked during preflight failure (marker exists: ${marker})" >&2
    exit 1
  fi
  if ! grep -nF "[gate] Fail-fast:" "${log}" >/dev/null 2>&1; then
    echo "[fail] expected a fail-fast gate marker missing; see ${log}" >&2
    exit 1
  fi

  report_append "- status: PASS (exit=${code}; runners not invoked)"
  report_append ""
}

run_brake_plan_tracking_sentinel() {
  local root="${tmp_root}/proj_brake_plan_sentinel"
  local out_dir="team"
  local tag_pre="V1-brake-plan-preflight-r1"
  local tag_full="V1-brake-plan-full-r1"
  local log_pre="${tmp_root}/brake_plan_preflight.log"
  local log_full="${tmp_root}/brake_plan_full.log"
  local plan_path="${root}/RESEARCH_PLAN.md"
  local sentinel="SENTINEL__research_team_plan_tracking__DO_NOT_DELETE"

  report_append "## Brake check: plan_tracking sentinel preservation"
  report_append ""

  bash "${SCAFFOLD}" --root "${root}" --project "ContractValidation-BrakePlanSentinel" --profile "mixed" >/dev/null 2>&1
  bash "${DEMO}" --root "${root}" --tag "${tag_full}" >/dev/null 2>&1
  approve_project_charter "${root}" "mixed" >/dev/null 2>&1

  (
    cd "${root}"
    bash "${RUN_TEAM}" \
      --tag "${tag_pre}" \
      --notes Draft_Derivation.md \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_member_a.txt \
      --member-b-system prompts/_system_member_b.txt \
      --member-a-runner "${tmp_root}/stub_member_a.sh" \
      --member-b-runner "${tmp_root}/stub_member_b.sh" \
      --no-sidecar \
      --preflight-only
  ) >"${log_pre}" 2>&1

  if [[ ! -f "${plan_path}" ]]; then
    echo "[fail] expected research plan to exist: ${plan_path}" >&2
    exit 1
  fi
  printf '\n%s\n' "${sentinel}" >>"${plan_path}"

  (
    cd "${root}"
    bash "${RUN_TEAM}" \
      --tag "${tag_full}" \
      --notes Draft_Derivation.md \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_member_a.txt \
      --member-b-system prompts/_system_member_b.txt \
      --member-a-runner "${tmp_root}/stub_member_a.sh" \
      --member-b-runner "${tmp_root}/stub_member_b.sh" \
      --no-sidecar
  ) >"${log_full}" 2>&1

  if ! grep -nF "${sentinel}" "${plan_path}" >/dev/null 2>&1; then
    echo "[fail] plan_tracking sentinel missing after full cycle: ${plan_path}" >&2
    exit 1
  fi
  if ! grep -nF "tag=${tag_full} status=converged" "${plan_path}" >/dev/null 2>&1; then
    echo "[fail] expected plan_tracking progress entry missing for tag=${tag_full}: ${plan_path}" >&2
    exit 1
  fi

  report_append "- status: PASS (sentinel preserved; progress entry appended)"
  report_append ""
}

run_draft_cycle_contract() {
  local root="${tmp_root}/proj_draft_cycle"
  local out_dir="team"
  local tag_pre="V1-draft-preflight-r1"
  local tag_ok="V1-draft-full-r1"
  local tag_fail="V1-draft-full-fail-r1"
  local log_pre="${tmp_root}/draft_preflight.log"
  local log_ok="${tmp_root}/draft_full_ok.log"
  local log_fail="${tmp_root}/draft_full_fail.log"

  report_append "## Draft cycle contract"
  report_append ""

  bash "${SCAFFOLD}" --root "${root}" --project "ContractValidation-Draft" --profile "mixed" >/dev/null 2>&1

  mkdir -p "${root}/knowledge_base/literature"
  cat >"${root}/main.tex" <<'EOF'
\documentclass{article}
\begin{document}
\section{Alpha}
We describe our method. \cite{Key1}
\section{Beta}
Results include a figure: \includegraphics{figs/plot}
\cite{Key2}
\end{document}
EOF

  cat >"${root}/references.bib" <<'EOF'
@article{Key1,
  title = {K1},
  author = {A},
  year = {2024}
}
@article{Key2,
  title = {K2},
  author = {B},
  year = {2024}
}
EOF

  cat >"${root}/knowledge_base/literature/Key1.md" <<'EOF'
# Key1
- Source: (stub)
EOF

  mkdir -p "${root}/figs"
  : > "${root}/figs/plot.png"

  (
    cd "${root}"
    bash "${RUN_DRAFT}" \
      --tag "${tag_pre}" \
      --tex main.tex \
      --bib references.bib \
      --out-dir "${out_dir}" \
      --preflight-only
  ) >"${log_pre}" 2>&1
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag_pre}" "draft_preflight_ok"
  report_append "- preflight-only: PASS (${tag_pre})"

  (
    cd "${root}"
    bash "${RUN_DRAFT}" \
      --tag "${tag_ok}" \
      --tex main.tex \
      --bib references.bib \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_draft_member_a.txt \
      --member-b-system prompts/_system_draft_member_b.txt \
      --member-c-system prompts/_system_draft_member_c_leader.txt \
      --member-a-runner "${tmp_root}/stub_draft_claude.sh" \
      --member-b-runner "${tmp_root}/stub_draft_gemini.sh" \
      --member-c-runner "${tmp_root}/stub_draft_claude.sh"
  ) >"${log_ok}" 2>&1
  if ! grep -nF "[gate] running draft convergence gate" "${log_ok}" >/dev/null 2>&1; then
    echo "[fail] missing draft convergence gate log; see ${log_ok}" >&2
    exit 1
  fi
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag_ok}" "draft_member_reports"
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag_ok}" "draft_converged"
  report_append "- full cycle (config-driven require_convergence): PASS (${tag_ok})"

  set +e
  (
    cd "${root}"
    RESEARCH_TEAM_STUB_DRAFT_NEEDS_REVISION=1 bash "${RUN_DRAFT}" \
      --tag "${tag_fail}" \
      --tex main.tex \
      --bib references.bib \
      --out-dir "${out_dir}" \
      --member-a-system prompts/_system_draft_member_a.txt \
      --member-b-system prompts/_system_draft_member_b.txt \
      --member-c-system prompts/_system_draft_member_c_leader.txt \
      --member-a-runner "${tmp_root}/stub_draft_claude.sh" \
      --member-b-runner "${tmp_root}/stub_draft_gemini.sh" \
      --member-c-runner "${tmp_root}/stub_draft_claude.sh"
  ) >"${log_fail}" 2>&1
  code=$?
  set -e

  if [[ ${code} -eq 0 ]]; then
    echo "[fail] expected draft not_converged to exit non-zero; got exit=0 (log=${log_fail})" >&2
    exit 1
  fi
  assert_traj_stage "${root}/${out_dir}/trajectory_index.json" "${tag_fail}" "draft_not_converged"
  report_append "- brake check (not_converged): PASS (exit=${code}; stage=draft_not_converged recorded)"
  report_append ""
}

run_profile "mixed"
run_profile "methodology_dev"
run_profile "toolkit_extraction"

run_brake_not_converged
run_brake_sidecar_warn_only
run_brake_preflight_fail_fast
run_brake_plan_tracking_sentinel
run_draft_cycle_contract

report_append "## Summary"
report_append ""
report_append "- status: PASS"
report_append ""

cat "${report_tmp}"
if [[ -n "${REPORT_PATH}" ]]; then
  mkdir -p "$(dirname "${REPORT_PATH}")"
  cp -f "${report_tmp}" "${REPORT_PATH}"
  echo "[ok] wrote report: ${REPORT_PATH}"
fi

echo "[ok] deterministic contract validation passed"
