#!/usr/bin/env bash
set -euo pipefail

# Kimi Code CLI runner: one-shot prompt mode with file-based inputs,
# isolated default working directory, stream-json parsing, retries, and
# model fallback.

MODEL=""
SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
KIMI_BIN="${KIMI_BIN:-kimi}"
TOOL_MODE="isolated"
WORK_DIR=""
WORK_DIR_EXPLICIT=0
WORKSPACE_DIRS=()
SKILLS_DIRS=()
AUTO_SKILLS=0
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
YOLO=0
RESUME_SESSION=""
CONTINUE_WORK_DIR=0

usage() {
  cat <<'EOF'
run_kimi.sh

Usage:
  run_kimi.sh --prompt-file PROMPT.txt --out OUT.txt

Options:
  --model MODEL           Optional Kimi model alias. If invalid, can fall back to CLI default.
  --tool-mode MODE        Default: isolated. Choices: isolated, workspace.
                          "none" is accepted as a legacy alias for isolated.
  --workspace-dir DIR     Repeatable. Expose a workspace via Kimi --add-dir in workspace mode.
                           If omitted in workspace mode, defaults to the current cwd.
  --work-dir DIR          Advanced. Run Kimi from this directory instead of an isolated temp dir.
  --skills-dir DIR        Repeatable. Pass through Kimi --skills-dir. Replaces auto-discovery.
  --auto-skills           Allow Kimi to auto-discover user/project skills instead of using
                          the runner's default empty temporary skills directory.
  --kimi-bin PATH         Kimi executable (default: kimi)
  --system-prompt-file F  Optional. Prepended to the prompt file.
  --prompt-file FILE      Required.
  --out PATH              Required.
  --max-attempts N        Total attempts per run mode (default: 3)
  --max-retries N         Deprecated alias of --max-attempts
  --sleep-secs SECONDS    Exponential backoff base seconds (default: 5)
  --timeout-secs SECONDS  Per-attempt hard timeout for the Kimi subprocess.
                          Default: 900. Use 0 to disable.
  --raw-out FILE          Optional. Copy raw Kimi stdout from the last attempt here.
  --stderr-out FILE       Optional. Copy raw Kimi stderr from the last attempt here.
  --no-fallback           Do not retry without -m when a model run fails as model-not-found.
  --yolo                  Pass Kimi -y (auto-approve all actions). Needed for headless agentic
                          tasks whose tool actions would otherwise wait for interactive approval.
  --resume-session ID     Resume a specific recorded Kimi session (kimi -S ID); the prompt is the
                          session's next turn.
  --continue-work-dir     Continue the previous session OF THE WORKING DIRECTORY (kimi -c).
                          Requires --work-dir DIR pointing at the prior run's directory — Kimi
                          scopes -c per working directory, so this is non-racy across parallel
                          runs in different directories (the default isolated fresh temp dir has
                          no previous session to continue).
  --dry-run               Print invocation details and exit 0.

Important:
  Kimi Code prompt mode currently accepts -p/--prompt <prompt>, not stdin or a
  prompt-file flag. The runner reads prompt files but must pass the merged prompt
  as a CLI argument internally. Large merged prompts are rejected before exec.
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

default_prompt_limit_bytes() {
  local arg_max="131072"
  local computed="98304"
  if command -v getconf >/dev/null 2>&1; then
    arg_max="$(getconf ARG_MAX 2>/dev/null || echo 131072)"
  fi
  if [[ "${arg_max}" =~ ^[0-9]+$ ]] && [[ "${arg_max}" -gt 0 ]]; then
    computed=$(( arg_max / 2 ))
    if [[ "${computed}" -gt 131072 ]]; then
      computed=131072
    fi
    if [[ "${computed}" -lt 32768 ]]; then
      computed=32768
    fi
  fi
  echo "${computed}"
}

prompt_limit_bytes() {
  local limit="${KIMI_MAX_PROMPT_BYTES:-}"
  if [[ -z "${limit}" ]]; then
    default_prompt_limit_bytes
    return 0
  fi
  if ! [[ "${limit}" =~ ^[0-9]+$ ]] || [[ "${limit}" -lt 1 ]]; then
    echo "KIMI_MAX_PROMPT_BYTES must be an integer >= 1" >&2
    exit 2
  fi
  echo "${limit}"
}

abs_dir() {
  local dir="$1"
  (cd "${dir}" && pwd -P)
}

build_merged_prompt() {
  local merged
  merged="$(mktemp)"
  if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
    {
      echo "=== System Instructions ==="
      cat "${SYSTEM_PROMPT_FILE}"
      echo ""
      echo "=== Task ==="
      cat "${PROMPT_FILE}"
    } >"${merged}"
  else
    cat "${PROMPT_FILE}" >"${merged}"
  fi
  echo "${merged}"
}

validate_prompt_size() {
  local merged="$1"
  local limit="$2"
  local size
  size="$(file_size_bytes "${merged}")"
  if [[ "${size}" -gt "${limit}" ]]; then
    cat >&2 <<EOF
Merged prompt is ${size} bytes, which exceeds the Kimi runner limit (${limit} bytes).
Kimi Code prompt mode currently accepts only -p/--prompt <prompt>; no stdin or
--prompt-file flag is available, so large prompts can hit OS ARG_MAX.
Set KIMI_MAX_PROMPT_BYTES to override this guard when appropriate.
EOF
    exit 2
  fi
}

parse_kimi_stream_json() {
  local raw_file="$1"
  local text_file="$2"
  local err_file="$3"

  python3 - "$raw_file" "$text_file" "$err_file" <<'PY'
import json
import sys
from pathlib import Path

raw_path = Path(sys.argv[1])
text_path = Path(sys.argv[2])
err_path = Path(sys.argv[3])

chunks = []
errors = []
non_json = []
unknown_assistant_shapes = []


def text_from_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                typ = item.get("type")
                text = item.get("text")
                if (typ in (None, "text")) and isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        if parts:
            return "".join(parts)
    return None


def error_from_obj(obj):
    content = obj.get("content")
    if isinstance(content, str):
        return content
    err = obj.get("error")
    if isinstance(err, str):
        return err
    if isinstance(err, dict):
        message = err.get("message")
        if isinstance(message, str):
            return message
        data = err.get("data")
        if isinstance(data, dict) and isinstance(data.get("message"), str):
            return data["message"]
    message = obj.get("message")
    if isinstance(message, str):
        return message
    return json.dumps(obj, ensure_ascii=False)

for line in raw_path.read_text(encoding="utf-8", errors="replace").splitlines():
    stripped = line.strip()
    if not stripped:
        continue
    try:
        obj = json.loads(stripped)
    except Exception:
        non_json.append(line)
        continue
    if not isinstance(obj, dict):
        continue
    role = obj.get("role")
    typ = obj.get("type")
    content = obj.get("content")
    if role == "assistant":
        text = text_from_content(content)
        if text is not None:
            chunks.append(text)
        elif content is not None:
            unknown_assistant_shapes.append(json.dumps(obj, ensure_ascii=False)[:500])
    elif role == "error" or typ == "error" or obj.get("error"):
        errors.append(error_from_obj(obj))

if errors:
    err_path.write_text(" | ".join(errors) + "\n", encoding="utf-8")
    raise SystemExit(11)

if unknown_assistant_shapes:
    err_path.write_text(
        "Unsupported assistant content shape in Kimi stream-json output. First raw object: "
        + unknown_assistant_shapes[0]
        + "\n",
        encoding="utf-8",
    )
    raise SystemExit(13)

if not chunks:
    msg = "No assistant content found in Kimi stream-json output."
    if non_json:
        msg += " First raw line: " + non_json[0][:240]
    err_path.write_text(msg + "\n", encoding="utf-8")
    raise SystemExit(12)

merged = ""
for chunk in chunks:
    if not merged:
        merged = chunk
        continue
    if not merged.endswith("\n"):
        merged += "\n"
    merged += chunk

text_path.write_text(merged.rstrip() + "\n", encoding="utf-8")
err_path.write_text("", encoding="utf-8")
PY
}

is_model_not_found_error() {
  local stdout_file="$1"
  local stderr_file="$2"
  grep -Eiq '(model not found|model.*not found|unknown model|invalid model|unrecognized model|model .*does not exist)' \
    "${stdout_file}" "${stderr_file}" 2>/dev/null
}

is_deterministic_parse_error() {
  local code="$1"
  [[ "${code}" -eq 12 || "${code}" -eq 13 ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      require_value "$1" "${2-}"
      MODEL="$2"
      shift 2
      ;;
    --tool-mode)
      require_value "$1" "${2-}"
      TOOL_MODE="$2"
      shift 2
      ;;
    --workspace-dir|--add-dir)
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
    --skills-dir)
      require_value "$1" "${2-}"
      SKILLS_DIRS+=("$2")
      shift 2
      ;;
    --auto-skills) AUTO_SKILLS=1; shift 1;;
    --kimi-bin)
      require_value "$1" "${2-}"
      KIMI_BIN="$2"
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
    --max-attempts)
      require_value "$1" "${2-}"
      MAX_ATTEMPTS="$2"
      shift 2
      ;;
    --max-retries)
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
    --no-fallback) NO_FALLBACK=1; shift 1;;
    --yolo) YOLO=1; shift 1;;
    --resume-session)
      require_value "$1" "${2-}"
      RESUME_SESSION="$2"
      shift 2
      ;;
    --continue-work-dir) CONTINUE_WORK_DIR=1; shift 1;;
    --dry-run) DRY_RUN=1; shift 1;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ -z "${PROMPT_FILE}" || -z "${OUT}" ]]; then
  echo "Missing required args: --prompt-file and --out are required." >&2
  usage
  exit 2
