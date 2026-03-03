#!/usr/bin/env bash
set -euo pipefail

TAG=""
PACKET=""
OUT_DIR="" # default set later
NOTES=""

# Canonical naming is "Member A / Member B".
MEMBER_A_SYSTEM=""
MEMBER_B_SYSTEM=""

MEMBER_A_MODEL=""
MEMBER_B_MODEL=""

MEMBER_A_RUNNER_PATH=""
MEMBER_B_RUNNER_PATH=""

MEMBER_A_API_BASE_URL=""
MEMBER_A_API_KEY_ENV=""
MEMBER_B_API_BASE_URL=""
MEMBER_B_API_KEY_ENV=""

MEMBER_A_TOOL_ACCESS="restricted"
MEMBER_B_TOOL_ACCESS="restricted"
MEMBER_A_WORKSPACE_ID=""
MEMBER_B_WORKSPACE_ID=""
MEMBER_A_WORKSPACE_DIR=""
MEMBER_B_WORKSPACE_DIR=""

MEMBER_A_TOOLS=""
MEMBER_B_OUTPUT_FORMAT="text"
MEMBER_B_RUNNER_KIND=""
MEMBER_B_SYSTEM_CLAUDE=""
MEMBER_B_SYSTEM_CLAUDE_FROM_CONFIG=0
MEMBER_B_RUNNER_KIND_FROM_CLI=0
MEMBER_B_SYSTEM_CLAUDE_FROM_CLI=0
MEMBER_B_FALLBACK_MODE=""
MEMBER_B_FALLBACK_ORDER=""
MEMBER_B_FALLBACK_CLAUDE_MODEL=""
MEMBER_B_FALLBACK_CODEX_MODEL=""
MEMBER_B_FALLBACK_REASON=""
MEMBER_B_MODEL_EFFECTIVE=""

AUTO_TAG=0
RESOLVED_TAG=""

POINTER_IMPORT_CMD=""
PREFLIGHT_ONLY=0
SIDECAR_MODE="auto"
SIDECAR_TIMEOUT_OVERRIDE=""
SIDECAR_TIMEOUT_OVERRIDE_PROVIDED=0
RESUME=0

# RT-01: workflow mode (peer|leader|asymmetric)
WORKFLOW_MODE=""
WORKFLOW_MODE_FROM_CLI=0
BLIND_NUMERICS=0
CRITICAL_STEPS=""
MAX_STEP_RETRIES=3
REQUIRE_SWEEP=1  # default: require sweep_semantics=pass
IDEA_SOURCE=""
EXPORT_LEADS_TO=""

# Team-cycle runtime state (for audit + optional resume).
cycle_state_path=""
run_dir_abs=""
CYCLE_FINAL_STATUS=""
tmp_gemini_prompt=""
tmp_gemini_prompt_c=""
PROJECT_STAGE="development"
EXPLORATION_DEBT_MD=""
EXPLORATION_DEBT_JSONL=""
attempt_logs_dir=""
member_a_attempt_prefix=""
member_b_attempt_prefix=""

cleanup() {
  rm -f "${tmp_gemini_prompt:-}" "${tmp_gemini_prompt_c:-}" >/dev/null 2>&1 || true
  if declare -p sidecar_tmp_prompts >/dev/null 2>&1; then
    if [[ ${#sidecar_tmp_prompts[@]} -gt 0 ]]; then
      rm -f "${sidecar_tmp_prompts[@]}" >/dev/null 2>&1 || true
    fi
  fi
}

gemini_cli_healthy() {
  # Known environment issue: gemini CLI may exit 0 but return JSON with empty "response".
  # Health check must therefore validate the response is non-empty.
  if ! command -v gemini >/dev/null 2>&1; then
    return 1
  fi

  local resp=""
  local code=0
  set +e
  resp="$(
    gemini --output-format json --prompt "Hello" 2>/dev/null | \
      python3 -c 'import json,sys; print(json.load(sys.stdin).get("response",""))' 2>/dev/null
  )"
  code=$?
  set -e
  if [[ ${code} -ne 0 ]]; then
    return 1
  fi
  if [[ -z "${resp//[[:space:]]/}" ]]; then
    return 1
  fi
  return 0
}

member_report_healthy() {
  local path="${1:-}"
  if [[ -z "${path}" || ! -f "${path}" || ! -s "${path}" ]]; then
    return 1
  fi
  if ! grep -qiE '^##[[:space:]]+Verdict[[:space:]]*$' "${path}"; then
    return 1
  fi
  if ! grep -qiE '^##[[:space:]]+Sweep Semantics / Parameter Dependence[[:space:]]*$' "${path}"; then
    return 1
  fi
  return 0
}

codex_cli_available() {
  if ! command -v codex >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

choose_member_b_fallback_kind() {
  local reason="${1:-gemini_unavailable}"
  local mode="${MEMBER_B_FALLBACK_MODE:-auto}"
  local order="${MEMBER_B_FALLBACK_ORDER:-codex,claude}"

  if [[ "${mode}" == "off" ]]; then
    echo "[error] gemini unavailable (${reason}); fallback disabled (--member-b-fallback-mode=off)." >&2
    exit 2
  fi
  if [[ "${mode}" == "ask" ]]; then
    echo "[action_required] gemini unavailable (${reason}). Re-run with one of:" >&2
    echo "  --member-b-runner-kind claude" >&2
    echo "  --member-b-runner-kind codex" >&2
    echo "  --member-b-fallback-mode auto --member-b-fallback-order ${order}" >&2
    exit 4
  fi

  # auto
  IFS=',' read -r -a cands <<<"${order}"
  for cand in "${cands[@]}"; do
    c="$(echo "${cand}" | tr -d '[:space:]')"
    [[ -z "${c}" ]] && continue
    if [[ "${c}" == "codex" ]]; then
      # Codex runner is packet_only-only for now (full_access uses run_member_review.py which is claude/gemini only).
      if [[ "${REVIEW_ACCESS_MODE}" == "full_access" ]]; then
        continue
      fi
      if codex_cli_available; then
        echo "codex"
        return 0
      fi
      continue
    fi
    if [[ "${c}" == "claude" ]]; then
      echo "claude"
      return 0
    fi
  done

  # Last resort.
  echo "claude"
  return 0
}

should_warn_gate_in_exploration() {
  local gate="${1:-}"
  case "${gate}" in
    project_map_gate|agents_anchor_gate|notebook_integrity_gate|research_plan_gate|project_charter_gate|milestone_dod_gate|scan_dependency_gate|branch_semantics_gate|knowledge_layers_gate|literature_trace_gate|problem_framing_snapshot_gate|markdown_math_hygiene_gate|markdown_math_portability_gate|double_backslash_math_gate|markdown_link_hygiene_gate|latex_macro_hygiene_gate|references_gate|packet_completeness_gate|evidence_manifest_gate|claim_graph_gate|claim_trajectory_link_gate|pointer_lint_gate|evidence_schema_gate|clean_room_gate|logic_isolation_gate|independent_reproduction_gate|convention_mapping_gate)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

record_exploration_debt() {
  local gate="${1:-}"
  local exit_code="${2:-1}"
  local summary="${3:-}"

  if [[ "${PROJECT_STAGE}" != "exploration" ]]; then
    return 0
  fi
  if [[ -z "${EXPLORATION_DEBT_MD}" && -z "${EXPLORATION_DEBT_JSONL}" ]]; then
    return 0
  fi

  DEBT_GATE="${gate}" \
  DEBT_EXIT_CODE="${exit_code}" \
  DEBT_SUMMARY="${summary}" \
  DEBT_TAG="${RESOLVED_TAG:-${TAG:-}}" \
  DEBT_NOTES="${NOTEBOOK_PATH:-}" \
  DEBT_MD="${EXPLORATION_DEBT_MD}" \
  DEBT_JSONL="${EXPLORATION_DEBT_JSONL}" \
  python3 - <<'PY' || true
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


gate = os.environ.get("DEBT_GATE", "").strip()
exit_code = os.environ.get("DEBT_EXIT_CODE", "").strip()
summary = os.environ.get("DEBT_SUMMARY", "").strip()
tag = os.environ.get("DEBT_TAG", "").strip()
notes = os.environ.get("DEBT_NOTES", "").strip()
md_path = Path(os.environ.get("DEBT_MD", "").strip()) if os.environ.get("DEBT_MD", "").strip() else None
jsonl_path = Path(os.environ.get("DEBT_JSONL", "").strip()) if os.environ.get("DEBT_JSONL", "").strip() else None

try:
    exit_i = int(exit_code) if exit_code else 1
except Exception:
    exit_i = 1

payload = {
    "utc": now_utc(),
    "gate": gate,
    "exit_code": exit_i,
    "summary": summary,
    "tag": tag,
    "notes": notes,
    "status": "open",
}

if jsonl_path is not None:
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    with jsonl_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")

if md_path is not None:
    md_path.parent.mkdir(parents=True, exist_ok=True)
    if not md_path.exists():
        header = [
            "# Exploration Gate Debt",
            "",
            "This file is a checklist for exploration-stage (warn-only) gate failures.",
            "Mark an item as resolved by changing `- [ ]` to `- [x]` after you fix it.",
            "",
            f"- Tag: {tag}" if tag else "- Tag: (unknown)",
            f"- Notes: {notes}" if notes else "- Notes: (unknown)",
            f"- Created: {payload['utc']}",
            "",
            "Items:",
            "",
        ]
        md_path.write_text("\n".join(header), encoding="utf-8")
    with md_path.open("a", encoding="utf-8") as f:
        f.write(f"- [ ] {payload['utc']} gate={gate} exit_code={exit_i} :: {summary}\n")
PY
}

cycle_state_update() {
  local stage="${1:-}"
  local stage_status="${2:-}"
  local overall_status="${3:-}"
  local msg="${4:-}"

  if [[ -z "${cycle_state_path}" ]]; then
    return 0
  fi

  CYCLE_STAGE="${stage}" \
  CYCLE_STAGE_STATUS="${stage_status}" \
  CYCLE_STATUS="${overall_status}" \
  CYCLE_MSG="${msg}" \
  CYCLE_TAG="${TAG:-}" \
  CYCLE_RESOLVED_TAG="${RESOLVED_TAG:-}" \
  CYCLE_SAFE_TAG="${safe_tag:-}" \
  CYCLE_OUT_DIR="${OUT_DIR:-}" \
  CYCLE_RUN_DIR="${run_dir_abs:-}" \
  CYCLE_NOTES="${NOTEBOOK_PATH:-}" \
  CYCLE_PACKET_SRC="${PACKET:-}" \
  CYCLE_PACKET_FOR_RUN="${packet_for_run:-}" \
  CYCLE_POINTER_LINT_REPORT="${pointer_lint_report:-}" \
  CYCLE_MEMBER_A_OUT="${member_a_out:-}" \
  CYCLE_MEMBER_B_OUT="${member_b_out:-}" \
  CYCLE_MEMBER_C_OUT="${member_c_out:-}" \
  CYCLE_MEMBER_B_REQUESTED_KIND="${MEMBER_B_RUNNER_KIND:-}" \
  CYCLE_MEMBER_B_RESOLVED_KIND="${MEMBER_B_RUNNER_KIND_RESOLVED:-}" \
  CYCLE_MEMBER_B_FALLBACK_MODE="${MEMBER_B_FALLBACK_MODE:-}" \
  CYCLE_MEMBER_B_FALLBACK_ORDER="${MEMBER_B_FALLBACK_ORDER:-}" \
  CYCLE_MEMBER_B_FALLBACK_REASON="${MEMBER_B_FALLBACK_REASON:-}" \
  CYCLE_MEMBER_B_MODEL_REQUESTED="${MEMBER_B_MODEL:-}" \
  CYCLE_MEMBER_B_MODEL_EFFECTIVE="${MEMBER_B_MODEL_EFFECTIVE:-}" \
  CYCLE_WORKFLOW_MODE="${WORKFLOW_MODE:-}" \
  CYCLE_BLIND_NUMERICS="${BLIND_NUMERICS:-0}" \
  python3 - "${cycle_state_path}" <<'PY'
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


path = Path(os.environ.get("CYCLE_STATE_PATH", "")) if os.environ.get("CYCLE_STATE_PATH") else None
if path is None:
    # Back-compat: accept state path via argv (preferred in this integration).
    path = Path(__import__("sys").argv[1])

stage = os.environ.get("CYCLE_STAGE", "").strip()
stage_status = os.environ.get("CYCLE_STAGE_STATUS", "").strip()
overall_status = os.environ.get("CYCLE_STATUS", "").strip()
msg = os.environ.get("CYCLE_MSG", "").strip()

data: dict = {}
if path.exists():
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}

data.setdefault("version", 1)
data.setdefault("timestamps", {})
data["timestamps"]["last_update_utc"] = now_utc()

def set_if(k: str, v: str) -> None:
    if v:
        data[k] = v

set_if("tag", os.environ.get("CYCLE_TAG", "").strip())
set_if("resolved_tag", os.environ.get("CYCLE_RESOLVED_TAG", "").strip())
set_if("safe_tag", os.environ.get("CYCLE_SAFE_TAG", "").strip())
set_if("out_dir", os.environ.get("CYCLE_OUT_DIR", "").strip())
set_if("run_dir", os.environ.get("CYCLE_RUN_DIR", "").strip())
set_if("notes", os.environ.get("CYCLE_NOTES", "").strip())
set_if("packet_src", os.environ.get("CYCLE_PACKET_SRC", "").strip())
set_if("packet_for_run", os.environ.get("CYCLE_PACKET_FOR_RUN", "").strip())

runners = data.setdefault("runners", {})
if isinstance(runners, dict):
    mb = runners.setdefault("member_b", {})
    if isinstance(mb, dict):
        def set_mb_if(k: str, env_key: str) -> None:
            v = os.environ.get(env_key, "").strip()
            if v:
                mb[k] = v

        set_mb_if("requested_kind", "CYCLE_MEMBER_B_REQUESTED_KIND")
        set_mb_if("resolved_kind", "CYCLE_MEMBER_B_RESOLVED_KIND")
        set_mb_if("fallback_mode", "CYCLE_MEMBER_B_FALLBACK_MODE")
        set_mb_if("fallback_order", "CYCLE_MEMBER_B_FALLBACK_ORDER")
        set_mb_if("fallback_reason", "CYCLE_MEMBER_B_FALLBACK_REASON")
        set_mb_if("model_requested", "CYCLE_MEMBER_B_MODEL_REQUESTED")
        set_mb_if("model_effective", "CYCLE_MEMBER_B_MODEL_EFFECTIVE")

# RT-01: workflow_mode + blind_numerics
wm = os.environ.get("CYCLE_WORKFLOW_MODE", "").strip()
if wm:
    data["workflow_mode"] = wm
bn = os.environ.get("CYCLE_BLIND_NUMERICS", "").strip()
if bn == "1":
    data["blind_numerics"] = True

paths = data.setdefault("paths", {})
if isinstance(paths, dict):
    pl = os.environ.get("CYCLE_POINTER_LINT_REPORT", "").strip()
    if pl:
        paths["pointer_lint_report"] = pl
    a = os.environ.get("CYCLE_MEMBER_A_OUT", "").strip()
    b = os.environ.get("CYCLE_MEMBER_B_OUT", "").strip()
    c = os.environ.get("CYCLE_MEMBER_C_OUT", "").strip()
    if a:
        paths["member_a_report"] = a
    if b:
        paths["member_b_report"] = b
    if c:
        paths["member_c_report"] = c

stages = data.setdefault("stages", {})
if isinstance(stages, dict) and stage:
    stages[stage] = stage_status or "ok"
    data["timestamps"][f"{stage}_utc"] = now_utc()

if overall_status:
    data["status"] = overall_status
elif "status" not in data:
    data["status"] = "running"

if msg:
    msgs = data.setdefault("messages", [])
    if isinstance(msgs, list):
        msgs.append({"utc": now_utc(), "stage": stage, "msg": msg})

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
}

cycle_state_merge_attempt_logs() {
  local log_dir="${1:-}"
  if [[ -z "${cycle_state_path}" || -z "${log_dir}" ]]; then
    return 0
  fi
  if [[ ! -f "${cycle_state_path}" || ! -d "${log_dir}" ]]; then
    return 0
  fi

  CYCLE_STATE_PATH="${cycle_state_path}" \
  CYCLE_LOG_DIR="${log_dir}" \
  CYCLE_SAFE_TAG="${safe_tag:-}" \
  python3 - <<'PY' || true
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

state_path = Path(os.environ.get("CYCLE_STATE_PATH", "").strip())
log_dir = Path(os.environ.get("CYCLE_LOG_DIR", "").strip())
safe_tag = os.environ.get("CYCLE_SAFE_TAG", "").strip()

if not state_path.is_file() or not log_dir.is_dir():
    raise SystemExit(0)

try:
    data = json.loads(state_path.read_text(encoding="utf-8", errors="replace"))
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}

runners = data.setdefault("runners", {})
if not isinstance(runners, dict):
    runners = {}
    data["runners"] = runners

meta_pat = re.compile(r"^(?P<prefix>.+)attempt_(?P<idx>\d+)\.meta\.json$")
by_member: dict[str, list[dict]] = {"member_a": [], "member_b": [], "member_c": []}

for meta in sorted(log_dir.rglob("*attempt_*.meta.json")):
    m = meta_pat.match(meta.name)
    if not m:
        continue
    prefix = m.group("prefix")
    member = ""
    if safe_tag and prefix.startswith(f"{safe_tag}_member_a_"):
        member = "member_a"
    elif safe_tag and prefix.startswith(f"{safe_tag}_member_b_"):
        member = "member_b"
    elif safe_tag and prefix.startswith(f"{safe_tag}_member_c_"):
        member = "member_c"
    if not member:
        continue

    try:
        obj = json.loads(meta.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        obj = {}
    if not isinstance(obj, dict):
        obj = {}

    try:
        attempt_i = int(obj.get("attempt", m.group("idx")))
    except Exception:
        attempt_i = int(m.group("idx"))
    try:
        exit_i = int(obj.get("exit_code", 1))
    except Exception:
        exit_i = 1

    stderr_log = str(obj.get("stderr_log", "")).strip()
    if not stderr_log:
        stderr_log = str((log_dir / f"{prefix}attempt_{attempt_i:02d}.stderr.log").resolve())

    by_member[member].append(
        {
            "attempt": attempt_i,
            "exit_code": exit_i,
            "stderr_log": stderr_log,
        }
    )

def tail_excerpt(path_s: str, n: int = 20) -> str:
    p = Path(path_s)
    if not p.is_file():
        return ""
    try:
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return ""
    nonempty = [ln for ln in lines if ln.strip()]
    if not nonempty:
        return ""
    return "\n".join(nonempty[-n:])

for member, rows in by_member.items():
    if not rows:
        continue
    rows_sorted = sorted(rows, key=lambda x: int(x.get("attempt", 0)))
    failed = [x for x in rows_sorted if int(x.get("exit_code", 1)) != 0]

    md = runners.get(member, {})
    if not isinstance(md, dict):
        md = {}
    md["attempts_total"] = len(rows_sorted)
    md["failed_attempts"] = len(failed)
    if failed:
        last_fail = failed[-1]
        stderr_log = str(last_fail.get("stderr_log", ""))
        md["last_error_log"] = stderr_log
        md["last_error_excerpt"] = tail_excerpt(stderr_log, n=20)
    else:
        md["last_error_log"] = ""
        md["last_error_excerpt"] = ""
    runners[member] = md

fd, tmp_path = tempfile.mkstemp(prefix=".cycle_state.", suffix=".tmp", dir=str(state_path.parent))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2) + "\n")
    os.replace(tmp_path, state_path)
except Exception:
    try:
        os.unlink(tmp_path)
    except Exception:
        pass
    raise
PY
}

