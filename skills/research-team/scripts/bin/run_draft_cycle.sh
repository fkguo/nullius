#!/usr/bin/env bash
set -euo pipefail

TAG=""
TEX=""
BIB=""
OUT_DIR=""
PREFLIGHT_ONLY=0

MEMBER_A_SYSTEM=""
MEMBER_B_SYSTEM=""
MEMBER_C_SYSTEM=""
MEMBER_A_MODEL=""
MEMBER_B_MODEL=""
MEMBER_C_MODEL=""
MEMBER_A_REASONING_EFFORT="high"
MEMBER_B_REASONING_EFFORT="high"
MEMBER_C_REASONING_EFFORT="high"
MEMBER_A_TOOLS=""
MEMBER_C_TOOLS=""
MEMBER_B_OUTPUT_FORMAT="text"
MEMBER_C_OUTPUT_FORMAT="text"
MEMBER_A_RUNNER_PATH=""
MEMBER_B_RUNNER_PATH=""
MEMBER_C_RUNNER_PATH=""

# -1: auto (from config). 0/1: explicit CLI override.
REQUIRE_CONVERGENCE="-1"

MAX_SECTIONS="0"
MAX_SECTION_CHARS="0"
MAX_ENV_BLOCKS="0"
SEMANTIC_SELECTION_JSON=""

usage() {
  cat <<'EOF'
run_draft_cycle.sh

Run a LaTeX-source-first draft cycle:
  1) deterministic preflight (bib/cite/label/fig/KB linkage)
  2) build a focused review packet (candidate expansion + optional semantic adjudication over substantive slices)
  3) optionally run Member A + Member B reviewers (+ optional leader audit)
     - Host agents should prefer their official native subagent mechanism.
     - This shell script cannot spawn host-native subagents; provide explicit runner paths when using it for reviewer execution.

Usage:
  run_draft_cycle.sh --tag TAG --tex main.tex --bib refs.bib [--out-dir team] [--preflight-only]

  # With A/B reviewers (optional)
  run_draft_cycle.sh --tag TAG --tex main.tex --bib refs.bib [--out-dir team] \
    --member-a-system SYS_A.txt --member-b-system SYS_B.txt

  # With A/B + Team Leader audit (Member C) + mandatory convergence gate
  run_draft_cycle.sh --tag TAG --tex main.tex --bib refs.bib [--out-dir team] \
    --member-a-system SYS_A.txt --member-b-system SYS_B.txt --member-c-system SYS_C.txt \
    --require-convergence