fi
if [[ -n "${SYSTEM_PROMPT_FILE}" && ! -f "${SYSTEM_PROMPT_FILE}" ]]; then
  echo "System prompt file not found: ${SYSTEM_PROMPT_FILE}" >&2
  exit 2
fi
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "Prompt file not found: ${PROMPT_FILE}" >&2
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
if [[ -n "${RESUME_SESSION}" && "${CONTINUE_WORK_DIR}" -eq 1 ]]; then
  echo "--resume-session and --continue-work-dir are mutually exclusive." >&2
  exit 2
fi
if [[ "${CONTINUE_WORK_DIR}" -eq 1 && -z "${WORK_DIR}" ]]; then
  echo "--continue-work-dir requires --work-dir DIR: kimi -c continues the previous session OF THE WORKING DIRECTORY, and the default isolated fresh temp dir has none." >&2
  exit 2
fi
case "${TOOL_MODE}" in
  none) TOOL_MODE="isolated" ;;
  isolated|workspace) ;;
  *)
    echo "Invalid --tool-mode: '${TOOL_MODE}'. Expected isolated or workspace." >&2
    exit 2
    ;;
esac
if [[ "${TOOL_MODE}" != "workspace" && "${#WORKSPACE_DIRS[@]}" -gt 0 ]]; then
  echo "--workspace-dir/--add-dir requires --tool-mode workspace." >&2
  exit 2
