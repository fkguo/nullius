#!/usr/bin/env bash
set -euo pipefail

# Qwen Code CLI runner: one-shot headless mode with file-based inputs fed via
# stdin, batch-JSON parsing, an isolated default working directory, retries,
# and default-model fallback on model-not-found.
#
# Interface checked against local Qwen Code 0.27.4 (`qwen --help` and the
# installed bundle): `-o json` prints ONE JSON array of CLI messages whose
# final element is a `type:"result"` message; stdin text becomes the prompt
# when no positional query is given; `--system-prompt` overrides the session
# system prompt; `--approval-mode plan` is analyze-only; `--safe-mode`
# disables context files, hooks, extensions, skills and MCP servers, and is
# the runner's isolation mechanism in isolated mode.

MODEL="qwen4-max-preview"
SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
QWEN_BIN="${QWEN_BIN:-qwen}"
TOOL_MODE="isolated"
APPROVAL_MODE=""
WORK_DIR=""
WORK_DIR_EXPLICIT=0
WORKSPACE_DIRS=()
ALLOW_EXTENSIONS=0
NO_SAFE_MODE=0
MAX_SESSION_TURNS=""
MAX_ATTEMPTS=3
MAX_ATTEMPTS_HARD_MAX=20
SLEEP_SECS=5
MAX_BACKOFF_SECS=300
TIMEOUT_SECS=900
NO_FALLBACK=0
DRY_RUN=0
RAW_OUT=""
STDERR_OUT=""
LAST_MODEL_NOT_FOUND=0
RESUME_SESSION=""
TRACE_DIR=""
PROCESS_BUDGET="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/process_budget.py"
ACTIVE_PID=""

usage() {
  cat <<'EOF'
run_qwen.sh

Usage:
  run_qwen.sh --prompt-file PROMPT.txt --out OUT.txt

Options:
  --model MODEL           Qwen model alias (-m). Default: qwen4-max-preview.
                          On model-not-found the runner can retry with the
                          CLI default model.
  --system-prompt-file F  Optional. Passed via the official --system-prompt flag
                          (overrides the session system prompt for this run).
  --prompt-file FILE      Required. Fed to qwen via stdin (no ARG_MAX limit).
  --out PATH              Required. Parsed final assistant text.
  --tool-mode MODE        Default: isolated. Choices: isolated, workspace.
  --workspace-dir DIR     Repeatable. Expose a workspace via --include-directories
                          in workspace mode. Defaults to the current cwd when omitted.
  --work-dir DIR          Advanced. Run qwen from this directory instead of an
                          isolated temp dir.
  --approval-mode MODE    Optional explicit override: plan, default, auto-edit, auto, yolo.
                          Default: plan in isolated mode, default in workspace mode.
                          Non-plan modes can execute tools; use only for authorized tasks.
  --no-safe-mode          Do not pass --safe-mode in isolated mode. By default isolated
                          runs disable context files, hooks, extensions, skills and MCP
                          servers via the official --safe-mode flag (Qwen Code >= 0.27).
  --allow-extensions      In workspace mode, do not pass `-e none` (qwen's official
                          disable-all sentinel); allow installed extensions to load.
                          No effect in isolated mode unless --no-safe-mode is set.
  --max-session-turns N   Optional cap on session turns (qwen --max-session-turns).
  --qwen-bin PATH         Qwen executable (default: qwen).
  --max-attempts N        Total CLI calls, including retries and fallback (default: 3).
  --max-retries N         Deprecated alias of --max-attempts.
  --sleep-secs SECONDS    Exponential backoff base seconds (default: 5).
  --timeout-secs SECONDS  Total invocation deadline including backoff (default: 900;
                          0 explicitly disables the hard deadline).
  --raw-out FILE          Optional. Copy raw qwen stdout from the last attempt here.
  --stderr-out FILE       Optional. Copy raw qwen stderr from the last attempt here.
  --trace-dir DIR         Retain every attempt's raw output and budget receipt here
                          (default: OUT.attempts).
  --no-fallback           Do not retry without -m after a model-not-found failure.
  --resume-session ID     Resume a specific recorded qwen session (qwen -r ID); the
                          prompt is that session's next turn. Requires --work-dir DIR
                          pointing at the prior run's working directory (qwen scopes
                          sessions per project directory). Continuation is not an
                          independent review.
  --dry-run               Print invocation details and exit 0 without calling qwen.
  --check-client           Show the selected client version and check the baseline CLI flags offline.

Notes:
  The prompt file is fed via stdin; qwen reads piped stdin in non-interactive
  mode and caps it at 8 MiB (larger inputs are truncated by the CLI itself).
  The runner refuses merged inputs over QWEN_MAX_PROMPT_BYTES (default 8 MiB)
  before exec. Exit 0 requires a successful CLI exit AND a non-error
  `type:"result"` message with nonblank final text.
EOF
}

require_value() {
  local opt="$1"
  local val="${2-}"
  if [[ -z "${val}" || "${val}" == --* ]]; then
    echo "Missing value for ${opt}" >&2
    exit 2
  fi
}