on_exit() {
  local code=$?
  local final_status="${CYCLE_FINAL_STATUS:-}"
  if [[ -z "${final_status}" ]]; then
    if [[ ${code} -eq 0 ]]; then
      final_status="completed"
    else
      final_status="error"
    fi
  fi
  cycle_state_update "end" "done" "${final_status}" "exit_code=${code}"
  cleanup
}

usage() {
  cat <<'EOF'
run_team_cycle.sh

Run a research-team cycle with two independent team members (Member A + Member B):
  - Member A (Claude runner): uses a system prompt file + the team packet as the user prompt
  - Member B (default: Gemini runner): prepends a system prompt file to the team packet (Gemini runner is prompt-only)
    - Use --member-b-runner-kind claude|codex to run Member B via the Claude/Codex runner instead.
    - Default Gemini runner fallback is the skill's `assets/run_gemini.sh` (preferred over the external gemini-cli-runner).

Fail-fast preflight gates (BEFORE calling any LLMs):
- Reproducibility Capsule gate (required)
- Scan dependency gate (required when applicable)
- Branch semantics / multi-root gate (required when applicable)
- Pointer-lint gate (required)

Mandatory convergence gate (AFTER both members produce reports):
- exits non-zero if the two reports do not converge (mismatch/fail/needs revision).

Usage:
  run_team_cycle.sh --tag TAG --packet PACKET.txt [--out-dir team] \
    --member-a-system SYS_MEMBER_A.txt --member-b-system SYS_MEMBER_B.txt

  # Alternative (no manual packet): build team packet from the notebook automatically
  run_team_cycle.sh --tag TAG --notes Draft_Derivation.md [--out-dir team] \
    --member-a-system SYS_MEMBER_A.txt --member-b-system SYS_MEMBER_B.txt

Options:
  --out-dir DIR               Optional. Output directory (default: team).
  --auto-tag                  Optional. Auto-pick the next clean round tag (<base>-rN) by scanning --out-dir.
                              Also auto-enabled when TAG is malformed like M3-r1-r1-r1 (prevents tag explosion).
  --notes PATH                Optional. Primary notebook path. If provided and --packet is omitted, the script
                              auto-builds a team packet (and enforces all preflight gates).
  --member-a-system PATH      Required. Member A system prompt file.
  --member-b-system PATH      Required. Member B system prompt file.
  --member-b-runner-kind KIND Optional. gemini|claude|codex|auto (default: config member_b.runner_kind or gemini).
  --member-b-system-claude PATH Optional. Alternate system prompt file to use when Member B runner kind is claude/codex.
  --member-b-fallback-mode MODE Optional. off|ask|auto (default: auto). Controls what happens when gemini is unavailable/fails.
  --member-b-fallback-order LIST Optional. Comma-separated fallbacks when MODE=auto (default: codex,claude).
  --member-b-fallback-claude-model MODEL Optional. Default: sonnet.
  --member-b-fallback-codex-model MODEL Optional. Default: Codex CLI config default.
  --member-a-runner PATH      Optional (override Claude runner path)
  --member-b-runner PATH      Optional (override Gemini runner path)
  --member-a-api-base-url URL Optional. API base URL for member A runner (e.g. for self-hosted LLMs).
  --member-a-api-key-env VAR  Optional. Env var NAME holding member A's API key (never pass the key value directly).
  --member-b-api-base-url URL Optional. API base URL for member B runner.
  --member-b-api-key-env VAR  Optional. Env var NAME holding member B's API key.
  --member-a-tool-access MODE Optional. restricted|full (default: restricted). full enables MCP tools + audit log.
  --member-b-tool-access MODE Optional. restricted|full (default: restricted).
  --member-a-model MODEL      Optional (default: runner's default)
  --member-b-model MODEL      Optional
  --member-a-tools TOOLS      Optional (e.g. "default"; runner default disables tools)
  --member-b-output-format FMT Optional (default: text)
  --pointer-import-cmd CMD    Optional. Python command used for code-pointer import checks in the notebook.
                              If omitted, pointer lint auto-detects from env var / environment.yml / .venv.
  --preflight-only            Optional. Run all deterministic preflight gates + build/patch the packet,
                              then exit 0 BEFORE calling any external LLM runners.
  --resume                   Optional. If member report files already exist under the resolved run directory,
                              reuse them and skip rerunning the corresponding external LLM(s).
  --sidecar                  Optional. Force-enable the numerics-only sidecar reviewer.
  --no-sidecar               Optional. Disable the numerics-only sidecar reviewer.
  --sidecar-timeout SECS     Optional. Override `sidecar_review.timeout_secs` / `sidecar_reviews[].timeout_secs` (0 disables timeout).

EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --packet) PACKET="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --member-a-system) MEMBER_A_SYSTEM="${2:-}"; shift 2 ;;
    --member-b-system) MEMBER_B_SYSTEM="${2:-}"; shift 2 ;;
    --member-b-runner-kind) MEMBER_B_RUNNER_KIND="${2:-}"; MEMBER_B_RUNNER_KIND_FROM_CLI=1; shift 2 ;;
    --member-b-system-claude) MEMBER_B_SYSTEM_CLAUDE="${2:-}"; MEMBER_B_SYSTEM_CLAUDE_FROM_CLI=1; shift 2 ;;
    --member-b-fallback-mode) MEMBER_B_FALLBACK_MODE="${2:-}"; shift 2 ;;
    --member-b-fallback-order) MEMBER_B_FALLBACK_ORDER="${2:-}"; shift 2 ;;
    --member-b-fallback-claude-model) MEMBER_B_FALLBACK_CLAUDE_MODEL="${2:-}"; shift 2 ;;
    --member-b-fallback-codex-model) MEMBER_B_FALLBACK_CODEX_MODEL="${2:-}"; shift 2 ;;
    --member-a-model) MEMBER_A_MODEL="${2:-}"; shift 2 ;;
    --member-b-model) MEMBER_B_MODEL="${2:-}"; shift 2 ;;
    --member-a-runner) MEMBER_A_RUNNER_PATH="${2:-}"; shift 2 ;;
    --member-b-runner) MEMBER_B_RUNNER_PATH="${2:-}"; shift 2 ;;
    --member-a-api-base-url) MEMBER_A_API_BASE_URL="${2:-}"; shift 2 ;;
    --member-a-api-key-env)  MEMBER_A_API_KEY_ENV="${2:-}"; shift 2 ;;
    --member-b-api-base-url) MEMBER_B_API_BASE_URL="${2:-}"; shift 2 ;;
    --member-b-api-key-env)  MEMBER_B_API_KEY_ENV="${2:-}"; shift 2 ;;
    --member-a-tool-access)  MEMBER_A_TOOL_ACCESS="${2:-restricted}"; shift 2 ;;
    --member-b-tool-access)  MEMBER_B_TOOL_ACCESS="${2:-restricted}"; shift 2 ;;
    --api-key) echo "ERROR: --api-key plaintext is forbidden. Use --member-X-api-key-env <ENV_VAR_NAME> instead." >&2; exit 2 ;;
    --member-a-tools) MEMBER_A_TOOLS="${2:-}"; shift 2 ;;
    --member-b-output-format) MEMBER_B_OUTPUT_FORMAT="${2:-}"; shift 2 ;;
    --pointer-import-cmd) POINTER_IMPORT_CMD="${2:-}"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --resume) RESUME=1; shift ;;
    --sidecar) SIDECAR_MODE="force_on"; shift ;;
    --no-sidecar) SIDECAR_MODE="force_off"; shift ;;
    --workflow-mode) WORKFLOW_MODE="${2:-}"; WORKFLOW_MODE_FROM_CLI=1; shift 2 ;;
    --blind-numerics) BLIND_NUMERICS=1; shift ;;
    --critical-steps) CRITICAL_STEPS="${2:-}"; shift 2 ;;
    --max-step-retries) MAX_STEP_RETRIES="${2:-3}"; shift 2 ;;
    --require-sweep) REQUIRE_SWEEP=1; shift ;;
    --no-require-sweep) REQUIRE_SWEEP=0; shift ;;
    --idea-source) IDEA_SOURCE="${2:-}"; shift 2 ;;
    --export-leads-to) EXPORT_LEADS_TO="${2:-}"; shift 2 ;;
    --sidecar-timeout)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --sidecar-timeout requires a value" >&2
        exit 2
      fi
      SIDECAR_TIMEOUT_OVERRIDE_PROVIDED=1
      SIDECAR_TIMEOUT_OVERRIDE="$2"
      shift 2
      ;;
    --auto-tag) AUTO_TAG=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${OUT_DIR}" ]]; then
  OUT_DIR="team"
fi

if [[ ${SIDECAR_TIMEOUT_OVERRIDE_PROVIDED} -eq 1 ]]; then
  case "${SIDECAR_TIMEOUT_OVERRIDE}" in
    ""|*[!0-9]*)
      echo "ERROR: --sidecar-timeout must be a non-negative integer (seconds): ${SIDECAR_TIMEOUT_OVERRIDE}" >&2
      exit 2
      ;;
  esac
fi

if [[ -z "${TAG}" || -z "${MEMBER_A_SYSTEM}" || -z "${MEMBER_B_SYSTEM}" ]]; then
  echo "ERROR: --tag, --member-a-system, --member-b-system are required" >&2
  usage
  exit 2
fi
if [[ -n "${MEMBER_B_RUNNER_KIND}" ]]; then
  case "${MEMBER_B_RUNNER_KIND}" in
    gemini|claude|codex|auto) ;;
    *)
      echo "ERROR: invalid --member-b-runner-kind: ${MEMBER_B_RUNNER_KIND}" >&2
      echo "  allowed: gemini|claude|codex|auto" >&2
      exit 2
      ;;
  esac
fi

if [[ -z "${MEMBER_B_FALLBACK_MODE}" ]]; then
  MEMBER_B_FALLBACK_MODE="auto"
fi
case "${MEMBER_B_FALLBACK_MODE}" in
  off|ask|auto) ;;
  *)
    echo "ERROR: invalid --member-b-fallback-mode: ${MEMBER_B_FALLBACK_MODE}" >&2
    echo "  allowed: off|ask|auto" >&2
    exit 2
    ;;
esac
if [[ -z "${MEMBER_B_FALLBACK_ORDER}" ]]; then
  MEMBER_B_FALLBACK_ORDER="codex,claude"
fi
if [[ -z "${MEMBER_B_FALLBACK_CLAUDE_MODEL}" ]]; then
  MEMBER_B_FALLBACK_CLAUDE_MODEL="sonnet"
fi

# RT-01: Workflow mode resolution.
# Priority: --workflow-mode CLI > config workflow_mode > "leader" (default).
if [[ ${WORKFLOW_MODE_FROM_CLI} -eq 0 ]]; then
  # Will be resolved from config after config is loaded; for now set default.
  if [[ -z "${WORKFLOW_MODE}" ]]; then
    WORKFLOW_MODE="leader"
  fi
fi
if [[ -n "${WORKFLOW_MODE}" ]]; then
  case "${WORKFLOW_MODE}" in
    peer|leader|asymmetric) ;;
    *)
      echo "ERROR: invalid --workflow-mode: ${WORKFLOW_MODE}" >&2
      echo "  allowed: peer|leader|asymmetric" >&2
      exit 2
      ;;
  esac
fi
# --blind-numerics implies asymmetric if no explicit --workflow-mode
if [[ ${BLIND_NUMERICS} -eq 1 && ${WORKFLOW_MODE_FROM_CLI} -eq 0 ]]; then
  WORKFLOW_MODE="asymmetric"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILL_ROOT="$(cd "${SCRIPTS_DIR}/.." && pwd)"
SKILLS_DIR="$(cd "${SKILL_ROOT}/.." && pwd)"
GATES_DIR="${SCRIPTS_DIR}/gates"