fi
for dir in "${WORKSPACE_DIRS[@]+"${WORKSPACE_DIRS[@]}"}"; do
  if [[ ! -d "${dir}" ]]; then
    echo "Workspace directory not found: ${dir}" >&2
    exit 2
  fi
done
for dir in "${SKILLS_DIRS[@]+"${SKILLS_DIRS[@]}"}"; do
  if [[ ! -d "${dir}" ]]; then
    echo "Skills directory not found: ${dir}" >&2
    exit 2
  fi
done
if [[ "${AUTO_SKILLS}" -eq 1 && "${#SKILLS_DIRS[@]}" -gt 0 ]]; then
  echo "--auto-skills cannot be combined with --skills-dir." >&2
  exit 2
fi
if [[ "${WORK_DIR_EXPLICIT}" -eq 1 && ! -d "${WORK_DIR}" ]]; then
  echo "Work directory not found: ${WORK_DIR}" >&2
  exit 2
fi

if [[ "${TOOL_MODE}" == "workspace" && "${#WORKSPACE_DIRS[@]}" -eq 0 ]]; then
  WORKSPACE_DIRS+=("$(pwd -P)")
fi

PROMPT_LIMIT="$(prompt_limit_bytes)"
MERGED_PROMPT="$(build_merged_prompt)"
trap 'rm -f "${MERGED_PROMPT}"' EXIT
validate_prompt_size "${MERGED_PROMPT}" "${PROMPT_LIMIT}"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  prompt_size="$(file_size_bytes "${PROMPT_FILE}")"
  prompt_sha="$(file_sha256 "${PROMPT_FILE}")"
  merged_size="$(file_size_bytes "${MERGED_PROMPT}")"
  merged_sha="$(file_sha256 "${MERGED_PROMPT}")"

  echo "DRY RUN (no Kimi call)"
  echo "Kimi binary: ${KIMI_BIN}"
  echo "Model: ${MODEL:-"(Kimi config default)"}"
  echo "Output format: stream-json (parsed assistant content)"
  echo "Tool mode: ${TOOL_MODE}"
  if [[ "${WORK_DIR_EXPLICIT}" -eq 1 ]]; then
    echo "Work dir: ${WORK_DIR}"
  else
    echo "Work dir: (temporary isolated directory)"
  fi
  if [[ "${#WORKSPACE_DIRS[@]}" -gt 0 ]]; then
    echo "Workspace dirs:"
    for dir in "${WORKSPACE_DIRS[@]}"; do
      echo "  --add-dir ${dir}"
    done
  else
    echo "Workspace dirs: (none)"
  fi
  if [[ "${#SKILLS_DIRS[@]}" -gt 0 ]]; then
    echo "Skills dirs:"
    for dir in "${SKILLS_DIRS[@]}"; do
      echo "  --skills-dir ${dir}"
    done
  elif [[ "${AUTO_SKILLS}" -eq 1 ]]; then
    echo "Skills dirs: (auto-discovered)"
  else
    echo "Skills dirs: (empty temporary directory)"
  fi
  if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
    sys_size="$(file_size_bytes "${SYSTEM_PROMPT_FILE}")"
    sys_sha="$(file_sha256 "${SYSTEM_PROMPT_FILE}")"
    echo "System prompt file: ${SYSTEM_PROMPT_FILE} (bytes=${sys_size}, sha256=${sys_sha})"
  fi
  echo "Prompt file: ${PROMPT_FILE} (bytes=${prompt_size}, sha256=${prompt_sha})"
  echo "Merged prompt: bytes=${merged_size}, sha256=${merged_sha}, limit=${PROMPT_LIMIT}"
  echo "Output: ${OUT}"
  if [[ "${TIMEOUT_SECS}" -gt 0 ]]; then
    echo "Timeout: ${TIMEOUT_SECS}s per attempt"
  else
    echo "Timeout: disabled"
  fi
  if [[ -n "${RAW_OUT}" ]]; then
    echo "Raw output: ${RAW_OUT}"
  fi
  if [[ -n "${STDERR_OUT}" ]]; then
    echo "Stderr output: ${STDERR_OUT}"
  fi
  echo "Invocation:"
  echo -n "  "
  # NOTE: this dry-run display array is built SEPARATELY from run_once() below — when adding flags,
  # update BOTH (a display-only edit silently diverges from what actually runs).
  cmd=("${KIMI_BIN}")
  if [[ -n "${MODEL}" ]]; then
    cmd+=(-m "${MODEL}")
  fi
  cmd+=(--output-format stream-json)
  if [[ "${YOLO}" -eq 1 ]]; then
    cmd+=(-y)
  fi
  if [[ -n "${RESUME_SESSION}" ]]; then
    cmd+=(-S "${RESUME_SESSION}")
  elif [[ "${CONTINUE_WORK_DIR}" -eq 1 ]]; then
    cmd+=(-c)
  fi
  for dir in "${SKILLS_DIRS[@]+"${SKILLS_DIRS[@]}"}"; do
    cmd+=(--skills-dir "${dir}")
  done
  if [[ "${#SKILLS_DIRS[@]}" -eq 0 && "${AUTO_SKILLS}" -ne 1 ]]; then
    cmd+=(--skills-dir "<empty_temp_skills_dir>")
  fi
  for dir in "${WORKSPACE_DIRS[@]+"${WORKSPACE_DIRS[@]}"}"; do
    cmd+=(--add-dir "${dir}")
  done
  cmd+=(-p "<merged_prompt>")
  print_shell_cmd "${cmd[@]}"
  echo
  exit 0