file_size_bytes() {
  wc -c <"$1" | tr -d '[:space:]'
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PY'
import hashlib
import sys

path = sys.argv[1]
h = hashlib.sha256()
with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest())
PY
    return 0
  fi
  echo "sha256_unavailable"
}

print_shell_cmd() {
  while (($#)); do
    printf '%q ' "$1"
    shift
  done
}

abs_dir() {
  local dir="$1"
  (cd "${dir}" && pwd -P)
}

prompt_limit_bytes() {
  # qwen's readStdin caps piped input at 8 MiB and truncates beyond it.
  local limit="${QWEN_MAX_PROMPT_BYTES:-8388608}"
  if ! [[ "${limit}" =~ ^[0-9]+$ ]] || [[ "${limit}" -lt 1 ]]; then
    echo "QWEN_MAX_PROMPT_BYTES must be an integer >= 1" >&2
    exit 2
  fi
  echo "${limit}"
}

validate_prompt_size() {
  local size
  size="$(file_size_bytes "${PROMPT_FILE}")"
  if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
    size=$(( size + $(file_size_bytes "${SYSTEM_PROMPT_FILE}") ))
  fi
  if [[ "${size}" -gt "${PROMPT_LIMIT}" ]]; then
    cat >&2 <<EOF
Combined prompt inputs are ${size} bytes, which exceeds the Qwen runner limit (${PROMPT_LIMIT} bytes).
qwen reads piped stdin but truncates input beyond 8 MiB; the runner refuses
oversized inputs instead of dispatching a silently truncated prompt.
Set QWEN_MAX_PROMPT_BYTES to override this guard when appropriate.
EOF
    exit 2
  fi
}

parse_qwen_json() {
  # Batch `-o json` output: ONE JSON array of CLI messages. The final
  # `type:"result"` element carries is_error/subtype and the final text.
  # Optional 4th arg: a sidecar file that receives any recoverable assistant
  # text even on failure, plus a `tool_activity: true/false` header line.
  # Tool activity means the run may already have executed tools with side
  # effects; callers must not blindly re-dispatch such a failed attempt.
  # Exit codes: 0 ok; 11 error result/events; 12 no usable text; 13 bad shape.
  local raw_file="$1"
  local text_file="$2"
  local err_file="$3"
  local partial_file="${4:-}"

  python3 - "$raw_file" "$text_file" "$err_file" "$partial_file" <<'PY'
import json
import sys
from pathlib import Path

raw_path = Path(sys.argv[1])
text_path = Path(sys.argv[2])
err_path = Path(sys.argv[3])
partial_path = Path(sys.argv[4]) if sys.argv[4] else None

raw = raw_path.read_text(encoding="utf-8", errors="replace").strip()


def emit_partial(text, tool_activity):
    if partial_path is None:
        return
    body = text.rstrip() + "\n" if text.strip() else ""
    partial_path.write_text(f"tool_activity: {'true' if tool_activity else 'false'}\n{body}", encoding="utf-8")


def assistant_text_of(obj):
    message = obj.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return None


def has_tool_activity(obj):
    typ = obj.get("type")
    if typ in ("tool_use", "tool_result"):
        return True
    message = obj.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") in ("tool_use", "tool_result"):
                    return True
    return False


def salvage_objects(text):
    # Interrupted runs leave either newline-delimited events or ONE truncated
    # batch-array line. Recover complete objects from both shapes: try each
    # line as JSON, and for an unterminated '[' prefix use raw_decode to walk
    # the complete elements before the cut.
    objs = []
    decoder = json.JSONDecoder()
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            if line.startswith("["):
                idx = 1
                while idx < len(line):
                    while idx < len(line) and line[idx] in " \t\r\n,":
                        idx += 1
                    if idx >= len(line) or line[idx] == "]":
                        break
                    try:
                        obj, end = decoder.raw_decode(line, idx)
                    except Exception:
                        break
                    objs.append(obj)
                    idx = end
            continue
        if isinstance(obj, list):
            objs.extend(obj)
        else:
            objs.append(obj)
    return objs


def salvage_stream_lines(text):
    texts = []
    activity = False
    for obj in salvage_objects(text):
        if not isinstance(obj, dict):
            continue
        if has_tool_activity(obj):
            activity = True
        if obj.get("type") == "assistant":
            t = assistant_text_of(obj)
            if t and t.strip():
                texts.append(t)
    return "\n".join(texts), activity


if not raw:
    err_path.write_text("Qwen produced no JSON output.\n", encoding="utf-8")
    emit_partial("", False)
    raise SystemExit(12)

try:
    payload = json.loads(raw)
except Exception:
    salvaged, activity = salvage_stream_lines(raw)
    emit_partial(salvaged, activity)
    err_path.write_text(
        "Qwen stdout is not a single JSON document. First 240 chars: " + raw[:240] + "\n",
        encoding="utf-8",
    )
    raise SystemExit(13)

if isinstance(payload, dict):
    messages = [payload]
elif isinstance(payload, list):
    messages = payload
else:
    err_path.write_text("Unsupported Qwen JSON payload shape.\n", encoding="utf-8")
    emit_partial("", False)
    raise SystemExit(13)


def error_text(obj):
    err = obj.get("error")
    if isinstance(err, dict) and isinstance(err.get("message"), str):
        return err["message"]
    if isinstance(err, str):
        return err
    if isinstance(obj.get("result"), str) and obj["result"].strip():
        return obj["result"]
    return json.dumps(obj, ensure_ascii=False)[:500]


def assistant_text(obj):
    message = obj.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return None


results = []
assistants = []
errors = []
tool_activity = False
for obj in messages:
    if not isinstance(obj, dict):
        continue
    if has_tool_activity(obj):
        tool_activity = True
    typ = obj.get("type")
    if typ == "result":
        results.append(obj)
    elif typ == "assistant":
        text = assistant_text(obj)
        if text is not None:
            assistants.append(text)
    elif typ == "error" or obj.get("is_error") is True:
        errors.append(error_text(obj))

assistant_body = "\n".join(t for t in assistants if t.strip())

if errors:
    err_path.write_text(" | ".join(errors) + "\n", encoding="utf-8")
    emit_partial(assistant_body, tool_activity)
    raise SystemExit(11)

if not results:
    if messages and all(isinstance(m, dict) and m.get("type") not in
                        ("system", "user", "assistant", "tool_use", "tool_result") for m in messages):
        diagnostic = "Unsupported Qwen JSON payload shape."
    else:
        diagnostic = "No type:result message found in Qwen JSON output."
    err_path.write_text(diagnostic + "\n", encoding="utf-8")
    emit_partial(assistant_body, tool_activity)
    raise SystemExit(13)

result = results[-1]
if result.get("is_error") is True or result.get("subtype") not in (None, "success"):
    err_path.write_text(error_text(result) + "\n", encoding="utf-8")
    result_text = result.get("result") if isinstance(result.get("result"), str) else ""
    emit_partial(result_text or assistant_body, tool_activity)
    raise SystemExit(11)

text = result.get("result")
if not isinstance(text, str) or not text.strip():
    text = assistant_body
if not text.strip():
    err_path.write_text("Qwen result message carries no nonblank final text.\n", encoding="utf-8")
    emit_partial("", tool_activity)
    raise SystemExit(12)

text_path.write_text(text.rstrip() + "\n", encoding="utf-8")
err_path.write_text("", encoding="utf-8")
emit_partial(text, tool_activity)
PY
}

has_recorded_tool_activity() {
  # True when the parser sidecar reports executed/attempted tool calls.
  local partial_file="$1"
  [[ -s "${partial_file}" ]] && head -n 1 "${partial_file}" | grep -q '^tool_activity: true$'
}

is_model_not_found_error() {
  local stderr_file="$1"
  local parse_err_file="$2"
  grep -Eiq '(model not found|model.*not found|unknown model|invalid model|unrecognized model|model .*does not exist)' \
    "${stderr_file}" "${parse_err_file}" 2>/dev/null
}

is_deterministic_parse_error() {
  local code="$1"
  [[ "${code}" -eq 13 ]]
}

# Deterministic-failure classifier — duplicated verbatim in every *-cli-runner
# script (cross-skill imports are forbidden: each skill must stay self-contained).
# Retry-with-backoff exists for TRANSIENT failures (rate limits, network blips,
# 5xx, timeouts). Deterministic failures — usage errors, unbound variables,
# missing commands/files, auth or region ineligibility — reproduce identically
# on every retry, so the runner fails immediately with the diagnostic instead
# of burning the backoff budget re-running them.
# Usage: classify_deterministic_failure EXIT_CODE [DIAG_FILE...]
# Prints a one-line classification and returns 0 when (exit code, diagnostics)
# look deterministic; prints nothing and returns 1 when the failure may be
# transient (callers then keep their existing retry/fallback behavior).
classify_deterministic_failure() {
  local code="$1"
  shift
  local reason=""
  case "${code}" in
    2) reason="exit code 2 (usage/argument error)";;
    126) reason="exit code 126 (command found but not executable)";;
    127) reason="exit code 127 (command not found)";;
  esac
  if [[ -z "${reason}" ]]; then
    local f pat
    for f in "$@"; do
      [[ -n "${f}" && -s "${f}" ]] || continue
      for pat in \
        'unbound variable' \
        'command not found' \
        'no such file or directory' \
        'usage:' \
        'unrecognized argument' \
        'unknown option' \
        'invalid value' \
        'not eligible' \
        'not currently available in your location' \
        'location is not supported' \
        'unauthorized' \
        'forbidden' \
        'quota exhausted' \
        'quota exceeded' \
        'insufficient quota' \
        'usage limit reached' \
        "reached your usage limit for this billing cycle" \
        'out of usage' \
        'auto-rejecting' \
        'permission denied' \
        'invalid api key'; do
        if grep -qiF -- "${pat}" "${f}" 2>/dev/null; then
          reason="diagnostic output matched '${pat}'"
          break 2
        fi
      done
    done
  fi
  if [[ -z "${reason}" ]]; then
    return 1
  fi
  printf '%s\n' "${reason}"
}