CAPSULE_CHECK_SCRIPT="${GATES_DIR}/check_reproducibility_capsule.py"
PLAN_GATE_SCRIPT="${GATES_DIR}/check_research_plan.py"
PROJECT_CHARTER_GATE_SCRIPT="${GATES_DIR}/check_project_charter.py"
PROJECT_MAP_GATE_SCRIPT="${GATES_DIR}/check_project_map.py"
HEP_WORKSPACE_GATE_SCRIPT="${GATES_DIR}/check_hep_workspace.py"
AGENTS_ANCHOR_GATE_SCRIPT="${GATES_DIR}/check_agents_anchor.py"
MILESTONE_DOD_GATE_SCRIPT="${GATES_DIR}/check_milestone_dod.py"
SCAN_DEP_CHECK_SCRIPT="${GATES_DIR}/check_scan_dependency.py"
BRANCH_GATE_SCRIPT="${GATES_DIR}/check_branch_completeness.py"
KB_GATE_SCRIPT="${GATES_DIR}/check_knowledge_layers.py"
LIT_TRACE_GATE_SCRIPT="${GATES_DIR}/check_literature_trace.py"
PROBLEM_FRAMING_GATE_SCRIPT="${GATES_DIR}/check_problem_framing_snapshot.py"
REFS_GATE_SCRIPT="${GATES_DIR}/check_references_section.py"
NOTEBOOK_INTEGRITY_SCRIPT="${GATES_DIR}/check_notebook_integrity.py"
DEBT_GATE_SCRIPT="${GATES_DIR}/check_exploration_debt.py"
MD_MATH_HYGIENE_GATE_SCRIPT="${GATES_DIR}/check_markdown_math_hygiene.py"
MD_MATH_PORTABILITY_GATE_SCRIPT="${GATES_DIR}/check_markdown_math_portability.py"
DBS_MATH_GATE_SCRIPT="${GATES_DIR}/check_double_backslash_math.py"
MD_LINK_HYGIENE_GATE_SCRIPT="${GATES_DIR}/check_markdown_link_hygiene.py"
LATEX_MACRO_HYGIENE_GATE_SCRIPT="${GATES_DIR}/check_markdown_latex_macro_hygiene.py"
PLAN_UPDATE_SCRIPT="${SCRIPT_DIR}/update_research_plan_progress.py"
CLAIM_AUTO_SCRIPT="${SCRIPT_DIR}/auto_enable_claim_gates.py"
CLAIM_RENDER_SCRIPT="${SCRIPT_DIR}/render_claim_graph.py"
PACKET_COMPLETENESS_SCRIPT="${GATES_DIR}/check_packet_completeness.py"
PACKET_BUILD_SCRIPT="${SCRIPT_DIR}/build_team_packet.py"
TRAJ_SCRIPT="${SCRIPT_DIR}/update_trajectory_index.py"
EXTRACT_NOTEBOOK_FROM_PACKET_SCRIPT="${SCRIPT_DIR}/team_cycle_extract_primary_notebook.py"
FIND_CONFIG_PATH_SCRIPT="${SCRIPT_DIR}/team_cycle_find_config_path.py"
AUTOFILL_ENABLED_SCRIPT="${SCRIPT_DIR}/team_cycle_autofill_enabled.py"
PATCH_PACKET_SCRIPT="${SCRIPT_DIR}/team_cycle_patch_packet.py"
SIDECAR_PROBE_SCRIPT="${SCRIPT_DIR}/team_cycle_sidecar_probe.py"
NEXT_TAG_SCRIPT="${SCRIPT_DIR}/next_team_tag.py"
PROJECT_MAP_UPDATE_SCRIPT="${SCRIPT_DIR}/update_project_map.py"
TEAM_CONFIG_FILE=""
NOTEBOOK_PATH=""
safe_tag=""
run_dir=""

# If no packet is provided, build one from --notes.
if [[ -z "${PACKET}" ]]; then
  if [[ -z "${NOTES}" ]]; then
    echo "ERROR: either --packet or --notes must be provided" >&2
    exit 2
  fi
  if [[ ! -f "${NOTES}" ]]; then
    echo "ERROR: notes not found: ${NOTES}" >&2
    exit 2
  fi
  if [[ ! -f "${PACKET_BUILD_SCRIPT}" ]]; then
    echo "ERROR: missing packet builder: ${PACKET_BUILD_SCRIPT}" >&2
    exit 2
  fi
fi

# Preflight: require a complete Reproducibility Capsule before running any external tools.
if [[ -f "${CAPSULE_CHECK_SCRIPT}" ]]; then
  if [[ -n "${NOTES}" ]]; then
    NOTEBOOK_PATH="${NOTES}"
  else
    NOTEBOOK_PATH="$(python3 "${EXTRACT_NOTEBOOK_FROM_PACKET_SCRIPT}" --packet "${PACKET}")"
  fi

  if [[ -z "${NOTEBOOK_PATH}" ]]; then
    echo "ERROR: team packet missing required line: 'Primary notebook: <path>'" >&2
    exit 2
  fi
  if [[ ! -f "${NOTEBOOK_PATH}" ]]; then
    echo "ERROR: Primary notebook not found: ${NOTEBOOK_PATH}" >&2
    exit 2
  fi

  # If a project-level config exists, export it so all gates use the same config.
  TEAM_CONFIG_FILE="$(python3 "${FIND_CONFIG_PATH_SCRIPT}" --notes "${NOTEBOOK_PATH}")"
  if [[ -n "${TEAM_CONFIG_FILE}" ]]; then
    export RESEARCH_TEAM_CONFIG="${TEAM_CONFIG_FILE}"
  fi

  set +e
  python3 "${CAPSULE_CHECK_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  cap_code=$?
  set -e
  if [[ ${cap_code} -ne 0 ]]; then
    echo "" >&2
    echo "[gate] Fail-fast: Reproducibility Capsule incomplete. Fix the capsule in ${NOTEBOOK_PATH} before running the team cycle." >&2
    exit ${cap_code}
  fi
else
  echo "ERROR: missing capsule check script: ${CAPSULE_CHECK_SCRIPT}" >&2
  exit 2
fi

# Resolve tag early so all downstream gates/logs use a single consistent tag.
# (Also avoids generating both TAG and RESOLVED_TAG packet files.)
if [[ "${TAG}" =~ -r[0-9]+-r[0-9]+ ]]; then
  AUTO_TAG=1
fi

RESOLVED_TAG="${TAG}"
if [[ "${AUTO_TAG}" -eq 1 ]]; then
  if [[ ! -f "${NEXT_TAG_SCRIPT}" ]]; then
    echo "ERROR: --auto-tag requires: ${NEXT_TAG_SCRIPT}" >&2
    exit 2
  fi
  RESOLVED_TAG="$(python3 "${NEXT_TAG_SCRIPT}" --tag "${TAG}" --out-dir "${OUT_DIR}")"
fi

safe_tag="$(echo "${RESOLVED_TAG}" | sed -E 's/[^A-Za-z0-9._-]+/_/g')"
run_dir="${OUT_DIR}/runs/${safe_tag}"
mkdir -p "${run_dir}"
run_dir_abs="$(cd "${run_dir}" && pwd)"
attempt_logs_dir="${run_dir}/logs"
# Per-member subdirs isolate attempt logs so deny_other_outputs can revoke cross-member access.
mkdir -p "${attempt_logs_dir}" "${attempt_logs_dir}/member_a" "${attempt_logs_dir}/member_b" >/dev/null 2>&1 || true
member_a_attempt_prefix="${safe_tag}_member_a_"
member_b_attempt_prefix="${safe_tag}_member_b_"
cycle_state_path="${run_dir}/cycle_state.json"
cycle_state_update "init" "done" "running" ""
trap on_exit EXIT

# Ensure PROJECT_MAP.md exists early (warn-only). This is a usability affordance, not part of the scientific gates.
if [[ -f "${PROJECT_MAP_UPDATE_SCRIPT}" ]]; then
  python3 "${PROJECT_MAP_UPDATE_SCRIPT}" --notes "${NOTEBOOK_PATH}" --team-dir "${OUT_DIR}" --latest-kind team --tag "${RESOLVED_TAG}" --status "preflight_init" >/dev/null 2>&1 || true
fi
cycle_state_update "preflight_init" "done" "running" ""

PROJECT_STAGE="$(python3 "${SCRIPT_DIR}/team_cycle_get_project_stage.py" --notes "${NOTEBOOK_PATH}")"
if [[ "${PROJECT_STAGE}" == "exploration" ]]; then
  EXPLORATION_DEBT_MD="${run_dir}/${safe_tag}_exploration_debt.md"
  EXPLORATION_DEBT_JSONL="${run_dir}/${safe_tag}_exploration_debt.jsonl"
  echo "[info] Project stage=exploration: selected preflight gates are warn-only; debt will be recorded at ${EXPLORATION_DEBT_MD}" >&2
fi

# Review settings (packet-only vs full-access via proxy).
REVIEW_ACCESS_MODE="packet_only"
ISOLATION_STRATEGY="separate_worktrees"
REVIEW_SETTINGS_SCRIPT="${SCRIPT_DIR}/team_cycle_get_review_settings.py"
if [[ -f "${REVIEW_SETTINGS_SCRIPT}" ]]; then
  read -r REVIEW_ACCESS_MODE ISOLATION_STRATEGY CONFIG_WORKFLOW_MODE <<<"$(python3 "${REVIEW_SETTINGS_SCRIPT}" --notes "${NOTEBOOK_PATH}" 2>/dev/null || echo "packet_only separate_worktrees ")"
  # RT-01: resolve workflow_mode from config if not set via CLI
  if [[ ${WORKFLOW_MODE_FROM_CLI} -eq 0 && -n "${CONFIG_WORKFLOW_MODE}" ]]; then
    WORKFLOW_MODE="${CONFIG_WORKFLOW_MODE}"
  fi
fi

# Member B runner settings (config-based defaults; CLI overrides).
MEMBER_B_SETTINGS_SCRIPT="${SCRIPT_DIR}/team_cycle_get_member_b_runner.py"
CONFIG_MEMBER_B_KIND="gemini"
CONFIG_MEMBER_B_CLAUDE_SYSTEM=""
if [[ -f "${MEMBER_B_SETTINGS_SCRIPT}" ]]; then
  IFS=$'\t' read -r CONFIG_MEMBER_B_KIND CONFIG_MEMBER_B_CLAUDE_SYSTEM <<<"$(python3 "${MEMBER_B_SETTINGS_SCRIPT}" --notes "${NOTEBOOK_PATH}" 2>/dev/null || printf 'gemini\t')"
fi
if [[ ${MEMBER_B_RUNNER_KIND_FROM_CLI} -ne 1 ]]; then
  MEMBER_B_RUNNER_KIND="${CONFIG_MEMBER_B_KIND:-gemini}"
fi
if [[ ${MEMBER_B_SYSTEM_CLAUDE_FROM_CLI} -ne 1 && -z "${MEMBER_B_SYSTEM_CLAUDE}" && -n "${CONFIG_MEMBER_B_CLAUDE_SYSTEM}" ]]; then
  MEMBER_B_SYSTEM_CLAUDE="${CONFIG_MEMBER_B_CLAUDE_SYSTEM}"
  MEMBER_B_SYSTEM_CLAUDE_FROM_CONFIG=1
fi
if [[ -z "${MEMBER_B_RUNNER_KIND}" ]]; then
  MEMBER_B_RUNNER_KIND="gemini"
fi
MEMBER_B_RUNNER_KIND_RESOLVED="${MEMBER_B_RUNNER_KIND}"
if [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "auto" ]]; then
  # Resolved later after probing gemini availability (see member runner selection).
  MEMBER_B_RUNNER_KIND_RESOLVED="gemini"
fi

if [[ "${REVIEW_ACCESS_MODE}" == "full_access" && "${MEMBER_B_RUNNER_KIND}" == "codex" ]]; then
  echo "ERROR: --member-b-runner-kind=codex is not supported in full_access mode. Use gemini|claude (or runner-kind=auto)." >&2
  exit 2
fi