Options:
  --out-dir DIR               Default: team
  --preflight-only            Run deterministic preflight + packet build, then exit before any LLM calls.

  --member-a-system PATH      Member A system prompt file (optional unless running A/B).
  --member-b-system PATH      Member B system prompt file (optional unless running A/B).
  --member-c-system PATH      Member C system prompt file (Team Leader audit; optional unless requiring convergence).
  --member-a-runner PATH      Required when running Member A through this shell script.
  --member-b-runner PATH      Required when running Member B through this shell script.
  --member-c-runner PATH      Required when running Member C through this shell script.
  --member-a-model MODEL      Optional (runner default if omitted)
  --member-b-model MODEL      Optional
  --member-c-model MODEL      Optional
  --member-a-reasoning-effort E Optional Codex effort: low|medium|high|xhigh (default: high)
  --member-b-reasoning-effort E Optional Codex effort: low|medium|high|xhigh (default: high)
  --member-c-reasoning-effort E Optional Codex effort: low|medium|high|xhigh (default: high)
  --member-a-tools TOOLS      Optional (e.g. "default"; runner default disables tools)
  --member-b-output-format F  Optional (default: text)
  --member-c-tools TOOLS      Optional (e.g. "default"; runner default disables tools)
  --member-c-output-format F  Optional (default: text; only used when runner is Gemini)

  --require-convergence        Enforce A/B/Leader convergence gate (exit non-zero on needs-revision / blocking).
  --no-require-convergence     Disable convergence gate (even if config enables it).

  --max-sections N            Optional override for focus slice count (0 uses config/default).
  --max-section-chars N       Optional override for max chars per focus slice (0 uses config/default).
  --max-env-blocks N          Optional override for env extraction count (0 uses config/default).
  --semantic-selection-json P Optional structured semantic selection JSON passed to build_draft_packet.py.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --tex) TEX="${2:-}"; shift 2 ;;
    --bib) BIB="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --member-a-system) MEMBER_A_SYSTEM="${2:-}"; shift 2 ;;
    --member-b-system) MEMBER_B_SYSTEM="${2:-}"; shift 2 ;;
    --member-c-system) MEMBER_C_SYSTEM="${2:-}"; shift 2 ;;
    --member-a-model) MEMBER_A_MODEL="${2:-}"; shift 2 ;;
    --member-b-model) MEMBER_B_MODEL="${2:-}"; shift 2 ;;
    --member-c-model) MEMBER_C_MODEL="${2:-}"; shift 2 ;;
    --member-a-reasoning-effort) MEMBER_A_REASONING_EFFORT="${2:-high}"; shift 2 ;;
    --member-b-reasoning-effort) MEMBER_B_REASONING_EFFORT="${2:-high}"; shift 2 ;;
    --member-c-reasoning-effort) MEMBER_C_REASONING_EFFORT="${2:-high}"; shift 2 ;;
    --member-a-tools) MEMBER_A_TOOLS="${2:-}"; shift 2 ;;
    --member-c-tools) MEMBER_C_TOOLS="${2:-}"; shift 2 ;;
    --member-b-output-format) MEMBER_B_OUTPUT_FORMAT="${2:-}"; shift 2 ;;
    --member-c-output-format) MEMBER_C_OUTPUT_FORMAT="${2:-}"; shift 2 ;;
    --member-a-runner) MEMBER_A_RUNNER_PATH="${2:-}"; shift 2 ;;
    --member-b-runner) MEMBER_B_RUNNER_PATH="${2:-}"; shift 2 ;;
    --member-c-runner) MEMBER_C_RUNNER_PATH="${2:-}"; shift 2 ;;
    --require-convergence) REQUIRE_CONVERGENCE="1"; shift ;;
    --no-require-convergence) REQUIRE_CONVERGENCE="0"; shift ;;
    --max-sections) MAX_SECTIONS="${2:-0}"; shift 2 ;;
    --max-section-chars) MAX_SECTION_CHARS="${2:-0}"; shift 2 ;;
    --max-env-blocks) MAX_ENV_BLOCKS="${2:-0}"; shift 2 ;;
    --semantic-selection-json) SEMANTIC_SELECTION_JSON="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${OUT_DIR}" ]]; then
  OUT_DIR="team"
fi

if [[ -z "${TAG}" || -z "${TEX}" || -z "${BIB}" ]]; then
  echo "ERROR: --tag, --tex, and --bib are required." >&2
  usage
  exit 2
fi

if [[ ! -f "${TEX}" ]]; then
  echo "ERROR: TeX file not found: ${TEX}" >&2
  exit 2
fi
if [[ ! -f "${BIB}" ]]; then
  echo "ERROR: Bib file not found: ${BIB}" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${SCRIPT_DIR}/../gates/check_tex_draft_preflight.py"
CONV_GATE="${SCRIPT_DIR}/../gates/check_draft_convergence.py"
PACKET_BUILDER="${SCRIPT_DIR}/build_draft_packet.py"
TRAJ="${SCRIPT_DIR}/update_trajectory_index.py"
PROJECT_INDEX_UPDATE_SCRIPT="${SCRIPT_DIR}/update_project_map.py"