CHECK_CLIENT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-client) CHECK_CLIENT=1; shift;;
    --model)
      require_value "$1" "${2-}"
      MODEL="$2"
      shift 2
      ;;
    --system-prompt-file)
      require_value "$1" "${2-}"
      SYSTEM_PROMPT_FILE="$2"
      shift 2
      ;;
    --prompt-file)
      require_value "$1" "${2-}"
      PROMPT_FILE="$2"
      shift 2
      ;;
    --out)
      require_value "$1" "${2-}"
      OUT="$2"
      shift 2
      ;;
    --tool-mode)
      require_value "$1" "${2-}"
      TOOL_MODE="$2"
      shift 2
      ;;
    --workspace-dir|--add-dir|--include-directories)
      require_value "$1" "${2-}"
      WORKSPACE_DIRS+=("$2")
      shift 2
      ;;
    --work-dir)
      require_value "$1" "${2-}"
      WORK_DIR="$2"
      WORK_DIR_EXPLICIT=1
      shift 2
      ;;
    --approval-mode)
      require_value "$1" "${2-}"
      APPROVAL_MODE="$2"
      shift 2
      ;;
    --allow-extensions) ALLOW_EXTENSIONS=1; shift 1;;
    --no-safe-mode) NO_SAFE_MODE=1; shift 1;;
    --max-session-turns)
      require_value "$1" "${2-}"
      MAX_SESSION_TURNS="$2"
      shift 2
      ;;
    --qwen-bin)
      require_value "$1" "${2-}"
      QWEN_BIN="$2"
      shift 2
      ;;
    --max-attempts|--max-retries)
      require_value "$1" "${2-}"
      MAX_ATTEMPTS="$2"
      shift 2
      ;;
    --sleep-secs)
      require_value "$1" "${2-}"
      SLEEP_SECS="$2"
      shift 2
      ;;
    --timeout-secs)
      require_value "$1" "${2-}"
      TIMEOUT_SECS="$2"
      shift 2
      ;;
    --raw-out)
      require_value "$1" "${2-}"
      RAW_OUT="$2"
      shift 2
      ;;
    --stderr-out)
      require_value "$1" "${2-}"
      STDERR_OUT="$2"
      shift 2
      ;;
    --trace-dir)
      require_value "$1" "${2-}"
      TRACE_DIR="$2"
      shift 2
      ;;
    --no-fallback) NO_FALLBACK=1; shift 1;;
    --resume-session)
      require_value "$1" "${2-}"
      RESUME_SESSION="$2"
      shift 2
      ;;
    --yolo)
      echo "Use --approval-mode yolo explicitly if you intend to auto-approve all tools; --yolo is not a runner shortcut." >&2
      exit 2
      ;;
    --dry-run) DRY_RUN=1; shift 1;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ "$CHECK_CLIENT" == 1 ]]; then
  exec python3 "$(dirname "${BASH_SOURCE[0]}")/client_compat.py" check "${QWEN_BIN}" "" --output-format --approval-mode --safe-mode --model