if [[ "${PROJECT_STAGE}" != "exploration" && -f "${DEBT_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${DEBT_GATE_SCRIPT}" --team-dir "${OUT_DIR}"
  debt_code=$?
  set -e
  if [[ ${debt_code} -ne 0 ]]; then
    echo "" >&2
    echo "[gate] Fail-fast: exploration debt still open. Close items in ${OUT_DIR}/runs/*/*_exploration_debt.md (mark '- [ ]' -> '- [x]') or set project_stage=exploration." >&2
    exit ${debt_code}
  fi
fi

# Preflight: PROJECT_MAP.md navigation gate.
if [[ -f "${PROJECT_MAP_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${PROJECT_MAP_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  pm_code=$?
  set -e
  if [[ ${pm_code} -ne 0 ]]; then
    echo "" >&2
    if [[ "${PROJECT_STAGE}" == "exploration" && ${pm_code} -ne 2 ]] && should_warn_gate_in_exploration "project_map_gate"; then
      echo "[warn] (exploration) project map gate failed; continuing. Fill PROJECT_MAP.md before switching to development." >&2
      record_exploration_debt "project_map_gate" "${pm_code}" "project map gate failed (PROJECT_MAP.md missing/invalid)"
    else
      echo "[gate] Fail-fast: project map gate failed. Ensure PROJECT_MAP.md exists and links to the canonical docs + team pointers." >&2
      exit ${pm_code}
    fi
  fi
fi

# Preflight: hep-research-mcp workspace bootstrap gate (.hep/workspace.json).
if [[ -f "${HEP_WORKSPACE_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${HEP_WORKSPACE_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  hep_ws_code=$?
  set -e
  if [[ ${hep_ws_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${hep_ws_code} -eq 2 ]]; then
      echo "[error] hep workspace gate errored (input/config). Fix .hep/workspace.json and rerun." >&2
      exit ${hep_ws_code}
    fi
    echo "[gate] Fail-fast: hep workspace gate failed. Create/fix .hep/workspace.json before running the team cycle." >&2
    exit ${hep_ws_code}
  fi
fi

# Preflight: AGENTS.md anchor gate (reduces workflow amnesia across restarts).
if [[ -f "${AGENTS_ANCHOR_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${AGENTS_ANCHOR_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  agents_code=$?
  set -e
  if [[ ${agents_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${agents_code} -eq 2 ]]; then
      echo "[error] AGENTS.md anchor gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${agents_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "agents_anchor_gate"; then
      echo "[warn] (exploration) AGENTS.md anchor gate failed; continuing. Add/update AGENTS.md before switching to development." >&2
      record_exploration_debt "agents_anchor_gate" "${agents_code}" "AGENTS.md anchor missing/invalid"
    else
      echo "[gate] Fail-fast: AGENTS.md anchor missing/invalid. Add/update AGENTS.md before running the team cycle." >&2
      exit ${agents_code}
    fi
  fi
fi

# Preflight: notebook integrity gate (structure + math hygiene; deterministic).
if [[ -f "${NOTEBOOK_INTEGRITY_SCRIPT}" ]]; then
  set +e
  python3 "${NOTEBOOK_INTEGRITY_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  nb_code=$?
  set -e
  if [[ ${nb_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${nb_code} -eq 2 ]]; then
      echo "[error] notebook integrity gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${nb_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "notebook_integrity_gate"; then
      echo "[warn] (exploration) notebook integrity check failed; continuing. Fix marker/math/structure issues before switching to development." >&2
      record_exploration_debt "notebook_integrity_gate" "${nb_code}" "notebook integrity check failed"
    else
      echo "[gate] Fail-fast: notebook integrity check failed. Fix marker blocks / math formatting / structure issues before running the team cycle." >&2
      exit ${nb_code}
    fi
  fi
fi

# Preflight: research plan gate (prevents running with template plans).
if [[ -f "${PLAN_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${PLAN_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  plan_code=$?
  set -e
  if [[ ${plan_code} -ne 0 ]]; then
    AUTO_FILL_SCRIPT="${SCRIPT_DIR}/auto_fill_research_plan.py"
    AUTO_FILL_ENABLED="0"
    if [[ -f "${AUTO_FILL_SCRIPT}" ]]; then
      AUTO_FILL_ENABLED="$(python3 "${AUTOFILL_ENABLED_SCRIPT}" --notes "${NOTEBOOK_PATH}")"
    fi

    if [[ "${AUTO_FILL_ENABLED}" == "1" && -f "${AUTO_FILL_SCRIPT}" ]]; then
      echo "[info] research plan gate failed; attempting deterministic auto-fill of RESEARCH_PLAN.md" >&2
      AUTO_ROOT=""
      if [[ -n "${TEAM_CONFIG_FILE}" ]]; then
        AUTO_ROOT="$(cd "$(dirname "${TEAM_CONFIG_FILE}")" && pwd)"
      else
        AUTO_ROOT="$(cd "$(dirname "${NOTEBOOK_PATH}")" && pwd)"
      fi
      set +e
      python3 "${AUTO_FILL_SCRIPT}" --root "${AUTO_ROOT}" --deterministic
      fill_code=$?
      set -e
      if [[ ${fill_code} -eq 0 ]]; then
        set +e
        python3 "${PLAN_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
        plan_code=$?
        set -e
      fi
    fi

    if [[ ${plan_code} -ne 0 ]]; then
      echo "" >&2
      if [[ ${plan_code} -eq 2 ]]; then
        echo "[error] research plan gate errored (input/config). Fix the config/paths and rerun." >&2
        exit ${plan_code}
      fi
      if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "research_plan_gate"; then
        echo "[warn] (exploration) research plan check failed; continuing. Fill RESEARCH_PLAN.md before switching to development." >&2
        record_exploration_debt "research_plan_gate" "${plan_code}" "research plan check failed (RESEARCH_PLAN.md incomplete/template)"
      else
        echo "[gate] Fail-fast: research plan check failed. Fill RESEARCH_PLAN.md (or run auto-fill) before running the team cycle." >&2
        exit ${plan_code}
      fi
    fi
  fi
fi

# Preflight: project charter gate (goal hierarchy + profile explicitness; prevents goal drift).
if [[ -f "${PROJECT_CHARTER_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${PROJECT_CHARTER_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  charter_code=$?
  set -e
  if [[ ${charter_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${charter_code} -eq 2 ]]; then
      echo "[error] project charter gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${charter_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "project_charter_gate"; then
      echo "[warn] (exploration) project charter check failed; continuing. Fill/approve PROJECT_CHARTER.md before switching to development." >&2
      record_exploration_debt "project_charter_gate" "${charter_code}" "project charter check failed (PROJECT_CHARTER.md status/fields incomplete)"
    else
      echo "[gate] Fail-fast: project charter check failed. Fill/approve PROJECT_CHARTER.md before running the team cycle." >&2
      exit ${charter_code}
    fi
  fi
fi

# Preflight: milestone DoD gate (prevents purely ceremonial acceptance criteria).
if [[ -f "${MILESTONE_DOD_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${MILESTONE_DOD_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}" --tag "${TAG}"
  dod_code=$?
  set -e
  if [[ ${dod_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${dod_code} -eq 2 ]]; then
      echo "[error] milestone DoD gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${dod_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "milestone_dod_gate"; then
      echo "[warn] (exploration) milestone DoD check failed; continuing. Make Deliverables/Acceptance concrete before switching to development." >&2
      record_exploration_debt "milestone_dod_gate" "${dod_code}" "milestone DoD check failed (acceptance criteria too vague/template)"
    else
      echo "[gate] Fail-fast: milestone DoD check failed. Make Deliverables/Acceptance concrete in RESEARCH_PLAN.md before running the team cycle." >&2
      exit ${dod_code}
    fi
  fi
fi

# Preflight: parameter-scan dependency check (designed to be non-blocking when not applicable).
if [[ -f "${SCAN_DEP_CHECK_SCRIPT}" ]]; then
  set +e
  python3 "${SCAN_DEP_CHECK_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  scan_code=$?
  set -e
  if [[ ${scan_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${scan_code} -eq 2 ]]; then
      echo "[error] scan dependency gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${scan_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "scan_dependency_gate"; then
      echo "[warn] (exploration) scan dependency check failed; continuing. Fix scan semantics/artifacts before switching to development." >&2
      record_exploration_debt "scan_dependency_gate" "${scan_code}" "scan dependency check failed"
    else
      echo "[gate] Fail-fast: scan dependency check failed. Fix scan semantics/artifacts before running the team cycle." >&2
      exit ${scan_code}
    fi
  fi
fi

# Preflight: multi-root / multi-branch contract gate (prevents semantically wrong uncertainty bands).
if [[ -f "${BRANCH_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${BRANCH_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  branch_code=$?
  set -e
  if [[ ${branch_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${branch_code} -eq 2 ]]; then
      echo "[error] branch semantics gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${branch_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "branch_semantics_gate"; then
      echo "[warn] (exploration) branch completeness check failed; continuing. Fix branch semantics before switching to development." >&2
      record_exploration_debt "branch_semantics_gate" "${branch_code}" "branch completeness check failed (multi-root/branch contract incomplete)"
    else
      echo "[gate] Fail-fast: branch completeness check failed. Fix branch semantics (inventory/assignment/outputs/invariants/diagnostics) before running the team cycle." >&2
      exit ${branch_code}
    fi
  fi
fi

# Preflight: knowledge layers gate (domain-neutral).
if [[ -f "${KB_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${KB_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  kb_code=$?
  set -e
  if [[ ${kb_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${kb_code} -eq 2 ]]; then
      echo "[error] knowledge layers gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${kb_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "knowledge_layers_gate"; then
      echo "[warn] (exploration) knowledge layers check failed; continuing. Add missing knowledge_base layers before switching to development." >&2
      record_exploration_debt "knowledge_layers_gate" "${kb_code}" "knowledge layers check failed (knowledge_base incomplete/missing links)"
    else
      echo "[gate] Fail-fast: knowledge layers check failed. Add missing knowledge_base layers and capsule references before running the team cycle." >&2
      exit ${kb_code}
    fi
  fi
fi

# Preflight: literature discovery trace gate (query -> selection log).
if [[ -f "${LIT_TRACE_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${LIT_TRACE_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  lt_code=$?
  set -e
  if [[ ${lt_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${lt_code} -eq 2 ]]; then
      echo "[error] literature trace gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${lt_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "literature_trace_gate"; then
      echo "[warn] (exploration) literature trace check failed; continuing. Log queries/selection before switching to development." >&2
      record_exploration_debt "literature_trace_gate" "${lt_code}" "literature query trace missing/empty"
    else
      echo "[gate] Fail-fast: literature trace check failed. Add at least one row to knowledge_base/methodology_traces/literature_queries.md before running the team cycle." >&2
      exit ${lt_code}
    fi
  fi
fi

# Preflight: Problem Framing Snapshot gate (PREWORK.md; prevents "mechanisms shelfware").
if [[ -f "${PROBLEM_FRAMING_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${PROBLEM_FRAMING_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  problem_framing_code=$?
  set -e
  if [[ ${problem_framing_code} -ne 0 ]]; then
    # Deterministic auto-fill hook (no external LLM calls).
    AUTO_FILL_SCRIPT="${SCRIPT_DIR}/auto_fill_prework.py"
    AUTO_FILL_ENABLED="0"
    if [[ -f "${AUTO_FILL_SCRIPT}" ]]; then
      AUTO_FILL_ENABLED="$(python3 "${AUTOFILL_ENABLED_SCRIPT}" --notes "${NOTEBOOK_PATH}")"
    fi

    if [[ "${AUTO_FILL_ENABLED}" == "1" && -f "${AUTO_FILL_SCRIPT}" ]]; then
      echo "[info] problem framing snapshot gate failed; attempting deterministic auto-fill of PREWORK.md" >&2
      AUTO_ROOT=""
      if [[ -n "${TEAM_CONFIG_FILE}" ]]; then
        AUTO_ROOT="$(cd "$(dirname "${TEAM_CONFIG_FILE}")" && pwd)"
      else
        AUTO_ROOT="$(cd "$(dirname "${NOTEBOOK_PATH}")" && pwd)"
      fi
      set +e
      python3 "${AUTO_FILL_SCRIPT}" --root "${AUTO_ROOT}" --deterministic
      fill_code=$?
      set -e
      if [[ ${fill_code} -eq 0 ]]; then
        set +e
        python3 "${PROBLEM_FRAMING_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
        problem_framing_code=$?
        set -e
      fi
    fi

    if [[ ${problem_framing_code} -ne 0 ]]; then
      echo "" >&2
      if [[ ${problem_framing_code} -eq 2 ]]; then
        echo "[error] Problem Framing Snapshot gate errored (input/config). Fix the config/paths and rerun." >&2
        exit ${problem_framing_code}
      fi
      if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "problem_framing_snapshot_gate"; then
        echo "[warn] (exploration) Problem Framing Snapshot check failed; continuing. Fill PREWORK.md before switching to development." >&2
        record_exploration_debt "problem_framing_snapshot_gate" "${problem_framing_code}" "Problem Framing Snapshot check failed (PREWORK.md incomplete/template)"
      else
        echo "[gate] Fail-fast: Problem Framing Snapshot check failed. Fill PREWORK.md (or run auto-fill) before running the team cycle." >&2
        exit ${problem_framing_code}
      fi
    fi
  fi
fi

# Preflight: global double-backslash math gate (key docs + knowledge_base).
# Runs after deterministic auto-fills (RESEARCH_PLAN / PREWORK) and before other Markdown hygiene gates.
if [[ -f "${DBS_MATH_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${DBS_MATH_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  dbs_code=$?
  set -e
  if [[ ${dbs_code} -ne 0 ]]; then
    # Deterministic auto-fix hook (no external LLM calls).
    AUTO_FIX_SCRIPT="${SCRIPT_DIR}/fix_markdown_double_backslash_math.py"
    AUTO_FIX_ENABLED="0"
    if [[ -f "${AUTO_FIX_SCRIPT}" ]]; then
      AUTO_FIX_ENABLED="$(python3 "${AUTOFILL_ENABLED_SCRIPT}" --notes "${NOTEBOOK_PATH}")"
    fi
    if [[ "${AUTO_FIX_ENABLED}" == "1" && -f "${AUTO_FIX_SCRIPT}" ]]; then
      echo "[info] double-backslash math gate failed; attempting deterministic autofix of key Markdown targets" >&2
      set +e
      python3 "${AUTO_FIX_SCRIPT}" --notes "${NOTEBOOK_PATH}" --in-place
      fix_code=$?
      set -e
      if [[ ${fix_code} -eq 0 ]]; then
        set +e
        python3 "${DBS_MATH_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
        dbs_code=$?
        set -e
      fi
    fi

    if [[ ${dbs_code} -ne 0 ]]; then
      echo "" >&2
      if [[ ${dbs_code} -eq 2 ]]; then
        echo "[error] double-backslash math gate errored (input/config). Fix the config/paths and rerun." >&2
        exit ${dbs_code}
      fi
      if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "double_backslash_math_gate"; then
        echo "[warn] (exploration) double-backslash math check failed; continuing. Fix accidental '\\\\' escapes before switching to development." >&2
        record_exploration_debt "double_backslash_math_gate" "${dbs_code}" "double-backslash escapes found in Markdown math regions"
      else
        echo "[gate] Fail-fast: double-backslash math check failed. Fix accidental '\\\\' escapes in Markdown math (or run fix_markdown_double_backslash_math.py) before running the team cycle." >&2
        exit ${dbs_code}
      fi
    fi
  fi
fi

# Preflight: global Markdown math hygiene gate (key docs + knowledge_base).
# Runs after any deterministic auto-fills (RESEARCH_PLAN / PREWORK) to validate final text.
if [[ -f "${MD_MATH_HYGIENE_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${MD_MATH_HYGIENE_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  mmh_code=$?
  set -e
  if [[ ${mmh_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${mmh_code} -eq 2 ]]; then
      echo "[error] markdown math hygiene gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${mmh_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "markdown_math_hygiene_gate"; then
      echo "[warn] (exploration) markdown math hygiene check failed; continuing. Fix math formatting before switching to development." >&2
      record_exploration_debt "markdown_math_hygiene_gate" "${mmh_code}" "markdown math hygiene check failed"
    else
      echo "[gate] Fail-fast: markdown math hygiene check failed. Fix display-math formatting (or run fix_markdown_math_hygiene.py) before running the team cycle." >&2
      exit ${mmh_code}
    fi
  fi
fi

# Preflight: Markdown math portability warnings (renderer-safe; warn-only by default).
if [[ -f "${MD_MATH_PORTABILITY_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${MD_MATH_PORTABILITY_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  mmp_code=$?
  set -e
  if [[ ${mmp_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${mmp_code} -eq 2 ]]; then
      echo "[error] markdown math portability gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${mmp_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "markdown_math_portability_gate"; then
      echo "[warn] (exploration) markdown math portability check failed; continuing. Fix Markdown math portability issues before switching to development." >&2
      record_exploration_debt "markdown_math_portability_gate" "${mmp_code}" "markdown math portability check failed"
    else
      echo "[gate] Fail-fast: markdown math portability check failed. Fix portability issues (see warnings) before running the team cycle." >&2
      exit ${mmp_code}
    fi
  fi
fi

# Preflight: LaTeX macro hygiene gate for Markdown (key docs + knowledge_base).
if [[ -f "${LATEX_MACRO_HYGIENE_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${LATEX_MACRO_HYGIENE_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  lmh_code=$?
  set -e
  if [[ ${lmh_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${lmh_code} -eq 2 ]]; then
      echo "[error] LaTeX macro hygiene gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${lmh_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "latex_macro_hygiene_gate"; then
      echo "[warn] (exploration) LaTeX macro hygiene check failed; continuing. Expand custom macros before switching to development." >&2
      record_exploration_debt "latex_macro_hygiene_gate" "${lmh_code}" "LaTeX macro hygiene check failed"
    else
      echo "[gate] Fail-fast: LaTeX macro hygiene check failed. Expand custom LaTeX macros (or run fix_markdown_latex_macros.py) before running the team cycle." >&2
      exit ${lmh_code}
    fi
  fi
fi

# Preflight: global Markdown link hygiene gate (key docs + knowledge_base).
if [[ -f "${MD_LINK_HYGIENE_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${MD_LINK_HYGIENE_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  mlh_code=$?
  set -e
  if [[ ${mlh_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${mlh_code} -eq 2 ]]; then
      echo "[error] markdown link hygiene gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${mlh_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "markdown_link_hygiene_gate"; then
      echo "[warn] (exploration) markdown link hygiene check failed; continuing. Fix Markdown links before switching to development." >&2
      record_exploration_debt "markdown_link_hygiene_gate" "${mlh_code}" "markdown link hygiene check failed"
    else
      echo "[gate] Fail-fast: markdown link hygiene check failed. Use Markdown links for file/KB pointers (or run fix_markdown_link_hygiene.py) before running the team cycle." >&2
      exit ${mlh_code}
    fi
  fi
fi

# Preflight: references gate (main document references section).
if [[ -f "${REFS_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${REFS_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  ref_code=$?
  set -e
  if [[ ${ref_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${ref_code} -eq 2 ]]; then
      echo "[error] references gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${ref_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "references_gate"; then
      echo "[warn] (exploration) references check failed; continuing. Add/update the References section before switching to development." >&2
      record_exploration_debt "references_gate" "${ref_code}" "references check failed (References section missing/incomplete or external host not allowed)"
    else
      echo "[gate] Fail-fast: references check failed. Add/update the References section before running the team cycle." >&2
      exit ${ref_code}
    fi
  fi
fi

# Preflight: Claim DAG / Evidence gates (optional; controlled by research_team_config.json).
EVIDENCE_MANIFEST_GATE_SCRIPT="${GATES_DIR}/check_evidence_manifest.py"
CLAIM_GRAPH_GATE_SCRIPT="${GATES_DIR}/check_claim_graph.py"
CLAIM_TRAJ_LINK_GATE_SCRIPT="${GATES_DIR}/check_claim_trajectory_link.py"

if [[ -f "${EVIDENCE_MANIFEST_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${EVIDENCE_MANIFEST_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  ev_code=$?
  set -e
  if [[ ${ev_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${ev_code} -eq 2 ]]; then
      echo "[error] evidence manifest gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${ev_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "evidence_manifest_gate"; then
      echo "[warn] (exploration) evidence manifest check failed; continuing. Fix evidence_manifest.jsonl before switching to development." >&2
      record_exploration_debt "evidence_manifest_gate" "${ev_code}" "evidence manifest check failed"
    else
      echo "[gate] Fail-fast: evidence manifest check failed. Fix knowledge_graph/evidence_manifest.jsonl (or disable evidence_manifest_gate) before running the team cycle." >&2
      exit ${ev_code}
    fi
  fi
fi

if [[ -f "${CLAIM_GRAPH_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${CLAIM_GRAPH_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  cg_code=$?
  set -e
  if [[ ${cg_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${cg_code} -eq 2 ]]; then
      echo "[error] claim graph gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${cg_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "claim_graph_gate"; then
      echo "[warn] (exploration) claim graph check failed; continuing. Fix claims.jsonl/edges.jsonl before switching to development." >&2
      record_exploration_debt "claim_graph_gate" "${cg_code}" "claim graph check failed"
    else
      echo "[gate] Fail-fast: claim graph check failed. Fix knowledge_graph/claims.jsonl and knowledge_graph/edges.jsonl (or disable claim_graph_gate) before running the team cycle." >&2
      exit ${cg_code}
    fi
  fi
fi

if [[ -f "${CLAIM_TRAJ_LINK_GATE_SCRIPT}" ]]; then
  set +e
  python3 "${CLAIM_TRAJ_LINK_GATE_SCRIPT}" --notes "${NOTEBOOK_PATH}" --current-tag "${RESOLVED_TAG}"
  ct_code=$?
  set -e
  if [[ ${ct_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${ct_code} -eq 2 ]]; then
      echo "[error] claim↔trajectory link gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${ct_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "claim_trajectory_link_gate"; then
      echo "[warn] (exploration) claim↔trajectory link check failed; continuing. Fix linked_trajectories before switching to development." >&2
      record_exploration_debt "claim_trajectory_link_gate" "${ct_code}" "claim↔trajectory link check failed"
    else
      echo "[gate] Fail-fast: claim↔trajectory link check failed. Fix claims.jsonl linked_trajectories or generate missing tags (or disable claim_trajectory_link_gate) before running the team cycle." >&2
      exit ${ct_code}
    fi
  fi
fi

if [[ -z "${PACKET}" ]]; then
  mkdir -p "${run_dir}"
  PACKET="${run_dir}/team_packet_${safe_tag}.txt"
  build_args=( --tag "${RESOLVED_TAG}" --notes "${NOTEBOOK_PATH}" --out "${PACKET}" )
  if [[ -n "${POINTER_IMPORT_CMD}" ]]; then
    build_args+=( --pointer-import-cmd "${POINTER_IMPORT_CMD}" )
  fi
  adjudication_path="${run_dir}/${safe_tag}_adjudication.md"
  if [[ -f "${adjudication_path}" ]]; then
    build_args+=( --adjudication "${adjudication_path}" )
  elif [[ -f "${OUT_DIR}/${safe_tag}_adjudication.md" ]]; then
    # Back-compat fallback (if a project still keeps adjudication notes at the team root).
    build_args+=( --adjudication "${OUT_DIR}/${safe_tag}_adjudication.md" )
  fi
  # RT-01: pass workflow-mode and related flags
  if [[ -n "${WORKFLOW_MODE}" ]]; then
    build_args+=( --workflow-mode "${WORKFLOW_MODE}" )
  fi
  if [[ -n "${CRITICAL_STEPS}" ]]; then
    build_args+=( --critical-steps "${CRITICAL_STEPS}" )
  fi
  if [[ ${BLIND_NUMERICS} -eq 1 ]]; then
    build_args+=( --blind-numerics )
  fi
  # RT-04: idea-source and export-leads
  if [[ -n "${IDEA_SOURCE}" ]]; then
    build_args+=( --idea-source "${IDEA_SOURCE}" )
  fi
  if [[ -n "${EXPORT_LEADS_TO}" ]]; then
    build_args+=( --export-leads-to "${EXPORT_LEADS_TO}" )
  fi
  python3 "${PACKET_BUILD_SCRIPT}" "${build_args[@]}"
fi

if [[ ! -f "${PACKET}" ]]; then
  echo "ERROR: packet not found: ${PACKET}" >&2
  exit 2
fi
if [[ -f "${PACKET_COMPLETENESS_SCRIPT}" ]]; then
  set +e
  python3 "${PACKET_COMPLETENESS_SCRIPT}" --notes "${NOTEBOOK_PATH}" --packet "${PACKET}"
  pc_code=$?
  set -e
  if [[ ${pc_code} -ne 0 ]]; then
    echo "" >&2
    if [[ ${pc_code} -eq 2 ]]; then
      echo "[error] packet completeness gate errored (input/config). Fix the config/paths and rerun." >&2
      exit ${pc_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "packet_completeness_gate"; then
      echo "[warn] (exploration) packet completeness check failed; continuing. Fill required packet sections before switching to development." >&2
      record_exploration_debt "packet_completeness_gate" "${pc_code}" "packet completeness check failed"
    else
      echo "[gate] Fail-fast: packet completeness check failed. Fill required packet sections before running the team cycle." >&2
      exit ${pc_code}
    fi
  fi
fi
if [[ ! -f "${MEMBER_A_SYSTEM}" ]]; then
  echo "ERROR: Member A system prompt not found: ${MEMBER_A_SYSTEM}" >&2
  exit 2
fi
if [[ ! -f "${MEMBER_B_SYSTEM}" ]]; then
  echo "ERROR: Member B system prompt not found: ${MEMBER_B_SYSTEM}" >&2
  exit 2
fi

PROJECT_ROOT=""
if [[ -n "${TEAM_CONFIG_FILE}" ]]; then
  PROJECT_ROOT="$(cd "$(dirname "${TEAM_CONFIG_FILE}")" && pwd)"
else
  PROJECT_ROOT="$(cd "$(dirname "${NOTEBOOK_PATH}")" && pwd)"
fi

# Resolve optional config-relative Member B Claude system prompt.
if [[ "${MEMBER_B_SYSTEM_CLAUDE_FROM_CONFIG}" -eq 1 && -n "${MEMBER_B_SYSTEM_CLAUDE}" && "${MEMBER_B_SYSTEM_CLAUDE}" != /* ]]; then
  MEMBER_B_SYSTEM_CLAUDE="${PROJECT_ROOT}/${MEMBER_B_SYSTEM_CLAUDE}"
fi

LOCAL_CLAUDE_RUNNER="${PROJECT_ROOT}/scripts/run_claude.sh"
LOCAL_GEMINI_RUNNER="${PROJECT_ROOT}/scripts/run_gemini.sh"
LOCAL_CODEX_RUNNER="${PROJECT_ROOT}/scripts/run_codex.sh"

if [[ -z "${MEMBER_A_RUNNER_PATH}" && -f "${LOCAL_CLAUDE_RUNNER}" ]]; then
  MEMBER_A_RUNNER="${LOCAL_CLAUDE_RUNNER}"
else
  MEMBER_A_RUNNER="${MEMBER_A_RUNNER_PATH:-${SKILLS_DIR}/claude-cli-runner/scripts/run_claude.sh}"
fi

if [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "claude" ]]; then
  if [[ -z "${MEMBER_B_RUNNER_PATH}" && -f "${LOCAL_CLAUDE_RUNNER}" ]]; then
    MEMBER_B_RUNNER="${LOCAL_CLAUDE_RUNNER}"
  else
    MEMBER_B_RUNNER="${MEMBER_B_RUNNER_PATH:-${SKILLS_DIR}/claude-cli-runner/scripts/run_claude.sh}"
  fi
elif [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "codex" ]]; then
  if [[ -z "${MEMBER_B_RUNNER_PATH}" && -f "${LOCAL_CODEX_RUNNER}" ]]; then
    MEMBER_B_RUNNER="${LOCAL_CODEX_RUNNER}"
  else
    INTERNAL_CODEX_RUNNER="${SKILL_ROOT}/assets/run_codex.sh"
    MEMBER_B_RUNNER="${MEMBER_B_RUNNER_PATH:-${INTERNAL_CODEX_RUNNER}}"
  fi
else
  if [[ -z "${MEMBER_B_RUNNER_PATH}" && -f "${LOCAL_GEMINI_RUNNER}" ]]; then
    MEMBER_B_RUNNER="${LOCAL_GEMINI_RUNNER}"
  else
    INTERNAL_GEMINI_RUNNER="${SKILL_ROOT}/assets/run_gemini.sh"
    if [[ -f "${INTERNAL_GEMINI_RUNNER}" ]]; then
      MEMBER_B_RUNNER="${MEMBER_B_RUNNER_PATH:-${INTERNAL_GEMINI_RUNNER}}"
    else
      MEMBER_B_RUNNER="${MEMBER_B_RUNNER_PATH:-${SKILLS_DIR}/gemini-cli-runner/scripts/run_gemini.sh}"
    fi
  fi
fi

if [[ ! -f "${MEMBER_A_RUNNER}" ]]; then
  echo "ERROR: Member A runner not found: ${MEMBER_A_RUNNER}" >&2
  exit 2
fi
if [[ ! -f "${MEMBER_B_RUNNER}" ]]; then
  echo "ERROR: Member B runner not found: ${MEMBER_B_RUNNER}" >&2
  exit 2
fi

MEMBER_B_SYSTEM_EFFECTIVE="${MEMBER_B_SYSTEM}"
if [[ ( "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "claude" || "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "codex" ) && -n "${MEMBER_B_SYSTEM_CLAUDE}" ]]; then
  if [[ -f "${MEMBER_B_SYSTEM_CLAUDE}" ]]; then
    MEMBER_B_SYSTEM_EFFECTIVE="${MEMBER_B_SYSTEM_CLAUDE}"
  else
    echo "[warn] member-b claude system prompt not found; using --member-b-system instead: ${MEMBER_B_SYSTEM_CLAUDE}" >&2
  fi
fi

mkdir -p "${run_dir}"
run_dir_abs="$(cd "${run_dir}" && pwd)"

# Validate and set up tool-access / workspace isolation.
case "${MEMBER_A_TOOL_ACCESS}" in
  restricted|full) ;;
  *) echo "ERROR: invalid --member-a-tool-access: ${MEMBER_A_TOOL_ACCESS} (allowed: restricted|full)" >&2; exit 2 ;;
esac
case "${MEMBER_B_TOOL_ACCESS}" in
  restricted|full) ;;
  *) echo "ERROR: invalid --member-b-tool-access: ${MEMBER_B_TOOL_ACCESS} (allowed: restricted|full)" >&2; exit 2 ;;
esac

if [[ "${REVIEW_ACCESS_MODE}" == "full_access" || "${MEMBER_A_TOOL_ACCESS}" == "full" || "${MEMBER_B_TOOL_ACCESS}" == "full" ]]; then
  _ws_lib="${SCRIPTS_DIR}/lib"
  MEMBER_A_WORKSPACE_ID="$(python3 -c "import sys; sys.path.insert(0,'${_ws_lib}'); from workspace_isolator import generate_workspace_id; print(generate_workspace_id())")"
  MEMBER_B_WORKSPACE_ID="$(python3 -c "import sys; sys.path.insert(0,'${_ws_lib}'); from workspace_isolator import generate_workspace_id; print(generate_workspace_id())")"
  MEMBER_A_WORKSPACE_DIR="$(python3 -c "import sys; sys.path.insert(0,'${_ws_lib}'); from workspace_isolator import create_isolated_workspace; from pathlib import Path; print(create_isolated_workspace(Path('${run_dir}'), 'member_a', '${MEMBER_A_WORKSPACE_ID}'))")"
  MEMBER_B_WORKSPACE_DIR="$(python3 -c "import sys; sys.path.insert(0,'${_ws_lib}'); from workspace_isolator import create_isolated_workspace; from pathlib import Path; print(create_isolated_workspace(Path('${run_dir}'), 'member_b', '${MEMBER_B_WORKSPACE_ID}'))")"
  echo "[info] workspace isolation: member-a=${MEMBER_A_WORKSPACE_ID} (${MEMBER_A_WORKSPACE_DIR})" >&2
  echo "[info] workspace isolation: member-b=${MEMBER_B_WORKSPACE_ID} (${MEMBER_B_WORKSPACE_DIR})" >&2
fi

if [[ -f "${TRAJ_SCRIPT}" ]]; then
  python3 "${TRAJ_SCRIPT}" --notes "${NOTEBOOK_PATH}" --out-dir "${OUT_DIR}" --tag "${RESOLVED_TAG}" --stage "preflight_start" --packet "${PACKET}" >/dev/null 2>&1 || true
fi

POINTER_LINT_SCRIPT="${GATES_DIR}/check_pointer_lint.py"
pointer_lint_report="${run_dir}/${safe_tag}_pointer_lint.md"
if [[ ! -f "${POINTER_LINT_SCRIPT}" ]]; then
  echo "ERROR: missing pointer lint script: ${POINTER_LINT_SCRIPT}" >&2
  exit 2
fi

set +e
if [[ -n "${POINTER_IMPORT_CMD}" ]]; then
  python3 "${POINTER_LINT_SCRIPT}" --notes "${NOTEBOOK_PATH}" --import-cmd "${POINTER_IMPORT_CMD}" >"${pointer_lint_report}"
else
  python3 "${POINTER_LINT_SCRIPT}" --notes "${NOTEBOOK_PATH}" >"${pointer_lint_report}"
fi
pl_code=$?
set -e
if [[ ${pl_code} -ne 0 ]]; then
  echo "" >&2
  echo "Report: ${pointer_lint_report}" >&2
  echo "" >&2
  sed -n '1,160p' "${pointer_lint_report}" >&2 || true
  if [[ ${pl_code} -eq 2 ]]; then
    echo "[error] pointer lint gate errored (input/config). Fix the config/paths and rerun." >&2
    exit ${pl_code}
  fi
  if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "pointer_lint_gate"; then
    echo "[warn] (exploration) pointer lint failed; continuing. Fix notebook code pointers before switching to development." >&2
    record_exploration_debt "pointer_lint_gate" "${pl_code}" "pointer lint failed (see pointer lint report)"
    cycle_state_update "pointer_lint_warn" "done" "running" "pointer_lint_exit=${pl_code}"
  else
    echo "[gate] Fail-fast: pointer lint failed. Fix notebook code pointers and rerun the team cycle." >&2
    exit ${pl_code}
  fi
fi
if [[ ${pl_code} -eq 0 ]]; then
  cycle_state_update "pointer_lint_ok" "done" "running" ""
fi

member_a_out="${run_dir}/${safe_tag}_member_a.md"
member_b_out="${run_dir}/${safe_tag}_member_b.md"
member_c_out=""
member_c_pid=""
member_c_timeout_secs="0"
sidecar_outs=()
sidecar_pids=()
sidecar_timeouts=()
sidecar_tmp_prompts=()

kill_process_tree() {
  local pid="${1:-}"
  local sig="${2:-15}"
  if [[ -z "${pid}" ]]; then
    return 0
  fi

  if command -v pgrep >/dev/null 2>&1; then
    local children=""
    children="$(pgrep -P "${pid}" 2>/dev/null || true)"
    local child=""
    for child in ${children}; do
      kill_process_tree "${child}" "${sig}"
    done
  fi

  kill -"${sig}" "${pid}" >/dev/null 2>&1 || true
  return 0
}

finalize_sidecar() {
  local pid="${1:-}"
  local timeout_secs="${2:-0}"
  local tag="${3:-unknown}"
  if [[ -z "${pid}" ]]; then
    return 0
  fi
  if ! kill -0 "${pid}" >/dev/null 2>&1; then
    return 0
  fi

  case "${timeout_secs}" in
    ""|*[!0-9]*) timeout_secs=0 ;;
  esac

  local killer_pid=""
  local timeout_flag=""
  if [[ ${timeout_secs} -gt 0 ]]; then
    # IPC flag between main process and killer subshell:
    # create unique path, pre-delete it, then touch it in the killer if the timeout fires.
    timeout_flag="$(mktemp 2>/dev/null || true)"
    if [[ -z "${timeout_flag}" ]]; then
      echo "[warn] finalize_sidecar: mktemp unavailable; timeout tracking disabled (tag=${tag}, pid=${pid})." >&2
      timeout_flag=""
    else
      rm -f "${timeout_flag}" || true
    fi
    (
      set +e
      sleep "${timeout_secs}"
      if kill -0 "${pid}" >/dev/null 2>&1; then
        echo "[warn] sidecar timeout after ${timeout_secs}s (tag=${tag}, pid=${pid}); terminating." >&2
        if [[ -n "${timeout_flag}" ]]; then
          touch "${timeout_flag}" 2>/dev/null || true
        fi
        kill_process_tree "${pid}" 15
        sleep 2
        if kill -0 "${pid}" >/dev/null 2>&1; then
          kill_process_tree "${pid}" 9
        fi
      fi
    ) &
    killer_pid=$!
  fi

  local code=0
  set +e
  wait "${pid}"
  code=$?
  set -e

  if [[ -n "${killer_pid}" ]]; then
    kill -15 "${killer_pid}" >/dev/null 2>&1 || true
    wait "${killer_pid}" >/dev/null 2>&1 || true
  fi

  if [[ -n "${timeout_flag}" ]]; then
    if [[ -f "${timeout_flag}" ]]; then
      rm -f "${timeout_flag}" || true
      return 0
    fi
    rm -f "${timeout_flag}" || true
  fi

  if [[ ${code} -ne 0 ]]; then
    echo "[warn] sidecar review failed (member-c=${code})." >&2
  fi
  return 0
}

cleanup_sidecar_tmp_prompts() {
  if [[ ${#sidecar_tmp_prompts[@]} -gt 0 ]]; then
    rm -f "${sidecar_tmp_prompts[@]}" >/dev/null 2>&1 || true
    sidecar_tmp_prompts=()
  fi
  return 0
}

finalize_all_sidecars() {
  local tag="${1:-unknown}"
  local quiet="${2:-0}"
  local i pid timeout_secs
  if [[ ${#sidecar_pids[@]} -eq 0 ]]; then
    cleanup_sidecar_tmp_prompts
    return 0
  fi
  for i in "${!sidecar_pids[@]}"; do
    pid="${sidecar_pids[$i]:-}"
    timeout_secs="${sidecar_timeouts[$i]:-0}"
    if [[ -z "${pid}" ]]; then
      continue
    fi
    if [[ "${quiet}" == "1" ]]; then
      finalize_sidecar "${pid}" "${timeout_secs}" "${tag}" >/dev/null 2>&1 || true
    else
      finalize_sidecar "${pid}" "${timeout_secs}" "${tag}"
    fi
  done
  cleanup_sidecar_tmp_prompts
  return 0
}

# Patch a copy of the packet for traceability:
# - Tag line is updated to RESOLVED_TAG
# - If present, the pointer-lint preflight section is refreshed
packet_for_run="${PACKET}"
packet_for_run="${run_dir}/team_packet_${safe_tag}.txt"
python3 "${PATCH_PACKET_SCRIPT}" --src "${PACKET}" --dst "${packet_for_run}" --tag "${RESOLVED_TAG}" --pointer-lint-report "${pointer_lint_report}"

if [[ -f "${TRAJ_SCRIPT}" ]]; then
  python3 "${TRAJ_SCRIPT}" --notes "${NOTEBOOK_PATH}" --out-dir "${OUT_DIR}" --tag "${RESOLVED_TAG}" --stage "preflight_ok" --packet "${packet_for_run}" --gate "preflight_ok" >/dev/null 2>&1 || true
fi

if [[ -f "${PROJECT_MAP_UPDATE_SCRIPT}" ]]; then
  python3 "${PROJECT_MAP_UPDATE_SCRIPT}" --notes "${NOTEBOOK_PATH}" --team-dir "${OUT_DIR}" --tag "${RESOLVED_TAG}" --status "preflight_ok" --run-dir "${run_dir_abs}" >/dev/null 2>&1 || true
fi
cycle_state_update "preflight_ok" "done" "running" ""

if [[ "${PREFLIGHT_ONLY}" -eq 1 ]]; then
  CYCLE_FINAL_STATUS="preflight_only"
  cycle_state_update "preflight_only" "done" "${CYCLE_FINAL_STATUS}" ""
  if [[ "${PROJECT_STAGE}" == "exploration" && -n "${EXPLORATION_DEBT_MD}" && -f "${EXPLORATION_DEBT_MD}" ]]; then
    echo "[ok] preflight-only (exploration): packet ready: ${packet_for_run} (gate debt: ${EXPLORATION_DEBT_MD})"
  else
    echo "[ok] preflight-only: gates passed; packet ready: ${packet_for_run}"
  fi
  exit 0
fi

# Resolve Member B runner kind only when we are about to run external runners.
# (preflight-only must remain independent of local LLM CLI availability.)
MEMBER_B_FALLBACK_REASON=""
MEMBER_B_MODEL_EFFECTIVE="${MEMBER_B_MODEL:-}"

if [[ "${MEMBER_B_RUNNER_KIND}" == "claude" ]]; then
  MEMBER_B_RUNNER_KIND_RESOLVED="claude"
elif [[ "${MEMBER_B_RUNNER_KIND}" == "codex" ]]; then
  MEMBER_B_RUNNER_KIND_RESOLVED="codex"
elif [[ "${MEMBER_B_RUNNER_KIND}" == "auto" ]]; then
  MEMBER_B_RUNNER_KIND_RESOLVED="gemini"
  if [[ -z "${MEMBER_B_RUNNER_PATH}" ]]; then
    if ! gemini_cli_healthy; then
      MEMBER_B_FALLBACK_REASON="gemini_unhealthy"
      MEMBER_B_RUNNER_KIND_RESOLVED="$(choose_member_b_fallback_kind "${MEMBER_B_FALLBACK_REASON}")"
      echo "[warn] gemini appears unavailable (empty/invalid JSON response); auto-falling back to ${MEMBER_B_RUNNER_KIND_RESOLVED} for member-b." >&2
    fi
  fi
else
  # gemini (default)
  MEMBER_B_RUNNER_KIND_RESOLVED="gemini"
  if [[ -z "${MEMBER_B_RUNNER_PATH}" ]]; then
    if ! gemini_cli_healthy; then
      MEMBER_B_FALLBACK_REASON="gemini_unhealthy"
      MEMBER_B_RUNNER_KIND_RESOLVED="$(choose_member_b_fallback_kind "${MEMBER_B_FALLBACK_REASON}")"
      echo "[warn] gemini appears unavailable (empty/invalid JSON response); falling back to ${MEMBER_B_RUNNER_KIND_RESOLVED} for member-b." >&2
    fi
  fi
fi

if [[ -n "${MEMBER_B_FALLBACK_REASON}" ]]; then
  if [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "claude" ]]; then
    MEMBER_B_MODEL_EFFECTIVE="${MEMBER_B_FALLBACK_CLAUDE_MODEL}"
  elif [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "codex" ]]; then
    MEMBER_B_MODEL_EFFECTIVE="${MEMBER_B_FALLBACK_CODEX_MODEL}"
  fi
fi

# If we fell back to claude and no explicit --member-b-runner was provided, switch runner path accordingly.
if [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "claude" && -z "${MEMBER_B_RUNNER_PATH}" ]]; then
  if [[ -f "${LOCAL_CLAUDE_RUNNER}" ]]; then
    MEMBER_B_RUNNER="${LOCAL_CLAUDE_RUNNER}"
  else
    MEMBER_B_RUNNER="${SKILLS_DIR}/claude-cli-runner/scripts/run_claude.sh"
  fi
  if [[ ! -f "${MEMBER_B_RUNNER}" ]]; then
    echo "ERROR: Member B claude runner not found after fallback: ${MEMBER_B_RUNNER}" >&2
    exit 2
  fi
fi

# If we fell back to codex and no explicit --member-b-runner was provided, switch runner path accordingly.
if [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "codex" && -z "${MEMBER_B_RUNNER_PATH}" ]]; then
  if [[ -f "${LOCAL_CODEX_RUNNER}" ]]; then
    MEMBER_B_RUNNER="${LOCAL_CODEX_RUNNER}"
  else
    INTERNAL_CODEX_RUNNER="${SKILL_ROOT}/assets/run_codex.sh"
    MEMBER_B_RUNNER="${INTERNAL_CODEX_RUNNER}"
  fi
  if [[ ! -f "${MEMBER_B_RUNNER}" ]]; then
    echo "ERROR: Member B codex runner not found after fallback: ${MEMBER_B_RUNNER}" >&2
    exit 2
  fi
fi

# Recompute effective system prompt now that runner kind is finalized.
MEMBER_B_SYSTEM_EFFECTIVE="${MEMBER_B_SYSTEM}"
if [[ ( "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "claude" || "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "codex" ) && -n "${MEMBER_B_SYSTEM_CLAUDE}" ]]; then
  if [[ -f "${MEMBER_B_SYSTEM_CLAUDE}" ]]; then
    MEMBER_B_SYSTEM_EFFECTIVE="${MEMBER_B_SYSTEM_CLAUDE}"
  else
    echo "[warn] member-b claude system prompt not found; using --member-b-system instead: ${MEMBER_B_SYSTEM_CLAUDE}" >&2
  fi
fi

cycle_state_update "member_runners_start" "running" "running" ""

echo "[info] review_access_mode=${REVIEW_ACCESS_MODE} isolation_strategy=${ISOLATION_STRATEGY}" >&2
echo "[info] member-b runner-kind=${MEMBER_B_RUNNER_KIND_RESOLVED} runner=${MEMBER_B_RUNNER}" >&2

member_a_evidence="${run_dir}/member_a_evidence.json"
member_b_evidence="${run_dir}/member_b_evidence.json"

member_a_args=()
member_b_args=()
if [[ "${REVIEW_ACCESS_MODE}" != "full_access" ]]; then
  echo "[member-a] tag=${RESOLVED_TAG} -> ${member_a_out}"
  member_a_args=(
    --system-prompt-file "${MEMBER_A_SYSTEM}"
    --prompt-file "${packet_for_run}"
    --out "${member_a_out}"
  )
  if [[ -n "${MEMBER_A_MODEL}" ]]; then
    member_a_args=( --model "${MEMBER_A_MODEL}" "${member_a_args[@]}" )
  fi
  if [[ -n "${MEMBER_A_TOOLS}" ]]; then
    member_a_args=( --tools "${MEMBER_A_TOOLS}" "${member_a_args[@]}" )
  fi
  if [[ -n "${MEMBER_A_API_BASE_URL}" ]]; then
    member_a_args+=( --api-base-url "${MEMBER_A_API_BASE_URL}" )
  fi
  if [[ -n "${MEMBER_A_API_KEY_ENV}" ]]; then
    member_a_args+=( --api-key-env "${MEMBER_A_API_KEY_ENV}" )
  fi

	  if [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "claude" || "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "codex" ]]; then
	    echo "[member-b] tag=${RESOLVED_TAG} -> ${member_b_out} (runner-kind=${MEMBER_B_RUNNER_KIND_RESOLVED})"
	    member_b_args=(
	      --system-prompt-file "${MEMBER_B_SYSTEM_EFFECTIVE}"
	      --prompt-file "${packet_for_run}"
	      --out "${member_b_out}"
	    )
	    if [[ -n "${MEMBER_B_MODEL_EFFECTIVE}" ]]; then
	      member_b_args=( --model "${MEMBER_B_MODEL_EFFECTIVE}" "${member_b_args[@]}" )
	    fi
	    # --api-base-url / --api-key-env are supported by the project-local claude runner
	    # (LOCAL_CLAUDE_RUNNER) or a custom runner path (MEMBER_B_RUNNER_PATH), but NOT
	    # the skills-level runner which exits on unknown args.
	    if [[ "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "claude" ]] && \
	       { [[ -f "${LOCAL_CLAUDE_RUNNER}" ]] || [[ -n "${MEMBER_B_RUNNER_PATH}" ]]; }; then
	      if [[ -n "${MEMBER_B_API_BASE_URL}" ]]; then
	        member_b_args+=( --api-base-url "${MEMBER_B_API_BASE_URL}" )
	      fi
	      if [[ -n "${MEMBER_B_API_KEY_ENV}" ]]; then
	        member_b_args+=( --api-key-env "${MEMBER_B_API_KEY_ENV}" )
	      fi
	    fi
	  else
    tmp_gemini_prompt="$(mktemp)"
    {
      echo "SYSTEM (follow strictly):"
      cat "${MEMBER_B_SYSTEM}"
      echo
      echo "USER TEAM PACKET:"
      cat "${packet_for_run}"
    } >"${tmp_gemini_prompt}"

    echo "[member-b] tag=${RESOLVED_TAG} -> ${member_b_out} (runner-kind=gemini)"
	    member_b_args=(
	      --output-format "${MEMBER_B_OUTPUT_FORMAT}"
	      --prompt-file "${tmp_gemini_prompt}"
	      --out "${member_b_out}"
	    )
	    if [[ -n "${MEMBER_B_MODEL_EFFECTIVE}" ]]; then
	      member_b_args=( --model "${MEMBER_B_MODEL_EFFECTIVE}" "${member_b_args[@]}" )
	    fi
	    if [[ -n "${MEMBER_B_API_BASE_URL}" ]]; then
	      member_b_args+=( --api-base-url "${MEMBER_B_API_BASE_URL}" )
	    fi
	    if [[ -n "${MEMBER_B_API_KEY_ENV}" ]]; then
	      member_b_args+=( --api-key-env "${MEMBER_B_API_KEY_ENV}" )
	    fi
	  fi
else
  echo "[member-a] tag=${RESOLVED_TAG} -> ${member_a_out} (full_access; evidence=${member_a_evidence})"
  echo "[member-b] tag=${RESOLVED_TAG} -> ${member_b_out} (full_access; evidence=${member_b_evidence})"
fi

# Optional sidecar reviews (non-blocking).
sidecar_lines=""
if [[ "${SIDECAR_MODE}" != "force_off" ]]; then
  sidecar_probe_code=0
  set +e
  sidecar_lines="$(
    SIDECAR_FORCE="${SIDECAR_MODE}" SIDECAR_MODE="${SIDECAR_MODE}" python3 "${SIDECAR_PROBE_SCRIPT}" --notes "${NOTEBOOK_PATH}"
  )"
  sidecar_probe_code=$?
  set -e
  if [[ ${sidecar_probe_code} -ne 0 ]]; then
    echo "[warn] sidecar config probe failed (exit=${sidecar_probe_code}); disabling sidecar for this run." >&2
    sidecar_lines=""
  fi
fi
if [[ -n "${sidecar_lines}" ]]; then
  while IFS= read -r sidecar_line; do
    [[ -z "${sidecar_line}" ]] && continue
    # Parse TSV from team_cycle_sidecar_probe.py while preserving empty fields.
    # (bash 3.2 "read" collapses consecutive whitespace delimiters, so empty middle fields shift columns.)
    sc_enabled=""
    sc_model=""
    sc_system=""
    sc_runner=""
    sc_output=""
    sc_suffix=""
    sc_timeout=""
    i=0
    while IFS= read -r v; do
      case "${i}" in
        0) sc_enabled="${v}" ;;
        1) sc_model="${v}" ;;
        2) sc_system="${v}" ;;
        3) sc_runner="${v}" ;;
        4) sc_output="${v}" ;;
        5) sc_suffix="${v}" ;;
        6) sc_timeout="${v}" ;;
      esac
      i=$(( i + 1 ))
      [[ ${i} -ge 7 ]] && break
    done < <(
      printf '%s' "${sidecar_line}" | python3 -c 'import sys; s=sys.stdin.read().rstrip("\n"); parts=s.split("\t"); parts += [""]*(7-len(parts)); sys.stdout.write("\n".join(parts[:7]) + "\n")'
    )
    if [[ "${sc_enabled}" != "true" ]]; then
      continue
    fi

    sc_out="${run_dir}/${safe_tag}_${sc_suffix:-member_c}.md"
    sc_timeout_secs="${sc_timeout:-0}"
    if [[ ${SIDECAR_TIMEOUT_OVERRIDE_PROVIDED} -eq 1 ]]; then
      sc_timeout_secs="${SIDECAR_TIMEOUT_OVERRIDE}"
    fi
    if [[ -z "${sc_system}" ]]; then
      sc_system="prompts/_system_member_c_numerics.txt"
    fi
    if [[ "${sc_system}" != /* ]]; then
      sc_system="${PROJECT_ROOT}/${sc_system}"
    fi
    if [[ ! -f "${sc_system}" ]]; then
      echo "[warn] sidecar enabled but system prompt missing: ${sc_system}" >&2
      continue
    fi

    # Back-compat: expose the first sidecar as member_c_* for cycle_state.json.
    if [[ -z "${member_c_out}" ]]; then
      member_c_out="${sc_out}"
      member_c_timeout_secs="${sc_timeout_secs}"
    fi

    model_attempts=()
    if [[ -n "${sc_model}" ]]; then
      cand_models=( "${sc_model}" )
      if [[ "${sc_runner}" != "gemini" ]]; then
        if [[ "${sc_model}" == *sonnet* && "${sc_model}" != "sonnet" ]]; then
          cand_models+=( "sonnet" )
        fi
        if [[ "${sc_model}" == *opus* && "${sc_model}" != "opus" ]]; then
          cand_models+=( "opus" )
        fi
        if [[ "${sc_model}" == *haiku* && "${sc_model}" != "haiku" ]]; then
          cand_models+=( "haiku" )
        fi
        if [[ "${sc_model}" == *-* ]]; then
          prefix="${sc_model%%-*}"
          if [[ "${prefix}" == "sonnet" || "${prefix}" == "opus" || "${prefix}" == "haiku" ]]; then
            cand_models+=( "${prefix}" )
          fi
        fi
      fi

      for m in "${cand_models[@]}"; do
        [[ -z "${m}" ]] && continue
        seen=0
        # bash 3.2 + set -u: expanding an empty array like "${arr[@]}" can raise "unbound variable".
        if [[ ${#model_attempts[@]} -gt 0 ]]; then
          for mm in "${model_attempts[@]}"; do
            if [[ "${mm}" == "${m}" ]]; then
              seen=1
              break
            fi
          done
        fi
        if [[ ${seen} -eq 0 ]]; then
          model_attempts+=( "${m}" )
        fi
      done
    fi

    member_c_runner=""
    member_c_base_args=()
    tmp_gemini_prompt_c=""
    if [[ "${sc_runner}" == "gemini" ]]; then
      member_c_runner="${MEMBER_B_RUNNER}"
      tmp_gemini_prompt_c="$(mktemp)"
      sidecar_tmp_prompts+=( "${tmp_gemini_prompt_c}" )
      {
        echo "SYSTEM (follow strictly):"
        cat "${sc_system}"
        echo
        echo "USER TEAM PACKET:"
        cat "${packet_for_run}"
      } >"${tmp_gemini_prompt_c}"
      member_c_base_args=(
        --output-format "${sc_output}"
        --prompt-file "${tmp_gemini_prompt_c}"
        --out "${sc_out}"
      )
    else
      member_c_runner="${MEMBER_A_RUNNER}"
      member_c_base_args=(
        --system-prompt-file "${sc_system}"
        --prompt-file "${packet_for_run}"
        --out "${sc_out}"
      )
    fi

    log_prefix="[sidecar]"
    if [[ -n "${member_c_out}" && "${sc_out}" == "${member_c_out}" ]]; then
      # Back-compat: preserve the original "[member-c]" log marker for the first sidecar.
      log_prefix="[member-c]"
    fi
    sidecar_attempt_prefix="${safe_tag}_${sc_suffix:-member_c}_"
    echo "${log_prefix} tag=${RESOLVED_TAG} -> ${sc_out} (${sc_suffix:-member_c})"
    sc_pid=""
    if [[ "${RESUME}" -eq 1 && -s "${sc_out}" ]]; then
      echo "[resume] sidecar (${sc_suffix:-member_c}): using existing report: ${sc_out}"
    else
    (
      set +e
      code_c=0
      if [[ ${#model_attempts[@]} -gt 0 ]]; then
        for m in "${model_attempts[@]}"; do
          # Fail-fast for explicit model aliases: invalid models (e.g. 404) are deterministic and
          # should not burn long exponential backoff retries. Sidecars are non-blocking.
          #
          # Guard: only pass retry-control flags to runners that clearly support them (avoid breaking
          # custom runner scripts). Our shipped Claude runner and scaffolded project runner both do.
          if [[ "${sc_runner}" != "gemini" ]] && grep -q -- "--max-retries" "${member_c_runner}" 2>/dev/null; then
            RESEARCH_TEAM_ATTEMPT_LOG_DIR="${attempt_logs_dir}" \
            RESEARCH_TEAM_ATTEMPT_LOG_PREFIX="${sidecar_attempt_prefix}" \
            bash "${member_c_runner}" --max-retries 2 --sleep-secs 1 --model "${m}" "${member_c_base_args[@]}"
          else
            RESEARCH_TEAM_ATTEMPT_LOG_DIR="${attempt_logs_dir}" \
            RESEARCH_TEAM_ATTEMPT_LOG_PREFIX="${sidecar_attempt_prefix}" \
            bash "${member_c_runner}" --model "${m}" "${member_c_base_args[@]}"
          fi
          code_c=$?
          if [[ ${code_c} -eq 0 ]]; then
            exit 0
          fi
          echo "[warn] sidecar attempt failed (${sc_suffix:-member_c}, model=${m}, exit=${code_c})." >&2
        done
        echo "[warn] sidecar falling back to runner default model (${sc_suffix:-member_c}; omit --model)." >&2
      fi
      RESEARCH_TEAM_ATTEMPT_LOG_DIR="${attempt_logs_dir}" \
      RESEARCH_TEAM_ATTEMPT_LOG_PREFIX="${sidecar_attempt_prefix}" \
      bash "${member_c_runner}" "${member_c_base_args[@]}"
      exit $?
    ) &
    sc_pid=$!
    fi

    sidecar_outs+=( "${sc_out}" )
    sidecar_pids+=( "${sc_pid}" )
    sidecar_timeouts+=( "${sc_timeout_secs}" )
    if [[ -z "${member_c_pid}" ]]; then
      member_c_pid="${sc_pid}"
    fi
  done <<<"${sidecar_lines}"
fi

# Run Member A + Member B.
pid_a=""
pid_b=""
code_a=0
code_b=0

RUN_MEMBER_REVIEW_SCRIPT="${SCRIPT_DIR}/run_member_review.py"
if [[ "${REVIEW_ACCESS_MODE}" == "full_access" ]]; then
  if [[ ! -f "${RUN_MEMBER_REVIEW_SCRIPT}" ]]; then
    echo "ERROR: missing full_access member runner: ${RUN_MEMBER_REVIEW_SCRIPT}" >&2
    exit 2
  fi

  # Build optional API arg arrays for full_access invocations.
  _api_args_a=()
  [[ -n "${MEMBER_A_API_BASE_URL}" ]] && _api_args_a+=( --api-base-url "${MEMBER_A_API_BASE_URL}" )
  [[ -n "${MEMBER_A_API_KEY_ENV}" ]]  && _api_args_a+=( --api-key-env  "${MEMBER_A_API_KEY_ENV}" )
  [[ -n "${MEMBER_A_WORKSPACE_ID}" ]] && _api_args_a+=( --workspace-id "${MEMBER_A_WORKSPACE_ID}" )
  [[ -n "${MEMBER_A_TOOL_ACCESS}" ]]  && _api_args_a+=( --tool-access  "${MEMBER_A_TOOL_ACCESS}" )
  _api_args_b=()
  [[ -n "${MEMBER_B_API_BASE_URL}" ]] && _api_args_b+=( --api-base-url "${MEMBER_B_API_BASE_URL}" )
  [[ -n "${MEMBER_B_API_KEY_ENV}" ]]  && _api_args_b+=( --api-key-env  "${MEMBER_B_API_KEY_ENV}" )
  [[ -n "${MEMBER_B_WORKSPACE_ID}" ]] && _api_args_b+=( --workspace-id "${MEMBER_B_WORKSPACE_ID}" )
  [[ -n "${MEMBER_B_TOOL_ACCESS}" ]]  && _api_args_b+=( --tool-access  "${MEMBER_B_TOOL_ACCESS}" )

  # Best-effort ACL isolation: deny reading the other member's outputs during each member run.
  mkdir -p "${run_dir}/member_a" "${run_dir}/member_b"
  mkdir -p "${PROJECT_ROOT}/artifacts/${safe_tag}/member_a/independent" "${PROJECT_ROOT}/artifacts/${safe_tag}/member_b/independent" || true

  deny_other_outputs() {
    local who="$1"
    local other="$2"
    chmod -R a-rwx "${run_dir}/${other}" >/dev/null 2>&1 || true
    chmod a-rwx "${run_dir}/${other}_evidence.json" >/dev/null 2>&1 || true
    # Also revoke access to the other member's top-level report file.
    chmod a-rwx "${run_dir}/${safe_tag}_${other}.md" >/dev/null 2>&1 || true
    # Revoke audit log and per-member attempt log subdir.
    chmod a-rwx "${run_dir}/${other}_audit.jsonl" >/dev/null 2>&1 || true
    chmod -R a-rwx "${attempt_logs_dir}/${other}" >/dev/null 2>&1 || true
    chmod -R a-rwx "${PROJECT_ROOT}/artifacts/${safe_tag}/${other}" >/dev/null 2>&1 || true
    # Revoke other member's workspace dir(s) (names include UUID suffix; use glob).
    for _ws in "${run_dir}/workspaces/${other}_"*; do
      [[ -e "${_ws}" ]] && chmod -R a-rwx "${_ws}" >/dev/null 2>&1 || true
    done
    chmod -R u+rwX "${run_dir}/${who}" >/dev/null 2>&1 || true
    chmod u+rw "${run_dir}/${who}_evidence.json" >/dev/null 2>&1 || true
    chmod u+rw "${run_dir}/${safe_tag}_${who}.md" >/dev/null 2>&1 || true
    chmod u+rw "${run_dir}/${who}_audit.jsonl" >/dev/null 2>&1 || true
    chmod -R u+rwX "${attempt_logs_dir}/${who}" >/dev/null 2>&1 || true
    chmod -R u+rwX "${PROJECT_ROOT}/artifacts/${safe_tag}/${who}" >/dev/null 2>&1 || true
    # Restore own workspace dir(s).
    for _ws in "${run_dir}/workspaces/${who}_"*; do
      [[ -e "${_ws}" ]] && chmod -R u+rwX "${_ws}" >/dev/null 2>&1 || true
    done
  }

  restore_outputs() {
    chmod -R u+rwX "${run_dir}/member_a" "${run_dir}/member_b" >/dev/null 2>&1 || true
    chmod u+rw "${member_a_evidence}" "${member_b_evidence}" >/dev/null 2>&1 || true
    chmod u+rw "${member_a_out}" "${member_b_out}" >/dev/null 2>&1 || true
    chmod u+rw "${run_dir}/member_a_audit.jsonl" "${run_dir}/member_b_audit.jsonl" >/dev/null 2>&1 || true
    chmod -R u+rwX "${attempt_logs_dir}/member_a" "${attempt_logs_dir}/member_b" >/dev/null 2>&1 || true
    chmod -R u+rwX "${PROJECT_ROOT}/artifacts/${safe_tag}/member_a" "${PROJECT_ROOT}/artifacts/${safe_tag}/member_b" >/dev/null 2>&1 || true
    # Restore both members' workspace dirs.
    for _ws in "${run_dir}/workspaces/member_a_"* "${run_dir}/workspaces/member_b_"*; do
      [[ -e "${_ws}" ]] && chmod -R u+rwX "${_ws}" >/dev/null 2>&1 || true
    done
  }

  if [[ "${RESUME}" -eq 1 && -s "${member_a_out}" && -s "${member_a_evidence}" ]]; then
    echo "[resume] member-a: using existing report+evidence: ${member_a_out}"
    cycle_state_update "member_a" "skipped" "running" ""
    # Recover workspace ID from the prior audit log so the gate's provenance check
    # does not fail with PROVENANCE_MISMATCH (newly generated ID ≠ audit-log ID).
    _audit_a_log="${run_dir}/member_a_audit.jsonl"
    if [[ -s "${_audit_a_log}" ]]; then
      _prior_ws_a="$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        for line in f:
            line = line.strip()
            if line:
                ws = json.loads(line).get('workspace', '')
                if ws:
                    print(ws); break
except Exception:
    pass
" "${_audit_a_log}" 2>/dev/null || true)"
      [[ -n "${_prior_ws_a}" ]] && MEMBER_A_WORKSPACE_ID="${_prior_ws_a}"
    fi
  else
    deny_other_outputs "member_a" "member_b"
    cycle_state_update "member_a" "started" "running" ""
    set +e
    RESEARCH_TEAM_ATTEMPT_LOG_DIR="${attempt_logs_dir}/member_a" \
    RESEARCH_TEAM_ATTEMPT_LOG_PREFIX="${member_a_attempt_prefix}" \
    python3 "${RUN_MEMBER_REVIEW_SCRIPT}" \
      --member-id "member_a" --mode "full_access" --tag "${RESOLVED_TAG}" \
      --project-root "${PROJECT_ROOT}" --workspace-root "${MEMBER_A_WORKSPACE_DIR}" \
      --packet "${packet_for_run}" --system "${MEMBER_A_SYSTEM}" \
      --runner "${MEMBER_A_RUNNER}" --runner-kind "claude" \
      --model "${MEMBER_A_MODEL}" --tools "${MEMBER_A_TOOLS}" \
      --run-dir "${run_dir}" --out-report "${member_a_out}" --out-evidence "${member_a_evidence}" \
      "${_api_args_a[@]}"
    code_a=$?
    set -e
    restore_outputs
    if [[ ${code_a} -ne 0 ]]; then
      cycle_state_update "member_a" "failed" "error" "member-a=${code_a}"
      echo "[error] member-a full_access failed (exit=${code_a})." >&2
      exit 2
    fi
    cycle_state_update "member_a" "done" "running" ""
  fi

  if [[ "${RESUME}" -eq 1 && -s "${member_b_out}" && -s "${member_b_evidence}" ]]; then
    echo "[resume] member-b: using existing report+evidence: ${member_b_out}"
    cycle_state_update "member_b" "skipped" "running" ""
    # Recover workspace ID from the prior audit log (same reason as member_a above).
    _audit_b_log="${run_dir}/member_b_audit.jsonl"
    if [[ -s "${_audit_b_log}" ]]; then
      _prior_ws_b="$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        for line in f:
            line = line.strip()
            if line:
                ws = json.loads(line).get('workspace', '')
                if ws:
                    print(ws); break
except Exception:
    pass
" "${_audit_b_log}" 2>/dev/null || true)"
      [[ -n "${_prior_ws_b}" ]] && MEMBER_B_WORKSPACE_ID="${_prior_ws_b}"
    fi
  else
    deny_other_outputs "member_b" "member_a"
    cycle_state_update "member_b" "started" "running" ""
    set +e
    RESEARCH_TEAM_ATTEMPT_LOG_DIR="${attempt_logs_dir}/member_b" \
    RESEARCH_TEAM_ATTEMPT_LOG_PREFIX="${member_b_attempt_prefix}" \
    python3 "${RUN_MEMBER_REVIEW_SCRIPT}" \
      --member-id "member_b" --mode "full_access" --tag "${RESOLVED_TAG}" \
      --project-root "${PROJECT_ROOT}" --workspace-root "${MEMBER_B_WORKSPACE_DIR}" \
      --packet "${packet_for_run}" --system "${MEMBER_B_SYSTEM_EFFECTIVE}" \
      --runner "${MEMBER_B_RUNNER}" --runner-kind "${MEMBER_B_RUNNER_KIND_RESOLVED}" \
      --model "${MEMBER_B_MODEL_EFFECTIVE}" --tools "" --output-format "${MEMBER_B_OUTPUT_FORMAT}" \
      --run-dir "${run_dir}" --out-report "${member_b_out}" --out-evidence "${member_b_evidence}" \
      "${_api_args_b[@]}"
    code_b=$?
    set -e
    restore_outputs
    if [[ ${code_b} -ne 0 ]]; then
      cycle_state_update "member_b" "failed" "error" "member-b=${code_b}"
      echo "[error] member-b full_access failed (exit=${code_b})." >&2
      exit 2
    fi
    cycle_state_update "member_b" "done" "running" ""
  fi

  restore_outputs
else
  # packet_only: run Member A + Member B in parallel (independent runners).
  if [[ "${RESUME}" -eq 1 && -s "${member_a_out}" ]]; then
    echo "[resume] member-a: using existing report: ${member_a_out}"
    cycle_state_update "member_a" "skipped" "running" ""
  else
    cycle_state_update "member_a" "started" "running" ""
    RESEARCH_TEAM_ATTEMPT_LOG_DIR="${attempt_logs_dir}" \
    RESEARCH_TEAM_ATTEMPT_LOG_PREFIX="${member_a_attempt_prefix}" \
    bash "${MEMBER_A_RUNNER}" "${member_a_args[@]}" &
    pid_a=$!
  fi

  if [[ "${RESUME}" -eq 1 && -s "${member_b_out}" ]]; then
    echo "[resume] member-b: using existing report: ${member_b_out}"
    cycle_state_update "member_b" "skipped" "running" ""
  else
    cycle_state_update "member_b" "started" "running" ""
    RESEARCH_TEAM_ATTEMPT_LOG_DIR="${attempt_logs_dir}" \
    RESEARCH_TEAM_ATTEMPT_LOG_PREFIX="${member_b_attempt_prefix}" \
    bash "${MEMBER_B_RUNNER}" "${member_b_args[@]}" &
    pid_b=$!
  fi

  set +e
  if [[ -n "${pid_a}" ]]; then
    wait "${pid_a}"
    code_a=$?
  fi
  if [[ -n "${pid_b}" ]]; then
    wait "${pid_b}"
    code_b=$?
  fi
  set -e
  if [[ -n "${pid_a}" ]]; then
    cycle_state_update "member_a" "done" "running" ""
  fi
  if [[ -n "${pid_b}" ]]; then
    cycle_state_update "member_b" "done" "running" ""
	fi
fi

# If Member B ran via Gemini and failed (or produced an unhealthy report), optionally retry with a fallback runner.
# Packet-only only: full_access must go through run_member_review.py evidence flow.
if [[ "${REVIEW_ACCESS_MODE}" != "full_access" && "${MEMBER_B_RUNNER_KIND_RESOLVED}" == "gemini" ]]; then
  runtime_reason=""
  if [[ ${code_b} -ne 0 ]]; then
    runtime_reason="gemini_exit_${code_b}"
  elif ! member_report_healthy "${member_b_out}"; then
    runtime_reason="gemini_unhealthy_report"
    code_b=2
  fi

  if [[ -n "${runtime_reason}" ]]; then
    if [[ "${MEMBER_B_FALLBACK_MODE}" == "ask" ]]; then
      echo "" >&2
      echo "[action_required] member-b gemini failed (${runtime_reason}). Re-run with one of:" >&2
      echo "  --member-b-runner-kind claude" >&2
      echo "  --member-b-runner-kind codex" >&2
      echo "  --member-b-fallback-mode auto --member-b-fallback-order ${MEMBER_B_FALLBACK_ORDER}" >&2
      cycle_state_update "member_b" "blocked" "error" "member-b=${runtime_reason}"
      finalize_all_sidecars "${RESOLVED_TAG:-unknown}" "1" || true
      exit 4
    fi

    if [[ "${MEMBER_B_FALLBACK_MODE}" == "auto" ]]; then
      MEMBER_B_FALLBACK_REASON="${runtime_reason}"
      fb_kind="$(choose_member_b_fallback_kind "${runtime_reason}")"
      echo "[warn] member-b gemini failed (${runtime_reason}); retrying with ${fb_kind}." >&2

      MEMBER_B_RUNNER_KIND_RESOLVED="${fb_kind}"
      if [[ "${fb_kind}" == "claude" ]]; then
        MEMBER_B_MODEL_EFFECTIVE="${MEMBER_B_FALLBACK_CLAUDE_MODEL}"
        if [[ -f "${LOCAL_CLAUDE_RUNNER}" ]]; then
          MEMBER_B_RUNNER="${LOCAL_CLAUDE_RUNNER}"
        else
          MEMBER_B_RUNNER="${SKILLS_DIR}/claude-cli-runner/scripts/run_claude.sh"
        fi
      elif [[ "${fb_kind}" == "codex" ]]; then
        MEMBER_B_MODEL_EFFECTIVE="${MEMBER_B_FALLBACK_CODEX_MODEL}"
        if [[ -f "${LOCAL_CODEX_RUNNER}" ]]; then
          MEMBER_B_RUNNER="${LOCAL_CODEX_RUNNER}"
        else
          MEMBER_B_RUNNER="${SKILL_ROOT}/assets/run_codex.sh"
        fi
      else
        echo "[error] unknown fallback runner kind: ${fb_kind}" >&2
        cycle_state_update "member_b" "failed" "error" "member-b=${runtime_reason}"
        finalize_all_sidecars "${RESOLVED_TAG:-unknown}" "1" || true
        exit 2
      fi

      # Recompute effective system prompt for the fallback runner.
      MEMBER_B_SYSTEM_EFFECTIVE="${MEMBER_B_SYSTEM}"
      if [[ -n "${MEMBER_B_SYSTEM_CLAUDE}" && -f "${MEMBER_B_SYSTEM_CLAUDE}" ]]; then
        MEMBER_B_SYSTEM_EFFECTIVE="${MEMBER_B_SYSTEM_CLAUDE}"
      fi

      member_b_retry_args=(
        --system-prompt-file "${MEMBER_B_SYSTEM_EFFECTIVE}"
        --prompt-file "${packet_for_run}"
        --out "${member_b_out}"
      )
      if [[ -n "${MEMBER_B_MODEL_EFFECTIVE}" ]]; then
        member_b_retry_args=( --model "${MEMBER_B_MODEL_EFFECTIVE}" "${member_b_retry_args[@]}" )
      fi
      # Propagate RT-03 API routing settings for claude fallback.
      # Only when using the project-local runner (LOCAL_CLAUDE_RUNNER), which
      # supports --api-base-url/--api-key-env. The skills-level runner exits on
      # unknown args and does not accept these flags.
      if [[ "${fb_kind}" == "claude" && -f "${LOCAL_CLAUDE_RUNNER}" ]]; then
        [[ -n "${MEMBER_B_API_BASE_URL}" ]] && member_b_retry_args+=( --api-base-url "${MEMBER_B_API_BASE_URL}" )
        [[ -n "${MEMBER_B_API_KEY_ENV}" ]]  && member_b_retry_args+=( --api-key-env  "${MEMBER_B_API_KEY_ENV}" )
      fi

      set +e
      RESEARCH_TEAM_ATTEMPT_LOG_DIR="${attempt_logs_dir}" \
      RESEARCH_TEAM_ATTEMPT_LOG_PREFIX="${member_b_attempt_prefix}" \
      bash "${MEMBER_B_RUNNER}" "${member_b_retry_args[@]}"
      code_b=$?
      set -e
      if [[ ${code_b} -ne 0 ]]; then
        echo "" >&2
        echo "[error] member-b fallback failed (runner-kind=${fb_kind}, exit=${code_b})." >&2
        cycle_state_update "member_b" "failed" "error" "member-b-fallback=${fb_kind}:${code_b}"
        finalize_all_sidecars "${RESOLVED_TAG:-unknown}" "1" || true
        exit 2
      fi
      if ! member_report_healthy "${member_b_out}"; then
        echo "" >&2
        echo "[error] member-b fallback produced an unhealthy report (runner-kind=${fb_kind})." >&2
        cycle_state_update "member_b" "failed" "error" "member-b-fallback=${fb_kind}:unhealthy_report"
        finalize_all_sidecars "${RESOLVED_TAG:-unknown}" "1" || true
        exit 2
      fi
      cycle_state_update "member_b" "done" "running" "member-b-fallback=${fb_kind}"
      code_b=0
    fi
  fi
fi

cycle_state_merge_attempt_logs "${attempt_logs_dir}"

if [[ ${code_a} -ne 0 || ${code_b} -ne 0 ]]; then
  echo "" >&2
  echo "[error] member runner failed (member-a=${code_a}, member-b=${code_b})." >&2
  cycle_state_update "member_runners" "failed" "error" "member-a=${code_a}, member-b=${code_b}"
  finalize_all_sidecars "${RESOLVED_TAG:-unknown}" "1" || true
  exit 2
fi

echo "[done] wrote:"
echo "  - ${member_a_out}"
echo "  - ${member_b_out}"
if [[ ${#sidecar_outs[@]} -gt 0 ]]; then
  for sc_out in "${sidecar_outs[@]}"; do
    echo "  - ${sc_out}"
  done
fi
cycle_state_update "member_reports" "done" "running" ""

# Postflight (full_access): evidence + clean-room + independent reproduction gates.
post_gates=(
  "evidence_schema_gate:${GATES_DIR}/check_member_evidence.py"
  "clean_room_gate:${GATES_DIR}/check_clean_room.py"
  "independent_reproduction_gate:${GATES_DIR}/check_independent_reproduction.py"
  "logic_isolation_gate:${GATES_DIR}/check_logic_isolation.py"
  "convention_mapping_gate:${GATES_DIR}/check_convention_mappings.py"
)

for entry in "${post_gates[@]}"; do
  gate_name="${entry%%:*}"
  gate_script="${entry#*:}"
  if [[ ! -f "${gate_script}" ]]; then
    continue
  fi
  set +e
  case "${gate_name}" in
    evidence_schema_gate)
      python3 "${gate_script}" --notes "${NOTEBOOK_PATH}" --member-a "${member_a_evidence}" --member-b "${member_b_evidence}"
      gate_code=$?
      ;;
    clean_room_gate)
      _clean_room_args=(
        --notes "${NOTEBOOK_PATH}"
        --member-a "${member_a_evidence}"
        --member-b "${member_b_evidence}"
        --safe-tag "${safe_tag}"
      )
      # Pass audit logs and workspace IDs if generated.
      _audit_a="${run_dir}/member_a_audit.jsonl"
      _audit_b="${run_dir}/member_b_audit.jsonl"
      # Always pass audit-a/b when workspace_id is set (full_access mode); the gate
      # enforces that the file must exist (PROVENANCE_MISSING if absent).
      [[ -n "${MEMBER_A_WORKSPACE_ID}" ]] && _clean_room_args+=( --audit-a "${_audit_a}" )
      [[ -n "${MEMBER_B_WORKSPACE_ID}" ]] && _clean_room_args+=( --audit-b "${_audit_b}" )
      [[ -n "${MEMBER_A_WORKSPACE_ID}" ]] && _clean_room_args+=( --workspace-id-a "${MEMBER_A_WORKSPACE_ID}" )
      [[ -n "${MEMBER_B_WORKSPACE_ID}" ]] && _clean_room_args+=( --workspace-id-b "${MEMBER_B_WORKSPACE_ID}" )
      python3 "${gate_script}" "${_clean_room_args[@]}"
      gate_code=$?
      ;;
    independent_reproduction_gate)
      python3 "${gate_script}" --notes "${NOTEBOOK_PATH}" --tag "${RESOLVED_TAG}" --member-a "${member_a_evidence}" --member-b "${member_b_evidence}" --project-root "${PROJECT_ROOT}"
      gate_code=$?
      ;;
    logic_isolation_gate)
      python3 "${gate_script}" --notes "${NOTEBOOK_PATH}" --tag "${RESOLVED_TAG}" --project-root "${PROJECT_ROOT}"
      gate_code=$?
      ;;
    convention_mapping_gate)
      python3 "${gate_script}" --notes "${NOTEBOOK_PATH}" --packet "${packet_for_run}" --member-a "${member_a_evidence}" --member-b "${member_b_evidence}"
      gate_code=$?
      ;;
    *)
      gate_code=0
      ;;
  esac
  set -e

  if [[ ${gate_code} -ne 0 ]]; then
    echo "" >&2
    # Exit codes 3 (CONTAMINATION_DETECTED) and 4 (PROVENANCE_MISMATCH) are hard-fail:
    # non-degradable even in exploration mode.
    if [[ ${gate_code} -eq 3 || ${gate_code} -eq 4 ]]; then
      echo "[gate] HARD-FAIL (non-degradable): ${gate_name} exit=${gate_code}. Cannot continue." >&2
      exit ${gate_code}
    fi
    if [[ "${PROJECT_STAGE}" == "exploration" ]] && should_warn_gate_in_exploration "${gate_name}"; then
      echo "[warn] (exploration) ${gate_name} failed; continuing. Fix before switching to development." >&2
      record_exploration_debt "${gate_name}" "${gate_code}" "${gate_name} failed (see gate output above)"
    else
      echo "[gate] Fail-fast: ${gate_name} failed. Fix and re-run the team cycle." >&2
      exit ${gate_code}
    fi
  fi
done

# Record member reports.
if [[ -f "${TRAJ_SCRIPT}" ]]; then
  python3 "${TRAJ_SCRIPT}" --notes "${NOTEBOOK_PATH}" --out-dir "${OUT_DIR}" --tag "${RESOLVED_TAG}" --stage "member_reports" --packet "${packet_for_run}" --member-a "${member_a_out}" --member-b "${member_b_out}" >/dev/null 2>&1 || true
fi

# Mandatory convergence gate.
GATE_SCRIPT="${GATES_DIR}/check_team_convergence.py"
SUMMARY_SCRIPT="${SCRIPT_DIR}/summarize_team_reports.py"
next_tag=""

if [[ -f "${GATE_SCRIPT}" ]]; then
  echo "[gate] running convergence gate: ${GATE_SCRIPT} (mode=${WORKFLOW_MODE}, require_sweep=${REQUIRE_SWEEP})"
  gate_sweep_flag="--require-sweep"
  if [[ ${REQUIRE_SWEEP} -eq 0 ]]; then
    gate_sweep_flag="--no-require-sweep"
  fi
  set +e
  python3 "${GATE_SCRIPT}" --member-a "${member_a_out}" --member-b "${member_b_out}" \
    --workflow-mode "${WORKFLOW_MODE}" ${gate_sweep_flag}
  gate_code=$?
  set -e
  if [[ ${gate_code} -eq 3 ]]; then
    # Leader early stop: >=2 CHALLENGED steps
    echo "" >&2
    echo "[gate] Leader early stop: verifier CHALLENGED >=2 steps. Apply targeted fixes and re-run." >&2
    if [[ -f "${SUMMARY_SCRIPT}" ]]; then
      echo "" >&2
      python3 "${SUMMARY_SCRIPT}" --member-a "${member_a_out}" --member-b "${member_b_out}" >&2 || true
    fi
    CYCLE_FINAL_STATUS="early_stop"
    cycle_state_update "convergence" "early_stop" "${CYCLE_FINAL_STATUS}" ""
    finalize_all_sidecars "${RESOLVED_TAG:-unknown}" "0" || true
    exit ${gate_code}
  fi
  if [[ ${gate_code} -ne 0 ]]; then
    if [[ -f "${NEXT_TAG_SCRIPT}" ]]; then
      set +e
      next_tag="$(python3 "${NEXT_TAG_SCRIPT}" --tag "${RESOLVED_TAG}" --out-dir "${OUT_DIR}" 2>/dev/null)"
      set -e
    fi
    if [[ -z "${next_tag}" ]]; then
      next_tag="${RESOLVED_TAG}-r1"
    fi

    echo "" >&2
    echo "[gate] Not converged. Apply fixes and re-run team cycle with a new tag (suggested: ${next_tag})." >&2
    if [[ -f "${SUMMARY_SCRIPT}" ]]; then
      echo "" >&2
      python3 "${SUMMARY_SCRIPT}" --member-a "${member_a_out}" --member-b "${member_b_out}" >&2 || true
    fi
    echo "" >&2
    echo "[next] Create an adjudication/response note (accept/modify/reject with evidence) and attach it to the next team packet:" >&2
    echo "  python3 ${SCRIPT_DIR}/build_adjudication_response.py --tag ${next_tag} \\" >&2
    echo "    --member-a ${member_a_out} --member-b ${member_b_out} \\" >&2
    echo "    --out ${OUT_DIR}/runs/$(echo "${next_tag}" | sed -E 's/[^A-Za-z0-9._-]+/_/g')/$(echo "${next_tag}" | sed -E 's/[^A-Za-z0-9._-]+/_/g')_adjudication.md" >&2

    if [[ -f "${TRAJ_SCRIPT}" ]]; then
      python3 "${TRAJ_SCRIPT}" --notes "${NOTEBOOK_PATH}" --out-dir "${OUT_DIR}" --tag "${RESOLVED_TAG}" --stage "not_converged" --packet "${packet_for_run}" --member-a "${member_a_out}" --member-b "${member_b_out}" --gate "not_converged" >/dev/null 2>&1 || true
    fi
    if [[ -f "${PLAN_UPDATE_SCRIPT}" ]]; then
      python3 "${PLAN_UPDATE_SCRIPT}" --notes "${NOTEBOOK_PATH}" --tag "${RESOLVED_TAG}" --status "not_converged" >/dev/null 2>&1 || true
    fi

    if [[ -f "${PROJECT_MAP_UPDATE_SCRIPT}" ]]; then
      python3 "${PROJECT_MAP_UPDATE_SCRIPT}" --notes "${NOTEBOOK_PATH}" --team-dir "${OUT_DIR}" --tag "${RESOLVED_TAG}" --status "not_converged" --run-dir "${run_dir_abs}" >/dev/null 2>&1 || true
    fi

    CYCLE_FINAL_STATUS="not_converged"
    cycle_state_update "convergence" "not_converged" "${CYCLE_FINAL_STATUS}" ""

    # Sidecars are non-blocking with respect to convergence accounting and trajectory updates.
    finalize_all_sidecars "${RESOLVED_TAG:-unknown}" "0" || true
    exit ${gate_code}
  fi
else
  echo "[gate] ERROR: missing gate script: ${GATE_SCRIPT}" >&2
  exit 2
fi

CYCLE_FINAL_STATUS="converged"
cycle_state_update "convergence" "converged" "${CYCLE_FINAL_STATUS}" ""

if [[ -f "${TRAJ_SCRIPT}" ]]; then
  python3 "${TRAJ_SCRIPT}" --notes "${NOTEBOOK_PATH}" --out-dir "${OUT_DIR}" --tag "${RESOLVED_TAG}" --stage "converged" --packet "${packet_for_run}" --member-a "${member_a_out}" --member-b "${member_b_out}" --gate "converged" >/dev/null 2>&1 || true
fi
if [[ -f "${PLAN_UPDATE_SCRIPT}" ]]; then
  python3 "${PLAN_UPDATE_SCRIPT}" --notes "${NOTEBOOK_PATH}" --tag "${RESOLVED_TAG}" --status "converged" >/dev/null 2>&1 || true
fi
if [[ -f "${CLAIM_AUTO_SCRIPT}" ]]; then
  python3 "${CLAIM_AUTO_SCRIPT}" --notes "${NOTEBOOK_PATH}" --status "converged" || true
fi
if [[ -f "${CLAIM_RENDER_SCRIPT}" ]]; then
  python3 "${CLAIM_RENDER_SCRIPT}" --notes "${NOTEBOOK_PATH}" >/dev/null || true
fi

if [[ -f "${PROJECT_MAP_UPDATE_SCRIPT}" ]]; then
  python3 "${PROJECT_MAP_UPDATE_SCRIPT}" --notes "${NOTEBOOK_PATH}" --team-dir "${OUT_DIR}" --tag "${RESOLVED_TAG}" --status "converged" --run-dir "${run_dir_abs}" >/dev/null 2>&1 || true
fi

# Sidecars are non-blocking with respect to convergence accounting and trajectory updates.
finalize_all_sidecars "${RESOLVED_TAG:-unknown}" "0" || true