OUT_DIR_ABS="${OUT_DIR}"
if [[ "${OUT_DIR_ABS}" != /* ]]; then
  OUT_DIR_ABS="$(pwd)/${OUT_DIR_ABS}"
fi
if [[ ! "${TAG}" =~ ^[A-Za-z0-9._-]+$ || "${TAG}" == "." || "${TAG}" == *..* ]]; then
  echo "ERROR: draft tag must be one safe path segment using only [A-Za-z0-9._-], not '.' and no '..': ${TAG}" >&2
  exit 2
fi
if [[ "${TAG}" =~ ^run_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ || "${TAG}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "ERROR: draft tag looks like a machine-generated UUID. Use a meaningful project-local run_id such as <YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN." >&2
  exit 2
fi
safe_tag="${TAG}"
run_dir="${OUT_DIR_ABS}/runs/${safe_tag}"
mkdir -p "${run_dir}"

preflight_json="${run_dir}/${safe_tag}_draft_structure.json"
preflight_report="${run_dir}/${safe_tag}_draft_preflight.md"
packet_path="${run_dir}/${safe_tag}_draft_packet.md"

echo "[traj] stage=draft_preflight_start"
python3 "${TRAJ}" --notes "${TEX}" --out-dir "${OUT_DIR}" --tag "${TAG}" --stage "draft_preflight_start" >/dev/null 2>&1 || true

echo "[gate] running TeX draft preflight ..."
set +e
python3 "${GATE}" --tex "${TEX}" --bib "${BIB}" --out-json "${preflight_json}" --out-report "${preflight_report}"
gate_code=$?
set -e

if [[ $gate_code -eq 0 ]]; then
  echo "[traj] stage=draft_preflight_ok"
  python3 "${TRAJ}" --notes "${TEX}" --out-dir "${OUT_DIR}" --tag "${TAG}" --stage "draft_preflight_ok" --gate "tex_draft_preflight:ok" >/dev/null 2>&1 || true
  if [[ -f "${PROJECT_INDEX_UPDATE_SCRIPT}" ]]; then
    python3 "${PROJECT_INDEX_UPDATE_SCRIPT}" --notes "${TEX}" --team-dir "${OUT_DIR}" --latest-kind draft --tag "${safe_tag}" --status "draft_preflight_ok" --run-dir "${run_dir}" >/dev/null 2>&1 || true
  fi
else
  echo "[traj] stage=draft_preflight_fail"
  python3 "${TRAJ}" --notes "${TEX}" --out-dir "${OUT_DIR}" --tag "${TAG}" --stage "draft_preflight_fail" --gate "tex_draft_preflight:fail" >/dev/null 2>&1 || true
  if [[ -f "${PROJECT_INDEX_UPDATE_SCRIPT}" ]]; then
    python3 "${PROJECT_INDEX_UPDATE_SCRIPT}" --notes "${TEX}" --team-dir "${OUT_DIR}" --latest-kind draft --tag "${safe_tag}" --status "draft_preflight_fail" --run-dir "${run_dir}" >/dev/null 2>&1 || true
  fi
  exit $gate_code
fi

echo "[packet] building draft packet -> ${packet_path}"
packet_cmd=(
  python3 "${PACKET_BUILDER}"
  --tag "${TAG}"
  --tex "${TEX}"
  --bib "${BIB}"
  --out "${packet_path}"
  --max-sections "${MAX_SECTIONS}"
  --max-section-chars "${MAX_SECTION_CHARS}"
  --max-env-blocks "${MAX_ENV_BLOCKS}"
)
if [[ -n "${SEMANTIC_SELECTION_JSON}" ]]; then
  packet_cmd+=(--semantic-selection-json "${SEMANTIC_SELECTION_JSON}")
fi
"${packet_cmd[@]}"

if [[ "${PREFLIGHT_ONLY}" -eq 1 ]]; then
  echo "[ok] preflight-only: packet ready: ${packet_path}"
  exit 0
fi

if [[ -z "${MEMBER_A_SYSTEM}" || -z "${MEMBER_B_SYSTEM}" ]]; then
  echo "[skip] member reviews: provide --member-a-system and --member-b-system to run A/B." >&2
  exit 0
fi
if [[ ! -f "${MEMBER_A_SYSTEM}" ]]; then
  echo "ERROR: Member A system prompt not found: ${MEMBER_A_SYSTEM}" >&2
  exit 2
fi
if [[ ! -f "${MEMBER_B_SYSTEM}" ]]; then
  echo "ERROR: Member B system prompt not found: ${MEMBER_B_SYSTEM}" >&2
  exit 2
fi

SKILLS_DIR="${SKILLS_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills" ] && echo "$r/skills" && break; done || true)}"
PROJECT_ROOT="$(pwd)"
LOCAL_CLAUDE_RUNNER="${PROJECT_ROOT}/scripts/run_claude.sh"
LOCAL_GEMINI_RUNNER="${PROJECT_ROOT}/scripts/run_gemini.sh"
LIB_DIR="${SCRIPT_DIR}/../lib"
cfg_require="0"
cfg_leader_prompt=""
if [[ -d "${LIB_DIR}" ]]; then
  # Load optional config defaults (non-fatal if config is missing).
  # - draft_review.require_convergence
  # - draft_review.leader_system_prompt
  #
  # Note: we only need these for optional behavior; draft cycle must remain runnable without a config.
  read -r cfg_require cfg_leader_prompt < <(
    python3 - <<PY
from __future__ import annotations

from pathlib import Path
import sys

sys.path.insert(0, "${LIB_DIR}")
from team_config import load_team_config  # type: ignore

cfg = load_team_config(Path("${TEX}"))
dr = cfg.data.get("draft_review", {}) if isinstance(cfg.data.get("draft_review", {}), dict) else {}
req = bool(dr.get("require_convergence", False))
leader = str(dr.get("leader_system_prompt", "") or "")
print(("1" if req else "0") + "\\t" + leader)
PY
  )
fi

if [[ "${REQUIRE_CONVERGENCE}" == "-1" ]]; then
  REQUIRE_CONVERGENCE="${cfg_require}"
fi

if [[ -z "${MEMBER_C_SYSTEM}" ]]; then
  if [[ -n "${cfg_leader_prompt}" && -f "${cfg_leader_prompt}" ]]; then
    MEMBER_C_SYSTEM="${cfg_leader_prompt}"
  elif [[ -f "prompts/_system_draft_member_c_leader.txt" ]]; then
    MEMBER_C_SYSTEM="prompts/_system_draft_member_c_leader.txt"
  fi
fi

if [[ -n "${MEMBER_C_SYSTEM}" && ! -f "${MEMBER_C_SYSTEM}" ]]; then
  echo "ERROR: Member C system prompt not found: ${MEMBER_C_SYSTEM}" >&2
  exit 2
fi
if [[ "${REQUIRE_CONVERGENCE}" == "1" && -z "${MEMBER_C_SYSTEM}" ]]; then
  echo "ERROR: --require-convergence requires the Team Leader audit (Member C). Provide --member-c-system or scaffold prompts/_system_draft_member_c_leader.txt" >&2
  exit 2
fi
if [[ -n "${MEMBER_C_SYSTEM}" && "${REQUIRE_CONVERGENCE}" != "1" ]]; then
  echo "[warn] member-c leader audit is enabled but draft convergence gate is disabled; reports are informational and blockers are not enforced (exit 0). Use --require-convergence to enforce." >&2
fi

MEMBER_A_RUNNER=""
MEMBER_B_RUNNER=""
MEMBER_C_RUNNER=""
MEMBER_A_RUNNER="${MEMBER_A_RUNNER_PATH:-}"
MEMBER_B_RUNNER="${MEMBER_B_RUNNER_PATH:-}"
if [[ -n "${MEMBER_C_SYSTEM}" ]]; then
  MEMBER_C_RUNNER="${MEMBER_C_RUNNER_PATH:-}"
fi

if [[ -z "${MEMBER_A_RUNNER}" ]]; then
  echo "ERROR: --member-a-runner is required when run_draft_cycle.sh executes Member A. Use host-native subagents outside this shell script, or pass an explicit CLI runner path." >&2
  exit 2
fi
if [[ -z "${MEMBER_B_RUNNER}" ]]; then
  echo "ERROR: --member-b-runner is required when run_draft_cycle.sh executes Member B. Use host-native subagents outside this shell script, or pass an explicit CLI runner path." >&2
  exit 2
fi
if [[ -n "${MEMBER_C_SYSTEM}" && -z "${MEMBER_C_RUNNER}" ]]; then
  echo "ERROR: --member-c-runner is required when run_draft_cycle.sh executes Member C. Use host-native subagents outside this shell script, or pass an explicit CLI runner path." >&2
  exit 2
fi
if [[ ! -f "${MEMBER_A_RUNNER}" ]]; then
  echo "ERROR: Member A runner not found: ${MEMBER_A_RUNNER}" >&2
  exit 2
fi
if [[ ! -f "${MEMBER_B_RUNNER}" ]]; then
  echo "ERROR: Member B runner not found: ${MEMBER_B_RUNNER}" >&2
  exit 2
fi
if [[ -n "${MEMBER_C_SYSTEM}" && ! -f "${MEMBER_C_RUNNER}" ]]; then
  echo "ERROR: Member C runner not found: ${MEMBER_C_RUNNER}" >&2
  exit 2
fi

member_a_out="${run_dir}/${safe_tag}_draft_member_a.md"
member_b_out="${run_dir}/${safe_tag}_draft_member_b.md"
member_c_out="${run_dir}/${safe_tag}_draft_member_c_leader.md"

echo "[member-a] ${member_a_out}"
is_codex_runner() {
  local runner_base_l
  runner_base_l="$(basename "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "${runner_base_l}" == *codex* ]]
}

is_gemini_runner() {
  local runner_base_l
  runner_base_l="$(basename "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "${runner_base_l}" == *gemini* ]]
}

run_member_a() {
  local -a cmd
  local -a extra
  local -a tools_args
  extra=()
  tools_args=()
  if is_codex_runner "${MEMBER_A_RUNNER}"; then
    extra+=( --reasoning-effort "${MEMBER_A_REASONING_EFFORT}" )
  elif [[ -n "${MEMBER_A_TOOLS}" ]]; then
    tools_args+=( --tools "${MEMBER_A_TOOLS}" )
  fi
  cmd=( bash "${MEMBER_A_RUNNER}" )
  if [[ -n "${MEMBER_A_MODEL}" ]]; then
    cmd+=( --model "${MEMBER_A_MODEL}" )
  fi
  if [[ ${#tools_args[@]} -gt 0 ]]; then
    cmd+=( "${tools_args[@]}" )
  fi
  if [[ ${#extra[@]} -gt 0 ]]; then
    cmd+=( "${extra[@]}" )
  fi
  cmd+=( --system-prompt-file "${MEMBER_A_SYSTEM}" --prompt-file "${packet_path}" --out "${member_a_out}" )
  "${cmd[@]}"
}

tmp_gemini_prompt="$(mktemp)"
tmp_gemini_prompt_c=""
cleanup() {
  rm -f "${tmp_gemini_prompt}"
  if [[ -n "${tmp_gemini_prompt_c}" ]]; then
    rm -f "${tmp_gemini_prompt_c}"
  fi
}
trap cleanup EXIT

{
  echo "SYSTEM (follow strictly):"
  cat "${MEMBER_B_SYSTEM}"
  echo
  echo "USER PACKET:"
  cat "${packet_path}"
} >"${tmp_gemini_prompt}"

echo "[member-b] ${member_b_out}"
run_member_b() {
  if is_gemini_runner "${MEMBER_B_RUNNER}"; then
    if [[ -n "${MEMBER_B_MODEL}" ]]; then
      bash "${MEMBER_B_RUNNER}" --model "${MEMBER_B_MODEL}" --output-format "${MEMBER_B_OUTPUT_FORMAT}" \
        --prompt-file "${tmp_gemini_prompt}" --out "${member_b_out}"
      return
    fi
    bash "${MEMBER_B_RUNNER}" --output-format "${MEMBER_B_OUTPUT_FORMAT}" --prompt-file "${tmp_gemini_prompt}" --out "${member_b_out}"
    return
  fi
  local -a cmd
  local -a extra
  extra=()
  if is_codex_runner "${MEMBER_B_RUNNER}"; then
    extra+=( --reasoning-effort "${MEMBER_B_REASONING_EFFORT}" )
  fi
  cmd=( bash "${MEMBER_B_RUNNER}" )
  if [[ -n "${MEMBER_B_MODEL}" ]]; then
    cmd+=( --model "${MEMBER_B_MODEL}" )
  fi
  if [[ ${#extra[@]} -gt 0 ]]; then
    cmd+=( "${extra[@]}" )
  fi
  cmd+=( --system-prompt-file "${MEMBER_B_SYSTEM}" --prompt-file "${packet_path}" --out "${member_b_out}" )
  "${cmd[@]}"
}

run_member_c() {
  if [[ -z "${MEMBER_C_SYSTEM}" ]]; then
    return 0
  fi

  if is_gemini_runner "${MEMBER_C_RUNNER}"; then
    tmp_gemini_prompt_c="$(mktemp)"
    {
      echo "SYSTEM (follow strictly):"
      cat "${MEMBER_C_SYSTEM}"
      echo
      echo "USER PACKET:"
      cat "${packet_path}"
    } >"${tmp_gemini_prompt_c}"
    if [[ -n "${MEMBER_C_MODEL}" ]]; then
      bash "${MEMBER_C_RUNNER}" --model "${MEMBER_C_MODEL}" --output-format "${MEMBER_C_OUTPUT_FORMAT}" \
        --prompt-file "${tmp_gemini_prompt_c}" --out "${member_c_out}"
      return
    fi
    bash "${MEMBER_C_RUNNER}" --output-format "${MEMBER_C_OUTPUT_FORMAT}" --prompt-file "${tmp_gemini_prompt_c}" --out "${member_c_out}"
    return
  fi

  local -a cmd
  local -a extra
  local -a tools_args
  extra=()
  tools_args=()
  if is_codex_runner "${MEMBER_C_RUNNER}"; then
    extra+=( --reasoning-effort "${MEMBER_C_REASONING_EFFORT}" )
  elif [[ -n "${MEMBER_C_TOOLS}" ]]; then
    tools_args+=( --tools "${MEMBER_C_TOOLS}" )
  fi
  cmd=( bash "${MEMBER_C_RUNNER}" )
  if [[ -n "${MEMBER_C_MODEL}" ]]; then
    cmd+=( --model "${MEMBER_C_MODEL}" )
  fi
  if [[ ${#tools_args[@]} -gt 0 ]]; then
    cmd+=( "${tools_args[@]}" )
  fi
  if [[ ${#extra[@]} -gt 0 ]]; then
    cmd+=( "${extra[@]}" )
  fi
  cmd+=( --system-prompt-file "${MEMBER_C_SYSTEM}" --prompt-file "${packet_path}" --out "${member_c_out}" )
  "${cmd[@]}"
}

run_member_a &
pid_a=$!
run_member_b &
pid_b=$!

pid_c=""
if [[ -n "${MEMBER_C_SYSTEM}" ]]; then
  echo "[member-c] ${member_c_out}"
  run_member_c &
  pid_c=$!
fi

wait $pid_a
wait $pid_b
if [[ -n "${pid_c}" ]]; then
  wait $pid_c
fi

echo "[traj] stage=draft_member_reports"
python3 "${TRAJ}" --notes "${TEX}" --out-dir "${OUT_DIR}" --tag "${TAG}" --stage "draft_member_reports" \
  --packet "${packet_path}" --member-a "${member_a_out}" --member-b "${member_b_out}" ${MEMBER_C_SYSTEM:+--member-c "${member_c_out}"} >/dev/null 2>&1 || true

if [[ -f "${PROJECT_INDEX_UPDATE_SCRIPT}" ]]; then
  python3 "${PROJECT_INDEX_UPDATE_SCRIPT}" --notes "${TEX}" --team-dir "${OUT_DIR}" --latest-kind draft --tag "${safe_tag}" --status "draft_member_reports" --run-dir "${run_dir}" >/dev/null 2>&1 || true
fi

if [[ "${REQUIRE_CONVERGENCE}" == "1" ]]; then
  if [[ ! -f "${CONV_GATE}" ]]; then
    echo "ERROR: missing draft convergence gate: ${CONV_GATE}" >&2
    exit 2
  fi
  conv_log="${run_dir}/${safe_tag}_draft_convergence_log.md"
  conv_summary="${run_dir}/${safe_tag}_draft_converged_summary.md"
  conv_json="${run_dir}/convergence_gate_result_v1.json"

  echo "[gate] running draft convergence gate ..."
  set +e
  python3 "${CONV_GATE}" \
    --tag "${TAG}" \
    --member-a "${member_a_out}" \
    --member-b "${member_b_out}" \
    --member-c "${member_c_out}" \
    --out-log "${conv_log}" \
    --out-summary "${conv_summary}" \
    --out-json "${conv_json}"
  conv_code=$?
  set -e

  conv_status=""
  conv_exit_code_json=""
  if [[ -f "${conv_json}" ]]; then
    conv_fields=()
    while IFS= read -r line; do
      conv_fields+=("${line}")
    done < <(python3 - "${conv_json}" <<'PY'
import json
import sys

try:
    data = json.loads(open(sys.argv[1], "r", encoding="utf-8").read())
except Exception:
    print("")
    print("")
    raise SystemExit(0)

status = data.get("status", "")
exit_code = data.get("exit_code", "")
print(status if isinstance(status, str) else "")
print(exit_code if isinstance(exit_code, int) else "")
PY
)
    conv_status="${conv_fields[0]:-}"
    conv_exit_code_json="${conv_fields[1]:-}"
  fi

  if [[ -z "${conv_status}" || -z "${conv_exit_code_json}" ]]; then
    echo "[gate] ERROR: missing/invalid structured draft convergence result: ${conv_json}" >&2
    conv_status="parse_error"
    conv_code=2
  elif [[ "${conv_exit_code_json}" != "${conv_code}" ]]; then
    echo "[gate] ERROR: draft gate exit mismatch (process=${conv_code}, json=${conv_exit_code_json}); forcing parse_error." >&2
    conv_status="parse_error"
    conv_code=2
  fi

  if [[ "${conv_status}" != "converged" && "${conv_status}" != "not_converged" && "${conv_status}" != "parse_error" ]]; then
    echo "[gate] ERROR: unknown draft gate status '${conv_status}' in ${conv_json}; forcing parse_error." >&2
    conv_status="parse_error"
    conv_code=2
  fi

  stage="draft_not_converged"
  gate_summary="draft_convergence:fail"
  if [[ "${conv_status}" == "converged" ]]; then
    stage="draft_converged"
    gate_summary="draft_convergence:ok"
  elif [[ "${conv_status}" == "parse_error" ]]; then
    stage="draft_convergence_error"
    gate_summary="draft_convergence:error"
  fi

  echo "[traj] stage=${stage}"
  python3 "${TRAJ}" --notes "${TEX}" --out-dir "${OUT_DIR}" --tag "${TAG}" --stage "${stage}" \
    --packet "${packet_path}" --member-a "${member_a_out}" --member-b "${member_b_out}" --member-c "${member_c_out}" --gate "${gate_summary}" >/dev/null 2>&1 || true

  if [[ -f "${PROJECT_INDEX_UPDATE_SCRIPT}" ]]; then
    python3 "${PROJECT_INDEX_UPDATE_SCRIPT}" --notes "${TEX}" --team-dir "${OUT_DIR}" --latest-kind draft --tag "${safe_tag}" --status "${stage}" --run-dir "${run_dir}" >/dev/null 2>&1 || true
  fi

  if [[ "${conv_status}" == "converged" ]]; then
    echo "[ok] draft cycle converged"
    exit 0
  fi
  if [[ "${conv_status}" == "parse_error" ]]; then
    echo "[fail] draft cycle convergence parse error: fix report format drift and rerun." >&2
    echo "[gate] Structured result: ${conv_json}" >&2
    exit 2
  fi
  echo "[fail] draft cycle not converged: revise and rerun with a new tag (e.g. D0-r2)." >&2
  exit "${conv_code}"
fi

echo "[ok] draft cycle complete"