fi

if [[ -z "${PROMPT_FILE}" || -z "${OUT}" ]]; then
  echo "Missing required args: --prompt-file and --out are required." >&2
  usage
  exit 2
fi
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "Prompt file not found: ${PROMPT_FILE}" >&2
  exit 2
fi
if [[ -n "${SYSTEM_PROMPT_FILE}" && ! -f "${SYSTEM_PROMPT_FILE}" ]]; then
  echo "System prompt file not found: ${SYSTEM_PROMPT_FILE}" >&2
  exit 2
fi
if [[ -d "${OUT}" ]]; then
  echo "Output path points to a directory: ${OUT}" >&2
  exit 2
fi
if [[ -n "${RAW_OUT}" && -d "${RAW_OUT}" ]]; then
  echo "Raw output path points to a directory: ${RAW_OUT}" >&2
  exit 2
fi
if [[ -n "${STDERR_OUT}" && -d "${STDERR_OUT}" ]]; then
  echo "Stderr output path points to a directory: ${STDERR_OUT}" >&2
  exit 2
fi
# No output artifact may alias a prompt input: copying raw captures or the
# parsed body onto the prompt/system file would destroy the task inputs.
paths_collide() {
  local a="$1" b="$2"
  [[ -n "${a}" && -n "${b}" ]] || return 1
  if [[ "${a}" == "${b}" ]]; then return 0; fi
  if [[ -e "${a}" && -e "${b}" && "${a}" -ef "${b}" ]]; then return 0; fi
  local da db fa fb
  da="$(cd "$(dirname "${a}")" 2>/dev/null && pwd -P)" || return 1
  db="$(cd "$(dirname "${b}")" 2>/dev/null && pwd -P)" || return 1
  fa="$(basename "${a}")"; fb="$(basename "${b}")"
  [[ "${da}/${fa}" == "${db}/${fb}" ]]
}
for artifact in "${OUT}" "${OUT}.partial" "${RAW_OUT}" "${STDERR_OUT}"; do
  [[ -n "${artifact}" ]] || continue
  for input in "${PROMPT_FILE}" "${SYSTEM_PROMPT_FILE}"; do
    [[ -n "${input}" ]] || continue
    if paths_collide "${artifact}" "${input}"; then
      echo "Output path must differ from prompt inputs: ${artifact} aliases ${input}" >&2
      exit 2
    fi
  done