fi

if ! command -v "${KIMI_BIN}" >/dev/null 2>&1; then
  echo "kimi CLI not found in PATH: ${KIMI_BIN}" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found in PATH" >&2
  exit 2
fi

TEMP_WORK_DIR=""
TEMP_SKILLS_DIR=""
if [[ "${WORK_DIR_EXPLICIT}" -eq 1 ]]; then
  RUN_WORK_DIR="$(abs_dir "${WORK_DIR}")"
else
  TEMP_WORK_DIR="$(mktemp -d)"
  RUN_WORK_DIR="${TEMP_WORK_DIR}"
fi
if [[ "${#SKILLS_DIRS[@]}" -eq 0 && "${AUTO_SKILLS}" -ne 1 ]]; then
  TEMP_SKILLS_DIR="$(mktemp -d)"
  SKILLS_DIRS+=("${TEMP_SKILLS_DIR}")
fi

tmp_stdout="$(mktemp)"
tmp_stderr="$(mktemp)"
tmp_text="$(mktemp)"
tmp_parse_err="$(mktemp)"
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
  rm -f "${MERGED_PROMPT}" "${tmp_stdout}" "${tmp_stderr}" "${tmp_text}" "${tmp_parse_err}"
  if [[ -n "${TEMP_WORK_DIR}" ]]; then
    rm -rf "${TEMP_WORK_DIR}"
  fi
  if [[ -n "${TEMP_SKILLS_DIR}" ]]; then
    rm -rf "${TEMP_SKILLS_DIR}"
  fi
}
cleanup_and_exit() {
  local code="$1"
  cleanup
  trap - EXIT INT TERM
  exit "${code}"
}
trap cleanup EXIT
trap 'cleanup_and_exit 130' INT
trap 'cleanup_and_exit 143' TERM