done
if ! [[ "${MAX_ATTEMPTS}" =~ ^[0-9]+$ ]] || [[ "${MAX_ATTEMPTS}" -lt 1 ]]; then
  echo "--max-attempts must be an integer >= 1" >&2
  exit 2
fi
if [[ "${MAX_ATTEMPTS}" -gt "${MAX_ATTEMPTS_HARD_MAX}" ]]; then
  echo "--max-attempts must be <= ${MAX_ATTEMPTS_HARD_MAX}" >&2
  exit 2
fi
if ! [[ "${SLEEP_SECS}" =~ ^[0-9]+$ ]] || [[ "${SLEEP_SECS}" -lt 1 ]]; then
  echo "--sleep-secs must be an integer >= 1" >&2
  exit 2
fi
if [[ "${SLEEP_SECS}" -gt "${MAX_BACKOFF_SECS}" ]]; then
  echo "--sleep-secs must be <= ${MAX_BACKOFF_SECS}" >&2
  exit 2
fi
if ! [[ "${TIMEOUT_SECS}" =~ ^[0-9]+$ ]]; then
  echo "--timeout-secs must be an integer >= 0" >&2
  exit 2
fi
if [[ -n "${MAX_SESSION_TURNS}" ]] && { ! [[ "${MAX_SESSION_TURNS}" =~ ^[0-9]+$ ]] || [[ "${MAX_SESSION_TURNS}" -lt 1 ]]; }; then
  echo "--max-session-turns must be an integer >= 1" >&2
  exit 2
fi
case "${TOOL_MODE}" in
  isolated|workspace) ;;
  *)
    echo "Invalid --tool-mode: '${TOOL_MODE}'. Expected isolated or workspace." >&2
    exit 2
    ;;
esac
if [[ "${TOOL_MODE}" != "workspace" && "${#WORKSPACE_DIRS[@]}" -gt 0 ]]; then
  echo "--workspace-dir requires --tool-mode workspace." >&2
  exit 2
fi
for dir in "${WORKSPACE_DIRS[@]+"${WORKSPACE_DIRS[@]}"}"; do
  if [[ ! -d "${dir}" ]]; then
    echo "Workspace directory not found: ${dir}" >&2
    exit 2
  fi
done
if [[ "${WORK_DIR_EXPLICIT}" -eq 1 && ! -d "${WORK_DIR}" ]]; then
  echo "Work directory not found: ${WORK_DIR}" >&2
  exit 2
fi
if [[ -n "${RESUME_SESSION}" && "${WORK_DIR_EXPLICIT}" -ne 1 ]]; then
  echo "--resume-session requires --work-dir DIR pointing at the prior run's working directory: qwen scopes recorded sessions per project directory, and the default fresh temporary directory has no sessions." >&2
  exit 2
fi
if [[ -z "${APPROVAL_MODE}" ]]; then
  if [[ "${TOOL_MODE}" == "isolated" ]]; then
    APPROVAL_MODE="plan"
  else
    APPROVAL_MODE="default"
  fi
fi
case "${APPROVAL_MODE}" in
  plan|default|auto-edit|auto|yolo) ;;
  *)
    echo "Invalid --approval-mode: '${APPROVAL_MODE}'. Expected plan, default, auto-edit, auto or yolo." >&2
    exit 2
    ;;
esac
if [[ "${NO_SAFE_MODE}" -eq 1 && "${TOOL_MODE}" != "isolated" ]]; then
  echo "--no-safe-mode only applies to --tool-mode isolated (workspace mode never passes --safe-mode)." >&2
  exit 2
fi
SAFE_MODE_ACTIVE=0
if [[ "${TOOL_MODE}" == "isolated" && "${NO_SAFE_MODE}" -ne 1 ]]; then
  SAFE_MODE_ACTIVE=1
fi
if [[ "${TOOL_MODE}" == "isolated" && "${APPROVAL_MODE}" != "plan" ]]; then
  echo "Warning: --approval-mode ${APPROVAL_MODE} in isolated mode can execute tools with automatic approval; isolation is not an OS sandbox." >&2
fi

if [[ "${TOOL_MODE}" == "workspace" && "${#WORKSPACE_DIRS[@]}" -eq 0 ]]; then
  WORKSPACE_DIRS+=("$(pwd -P)")
fi

PROMPT_LIMIT="$(prompt_limit_bytes)"
validate_prompt_size

if [[ "${DRY_RUN}" -eq 1 ]]; then
  prompt_size="$(file_size_bytes "${PROMPT_FILE}")"
  prompt_sha="$(file_sha256 "${PROMPT_FILE}")"

  echo "DRY RUN (no qwen call)"
  echo "Qwen binary: ${QWEN_BIN}"
  echo "Model: ${MODEL:-"(qwen config default)"}"
  echo "Output format: json (parsed final result text)"
  echo "Tool mode: ${TOOL_MODE}"
  echo "Approval mode: ${APPROVAL_MODE}"
  if [[ "${WORK_DIR_EXPLICIT}" -eq 1 ]]; then
    echo "Work dir: ${WORK_DIR}"
  else
    echo "Work dir: (temporary isolated directory)"
  fi
  if [[ "${#WORKSPACE_DIRS[@]}" -gt 0 ]]; then
    echo "Workspace dirs:"
    for dir in "${WORKSPACE_DIRS[@]}"; do
      echo "  --include-directories ${dir}"
    done
  else
    echo "Workspace dirs: (none)"
  fi
  if [[ "${SAFE_MODE_ACTIVE}" -eq 1 ]]; then
    echo "Safe mode: on (--safe-mode: no context files, hooks, extensions, skills or MCP servers)"
  else
    echo "Safe mode: off"
  fi
  if [[ "${ALLOW_EXTENSIONS}" -eq 1 ]]; then
    echo "Extensions: (qwen default loading)"
  elif [[ "${SAFE_MODE_ACTIVE}" -eq 1 ]]; then
    echo "Extensions: disabled (--safe-mode)"
  else
    echo "Extensions: disabled (-e none)"
  fi
  if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
    sys_size="$(file_size_bytes "${SYSTEM_PROMPT_FILE}")"
    sys_sha="$(file_sha256 "${SYSTEM_PROMPT_FILE}")"
    echo "System prompt file: ${SYSTEM_PROMPT_FILE} (bytes=${sys_size}, sha256=${sys_sha})"
  else
    echo "System prompt file: (none)"
  fi
  echo "Prompt file: ${PROMPT_FILE} (bytes=${prompt_size}, sha256=${prompt_sha})"
  echo "Prompt limit: ${PROMPT_LIMIT} bytes (stdin)"
  echo "Output: ${OUT}"
  if [[ "${TIMEOUT_SECS}" -gt 0 ]]; then
    echo "Timeout: ${TIMEOUT_SECS}s total invocation deadline"
  else
    echo "Timeout: disabled"
  fi
  if [[ -n "${RAW_OUT}" ]]; then
    echo "Raw output: ${RAW_OUT}"
  fi
  if [[ -n "${STDERR_OUT}" ]]; then
    echo "Stderr output: ${STDERR_OUT}"
  fi
  if [[ -n "${RESUME_SESSION}" ]]; then
    echo "Resume session: ${RESUME_SESSION}"
  fi
  echo "Invocation:"
  echo -n "  "
  # NOTE: this dry-run display array is built SEPARATELY from run_once() below —
  # when adding flags, update BOTH (a display-only edit silently diverges from
  # what actually runs).
  cmd=("${QWEN_BIN}")
  if [[ -n "${MODEL}" ]]; then
    cmd+=(-m "${MODEL}")
  fi
  cmd+=(-o json --approval-mode "${APPROVAL_MODE}")
  if [[ "${SAFE_MODE_ACTIVE}" -eq 1 ]]; then
    cmd+=(--safe-mode)
  elif [[ "${ALLOW_EXTENSIONS}" -ne 1 ]]; then
    cmd+=(-e none)
  fi
  if [[ -n "${MAX_SESSION_TURNS}" ]]; then
    cmd+=(--max-session-turns "${MAX_SESSION_TURNS}")
  fi
  if [[ -n "${RESUME_SESSION}" ]]; then
    cmd+=(-r "${RESUME_SESSION}")
  fi
  for dir in "${WORKSPACE_DIRS[@]+"${WORKSPACE_DIRS[@]}"}"; do
    cmd+=(--include-directories "${dir}")
  done
  if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
    cmd+=(--system-prompt "<system_prompt_file_content>")
  fi
  print_shell_cmd "${cmd[@]}"
  echo "< ${PROMPT_FILE}"
  exit 0
fi

if ! command -v "${QWEN_BIN}" >/dev/null 2>&1; then
  echo "qwen CLI not found in PATH: ${QWEN_BIN}" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found in PATH" >&2
  exit 2
fi

TEMP_WORK_DIR=""
if [[ "${WORK_DIR_EXPLICIT}" -eq 1 ]]; then
  RUN_WORK_DIR="$(abs_dir "${WORK_DIR}")"
else
  TEMP_WORK_DIR="$(mktemp -d)"
  RUN_WORK_DIR="${TEMP_WORK_DIR}"
fi

SYSTEM_PROMPT_TEXT=""
if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
  SYSTEM_PROMPT_TEXT="$(cat "${SYSTEM_PROMPT_FILE}"; printf '__QWEN_RUNNER_SYS_EOF__')"
  SYSTEM_PROMPT_TEXT="${SYSTEM_PROMPT_TEXT%__QWEN_RUNNER_SYS_EOF__}"
  if [[ ! "${SYSTEM_PROMPT_TEXT}" =~ [^[:space:]] ]]; then
    echo "System prompt file is blank: ${SYSTEM_PROMPT_FILE}" >&2
    exit 2
  fi
fi