run_once() {
  local use_model="$1"
  local prompt_text
  prompt_text="$(cat "${MERGED_PROMPT}"; printf '__KIMI_RUNNER_PROMPT_EOF__')"
  prompt_text="${prompt_text%__KIMI_RUNNER_PROMPT_EOF__}"

  # NOTE: keep in sync with the dry-run display array above (dual-site: display vs execution).
  local cmd=("${KIMI_BIN}")
  if [[ "${use_model}" -eq 1 && -n "${MODEL}" ]]; then
    cmd+=(-m "${MODEL}")
  fi
  cmd+=(--output-format stream-json)
  if [[ "${YOLO}" -eq 1 ]]; then
    cmd+=(-y)
  fi
  if [[ -n "${RESUME_SESSION}" ]]; then
    cmd+=(-S "${RESUME_SESSION}")
  elif [[ "${CONTINUE_WORK_DIR}" -eq 1 ]]; then
    cmd+=(-c)
  fi
  for dir in "${SKILLS_DIRS[@]+"${SKILLS_DIRS[@]}"}"; do
    cmd+=(--skills-dir "$(abs_dir "${dir}")")
  done
  for dir in "${WORKSPACE_DIRS[@]+"${WORKSPACE_DIRS[@]}"}"; do
    cmd+=(--add-dir "$(abs_dir "${dir}")")
  done
  cmd+=(-p "${prompt_text}")

  if [[ "${TIMEOUT_SECS}" -eq 0 ]]; then
    (
      cd "${RUN_WORK_DIR}"
      "${cmd[@]}"
    ) >"${tmp_stdout}" 2>"${tmp_stderr}"
    return $?
  fi

  python3 - "${RUN_WORK_DIR}" "${TIMEOUT_SECS}" "${tmp_stdout}" "${tmp_stderr}" "${cmd[@]}" <<'PY'
import subprocess
import sys
from pathlib import Path

cwd = sys.argv[1]
timeout = int(sys.argv[2])
stdout_path = Path(sys.argv[3])
stderr_path = Path(sys.argv[4])
cmd = sys.argv[5:]

with stdout_path.open("wb") as stdout, stderr_path.open("ab") as stderr:
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            stdout=stdout,
            stderr=stderr,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        stderr.write(f"Kimi subprocess timed out after {timeout}s.\n".encode("utf-8"))
        raise SystemExit(124)

raise SystemExit(proc.returncode)
PY
}

run_mode() {
  local use_model="$1"
  local label="$2"
  local attempt=1
  local code=0
  local parse_code=0
  LAST_MODEL_NOT_FOUND=0

  while true; do
    : >"${tmp_stdout}"
    : >"${tmp_stderr}"
    : >"${tmp_text}"
    : >"${tmp_parse_err}"

    if run_once "${use_model}"; then
      code=0
    else
      code=$?
    fi
    copy_attempt_artifacts
    if [[ "${code}" -ne 0 ]] && is_model_not_found_error "${tmp_stdout}" "${tmp_stderr}"; then
      LAST_MODEL_NOT_FOUND=1
    fi

    parse_code=0
    if [[ "${code}" -eq 0 ]]; then
      if parse_kimi_stream_json "${tmp_stdout}" "${tmp_text}" "${tmp_parse_err}"; then
        parse_code=0
      else
        parse_code=$?
      fi
      if [[ "${parse_code}" -eq 0 ]]; then
        mkdir -p "$(dirname "${OUT}")"
        mv "${tmp_text}" "${OUT}"
        return 0
      fi
      cat "${tmp_parse_err}" >&2 || true
      code="${parse_code}"
      if is_deterministic_parse_error "${parse_code}"; then
        echo "Kimi produced a deterministic parse failure in ${label} mode; not retrying identical output." >&2
        return "${parse_code}"
      fi
    fi

    if [[ "${attempt}" -ge "${MAX_ATTEMPTS}" ]]; then
      echo "Kimi failed in ${label} mode after ${MAX_ATTEMPTS} attempt(s) (last exit ${code})." >&2
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
    sleep "${sleep_for}"
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
  echo "Requested Kimi model failed as model-not-found; retrying with CLI default model..." >&2
  if run_mode 0 "default-model"; then
    exit 0
  else
    fallback_code=$?
    exit "${fallback_code}"
  fi
fi

exit "${primary_code}"