tmp_stdout="$(mktemp)"
tmp_stderr="$(mktemp)"
tmp_text="$(mktemp)"
tmp_parse_err="$(mktemp)"
tmp_stdout_tail="$(mktemp)"
tmp_salvage="$(mktemp)"
mkdir -p "${TRACE_DIR:-${OUT}.attempts}"
TRACE_RUN_DIR="$(mktemp -d "${TRACE_DIR:-${OUT}.attempts}/run.XXXXXX")"
BUDGET_STATE="${TRACE_RUN_DIR}/budget.json"
budget_inputs=(--prompt-file "${PROMPT_FILE}" --out "${OUT}")
if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then budget_inputs+=(--system-file "${SYSTEM_PROMPT_FILE}"); fi
python3 "${PROCESS_BUDGET}" init --state "${BUDGET_STATE}" --max-attempts "${MAX_ATTEMPTS}" \
  --timeout-secs "${TIMEOUT_SECS}" "${budget_inputs[@]}"
copy_attempt_artifacts() {
  if [[ -n "${RAW_OUT}" ]]; then
    mkdir -p "$(dirname "${RAW_OUT}")"
    cp "${tmp_stdout}" "${RAW_OUT}"
  fi
  if [[ -n "${STDERR_OUT}" ]]; then
    mkdir -p "$(dirname "${STDERR_OUT}")"
    cp "${tmp_stderr}" "${STDERR_OUT}"
  fi
}
cleanup() {
  local result="${1:-$?}"
  if [[ -n "${ACTIVE_PID}" ]]; then
    kill -TERM "${ACTIVE_PID}" 2>/dev/null || true
    wait "${ACTIVE_PID}" 2>/dev/null || true
    ACTIVE_PID=""
  fi
  python3 "${PROCESS_BUDGET}" finish --state "${BUDGET_STATE}" --exit-code "${result}" || true
  rm -f "${tmp_stdout}" "${tmp_stderr}" "${tmp_text}" "${tmp_parse_err}" "${tmp_stdout_tail}" "${tmp_salvage}"
  if [[ -n "${TEMP_WORK_DIR}" ]]; then
    rm -rf "${TEMP_WORK_DIR}"
  fi
}
cleanup_and_exit() {
  local code="$1"
  cleanup "${code}"
  trap - EXIT INT TERM
  exit "${code}"
}
trap cleanup EXIT
trap 'cleanup_and_exit 130' INT
trap 'cleanup_and_exit 143' TERM

run_once() {
  local use_model="$1"

  # NOTE: keep in sync with the dry-run display array above (dual-site: display vs execution).
  local cmd=("${QWEN_BIN}")
  if [[ "${use_model}" -eq 1 && -n "${MODEL}" ]]; then
    cmd+=(-m "${MODEL}")
  fi
  cmd+=(-o json --approval-mode "${APPROVAL_MODE}")
  if [[ "${SAFE_MODE_ACTIVE}" -eq 1 ]]; then
    cmd+=(--safe-mode)
  elif [[ "${ALLOW_EXTENSIONS}" -ne 1 ]]; then
    cmd+=(-e none)
  fi
  if [[ -n "${MAX_SESSION_TURNS}" ]]; then
    cmd+=(--max-session-turns "${MAX_SESSION_TURNS}")
  fi
  if [[ -n "${RESUME_SESSION}" ]]; then
    cmd+=(-r "${RESUME_SESSION}")
  fi
  for dir in "${WORKSPACE_DIRS[@]+"${WORKSPACE_DIRS[@]}"}"; do
    cmd+=(--include-directories "$(abs_dir "${dir}")")
  done
  if [[ -n "${SYSTEM_PROMPT_TEXT}" ]]; then
    cmd+=(--system-prompt "${SYSTEM_PROMPT_TEXT}")
  fi

  python3 "${PROCESS_BUDGET}" run --state "${BUDGET_STATE}" --cwd "${RUN_WORK_DIR}" \
    --stdin "${PROMPT_FILE}" --stdout "${tmp_stdout}" --stderr "${tmp_stderr}" -- "${cmd[@]}" &
  ACTIVE_PID=$!
  local result=0
  wait "${ACTIVE_PID}" || result=$?
  ACTIVE_PID=""
  return "${result}"
}

run_mode() {
  local use_model="$1"
  local label="$2"
  local attempt=1
  local cli_code=0
  local code=0
  local parse_code=0
  local det_reason=""
  LAST_MODEL_NOT_FOUND=0

  while true; do
    : >"${tmp_stdout}"
    : >"${tmp_stderr}"
    : >"${tmp_text}"
    : >"${tmp_parse_err}"
    : >"${tmp_salvage}"

    if run_once "${use_model}"; then
      cli_code=0
    else
      cli_code=$?
    fi
    code="${cli_code}"
    copy_attempt_artifacts
    if [[ "${code}" -eq 124 || "${code}" -eq 125 ]]; then
      echo "Qwen total deadline or call budget exhausted (exit ${code})." >&2
      cat "${tmp_stderr}" >&2 || true
    fi
    # Always parse for salvage: recover any assistant body and tool-execution
    # evidence even when the batch document is incomplete or the run errored.
    parse_code=0
    parse_qwen_json "${tmp_stdout}" "${tmp_text}" "${tmp_parse_err}" "${tmp_salvage}" || parse_code=$?
    # A clean process exit is successful only when its JSON result is also
    # successful. Normalize that decision before saving partials or retrying.
    if [[ "${cli_code}" -eq 0 ]]; then
      code="${parse_code}"
      if [[ "${code}" -eq 0 ]]; then
        mkdir -p "$(dirname "${OUT}")"
        mv "${tmp_text}" "${OUT}"
        return 0
      fi
      cat "${tmp_parse_err}" >&2 || true
    fi

    # Both process failures and JSON-result failures reach the same handling.
    if [[ -s "${tmp_salvage}" ]] && tail -n +2 "${tmp_salvage}" | grep -q '[^[:space:]]'; then
      mkdir -p "$(dirname "${OUT}")"
      tail -n +2 "${tmp_salvage}" >"${OUT}.partial"
    fi
    # Tool activity may already have side effects. Stop before either retry
    # or model fallback; continuation requires an explicit session decision.
    if has_recorded_tool_activity "${tmp_salvage}"; then
      echo "Qwen attempt failed (exit ${code}) after recorded tool activity; not re-dispatching to avoid duplicating side effects. Recovered text (if any) is in ${OUT}.partial; raw events are under the trace dir. Use --resume-session with the recorded session ID to continue deliberately." >&2
      return "${code}"
    fi
    if [[ "${code}" -eq 124 || "${code}" -eq 125 || "${code}" -ge 128 ]]; then
      return "${code}"
    fi
    if [[ "${cli_code}" -eq 0 ]] && is_deterministic_parse_error "${parse_code}"; then
      if grep -q '^Unsupported Qwen JSON payload shape' "${tmp_parse_err}"; then
        python3 "${PROCESS_BUDGET%/*}/client_compat.py" output "${QWEN_BIN}" "Qwen batch JSON"
      fi
      echo "Qwen produced a deterministic parse failure in ${label} mode; not retrying identical output." >&2
      return "${code}"
    fi
    if [[ "${cli_code}" -ne 0 ]] &&
        python3 "${PROCESS_BUDGET%/*}/client_compat.py" options "${QWEN_BIN}" "${tmp_stderr}"; then
      return "${code}"
    fi
    if is_model_not_found_error "${tmp_stderr}" "${tmp_parse_err}"; then
      LAST_MODEL_NOT_FOUND=1
      return "${code}"
    fi

    # Deterministic failures reproduce identically on every retry: fail
    # immediately with the diagnostic instead of burning the backoff budget.
    # stderr and the parser's extracted error text are grepped in full; raw
    # stdout only by its TAIL, because the JSON transcript can carry
    # prompt/assistant text that merely QUOTES an error string, while a fatal
    # diagnostic lands at the end. Model-not-found strings are not in the
    # classifier's pattern list, so the default-model fallback keeps working.
    tail -n 40 "${tmp_stdout}" >"${tmp_stdout_tail}" 2>/dev/null || true
    if det_reason="$(classify_deterministic_failure "${code}" "${tmp_stderr}" "${tmp_parse_err}" "${tmp_stdout_tail}")"; then
      echo "Qwen failed with a deterministic error (${det_reason}) in ${label} mode; not retrying." >&2
      if [[ -s "${tmp_stderr}" ]]; then
        echo "stderr tail:" >&2
        tail -n 40 "${tmp_stderr}" >&2 || true
      fi
      return "${code}"
    fi

    if [[ "${attempt}" -ge "${MAX_ATTEMPTS}" ]]; then
      echo "Qwen failed in ${label} mode after ${MAX_ATTEMPTS} attempt(s) (last exit ${code})." >&2
      if [[ -s "${tmp_stderr}" ]]; then
        echo "stderr tail:" >&2
        tail -n 40 "${tmp_stderr}" >&2 || true
      fi
      if [[ -s "${tmp_stdout}" ]]; then
        echo "stdout tail:" >&2
        tail -n 40 "${tmp_stdout}" >&2 || true
      fi
      return "${code}"
    fi

    sleep_for=$(( SLEEP_SECS * (2 ** (attempt - 1)) ))
    if [[ "${sleep_for}" -gt "${MAX_BACKOFF_SECS}" ]]; then
      sleep_for="${MAX_BACKOFF_SECS}"
    fi
    echo "Attempt ${attempt} failed in ${label} mode (exit ${code}); retrying in ${sleep_for}s..." >&2
    python3 "${PROCESS_BUDGET}" sleep --state "${BUDGET_STATE}" --seconds "${sleep_for}" &
    ACTIVE_PID=$!
    local sleep_code=0
    wait "${ACTIVE_PID}" || sleep_code=$?
    ACTIVE_PID=""
    if [[ "${sleep_code}" -ne 0 ]]; then return "${sleep_code}"; fi
    attempt=$(( attempt + 1 ))
  done
}

if run_mode 1 "requested-model"; then
  primary_code=0
else
  primary_code=$?
fi

if [[ "${primary_code}" -eq 0 ]]; then
  exit 0
fi

if [[ -n "${MODEL}" && "${NO_FALLBACK}" -ne 1 && "${LAST_MODEL_NOT_FOUND}" -eq 1 ]]; then
  echo "Requested Qwen model failed as model-not-found; retrying with CLI default model..." >&2
  if run_mode 0 "default-model"; then
    exit 0
  else
    fallback_code=$?
    exit "${fallback_code}"
  fi
fi

exit "${primary_code}"
