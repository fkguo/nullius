#!/usr/bin/env bash
set -euo pipefail

# OpenCode CLI runner: one-shot mode with JSON event parsing, optional
# model fallback, and exponential-backoff retries.

SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
MODEL=""
AGENT=""
VARIANT=""
THINKING=0
DRY_RUN=0
NO_FALLBACK=0
MAX_ATTEMPTS=3
MAX_ATTEMPTS_HARD_MAX=20
SLEEP_SECS=5
MAX_BACKOFF_SECS=300

usage() {
  cat <<'EOF'
run_opencode.sh

Usage:
  run_opencode.sh --prompt-file PROMPT.txt --out OUT.txt

Options:
  --model MODEL           Optional model in provider/model format (e.g. openai/gpt-5)
  --agent AGENT           Optional OpenCode agent name
  --variant VARIANT       Optional model variant (provider-specific)
  --thinking              Show thinking blocks in OpenCode output events
  --system-prompt-file F  Optional. Prepended to stdin before prompt file.
  --prompt-file FILE      Required
  --out PATH              Required
  --max-attempts N        Total attempts per run mode (default: 3)
  --max-retries N         Deprecated alias of --max-attempts
  --sleep-secs SECONDS    Exponential backoff base seconds (default: 5)
  --no-fallback           Do not retry without -m when a model run fails
  --dry-run               Print invocation details and exit 0
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
    python3 - <<'PY' "$1"
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
  return 0
}

print_shell_cmd() {
  while (($#)); do
    printf '%q ' "$1"
    shift
  done
}

parse_opencode_json() {
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

raw = raw_path.read_text(encoding="utf-8", errors="replace")
lines = raw.splitlines()

text_chunks = []
error_msgs = []
non_json_lines = []

for line in lines:
    stripped = line.strip()
    if not stripped:
        continue
    try:
        obj = json.loads(stripped)
    except Exception:
        non_json_lines.append(line)
        continue

    if not isinstance(obj, dict):
        continue

    typ = obj.get("type")
    if typ == "text":
        part = obj.get("part")
        if isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                text_chunks.append(text)
    elif typ == "error":
        err = obj.get("error")
        msg = ""
        if isinstance(err, dict):
            data = err.get("data")
            if isinstance(data, dict) and isinstance(data.get("message"), str):
                msg = data["message"]
            elif isinstance(err.get("message"), str):
                msg = err["message"]
            elif isinstance(err.get("name"), str):
                msg = err["name"]
        elif err is not None:
            msg = str(err)
        if not msg:
            msg = "OpenCode returned an error event."
        error_msgs.append(msg)

if error_msgs:
    joined = " | ".join(error_msgs)
    err_path.write_text(joined + "\n", encoding="utf-8")
    lowered = joined.lower()
    if "model not found" in lowered or "providermodelnotfounderror" in lowered:
        raise SystemExit(10)
    raise SystemExit(11)

if not text_chunks:
    msg = "No text events found in OpenCode JSON output."
    if non_json_lines:
        msg += " First raw line: " + non_json_lines[0][:240]
    err_path.write_text(msg + "\n", encoding="utf-8")
    raise SystemExit(12)

merged = "".join(text_chunks)
if not merged.endswith("\n"):
    merged += "\n"
text_path.write_text(merged, encoding="utf-8")
err_path.write_text("", encoding="utf-8")
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      require_value "$1" "${2-}"
      MODEL="$2"
      shift 2
      ;;
    --agent)
      require_value "$1" "${2-}"
      AGENT="$2"
      shift 2
      ;;
    --variant)
      require_value "$1" "${2-}"
      VARIANT="$2"
      shift 2
      ;;
    --thinking) THINKING=1; shift 1;;
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
    --no-fallback) NO_FALLBACK=1; shift 1;;
    --dry-run) DRY_RUN=1; shift 1;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ -z "${PROMPT_FILE}" || -z "${OUT}" ]]; then
  echo "Missing required args." >&2
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
if [[ -n "${MODEL}" ]]; then
  if [[ ! "${MODEL}" =~ ^[^/]+/[^/]+$ ]]; then
    echo "Invalid --model format: '${MODEL}'. Expected provider/model." >&2
    exit 2
  fi
fi

prompt_bytes="$(file_size_bytes "${PROMPT_FILE}")"
prompt_sha256="$(file_sha256 "${PROMPT_FILE}")"

system_bytes=""
system_sha256=""
stdin_desc="$(printf '%q' "${PROMPT_FILE}")"
if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
  system_bytes="$(file_size_bytes "${SYSTEM_PROMPT_FILE}")"
  system_sha256="$(file_sha256 "${SYSTEM_PROMPT_FILE}")"
  stdin_desc="concat($(printf '%q' "${SYSTEM_PROMPT_FILE}"), blank_line, $(printf '%q' "${PROMPT_FILE}"))"
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "dry_run: 1"
  if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
    echo "system_prompt_file: ${SYSTEM_PROMPT_FILE}"
    echo "system_prompt_bytes: ${system_bytes}"
    echo "system_prompt_sha256: ${system_sha256}"
  else
    echo "system_prompt_file: (none)"
  fi
  echo "prompt_file: ${PROMPT_FILE}"
  echo "prompt_bytes: ${prompt_bytes}"
  echo "prompt_sha256: ${prompt_sha256}"
  echo "stdin: ${stdin_desc}"
  echo "out: ${OUT}"
  echo "max_attempts: ${MAX_ATTEMPTS}"
  echo "sleep_secs: ${SLEEP_SECS}"
  if [[ -n "${MODEL}" ]]; then
    echo "model: ${MODEL}"
  else
    echo "model: (default)"
  fi
  if [[ -n "${AGENT}" ]]; then
    echo "agent: ${AGENT}"
  fi
  if [[ -n "${VARIANT}" ]]; then
    echo "variant: ${VARIANT}"
  fi
  echo "thinking: ${THINKING}"
  echo "no_fallback: ${NO_FALLBACK}"

  cmd=(opencode run --format json)
  if [[ -n "${MODEL}" ]]; then
    cmd+=(-m "${MODEL}")
  fi
  if [[ -n "${AGENT}" ]]; then
    cmd+=(--agent "${AGENT}")
  fi
  if [[ -n "${VARIANT}" ]]; then
    cmd+=(--variant "${VARIANT}")
  fi
  if [[ "${THINKING}" -eq 1 ]]; then
    cmd+=(--thinking)
  fi
  echo -n "command: "; print_shell_cmd "${cmd[@]}"; echo
  if [[ -n "${MODEL}" && "${NO_FALLBACK}" -ne 1 ]]; then
    fallback_cmd=(opencode run --format json)
    if [[ -n "${AGENT}" ]]; then
      fallback_cmd+=(--agent "${AGENT}")
    fi
    if [[ -n "${VARIANT}" ]]; then
      fallback_cmd+=(--variant "${VARIANT}")
    fi
    if [[ "${THINKING}" -eq 1 ]]; then
      fallback_cmd+=(--thinking)
    fi
    echo -n "fallback_command: "; print_shell_cmd "${fallback_cmd[@]}"; echo
  fi
  exit 0
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode CLI not found in PATH" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found in PATH (required for JSON parsing)" >&2
  exit 2
fi

tmp_dir="$(mktemp -d)"
stdin_file="${PROMPT_FILE}"
combined_stdin=""
last_raw=""
last_err=""
last_stderr=""

cleanup() {
  rm -rf "${tmp_dir}" || true
}
trap cleanup EXIT

if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
  combined_stdin="${tmp_dir}/combined_stdin.txt"
  python3 - "${SYSTEM_PROMPT_FILE}" "${PROMPT_FILE}" "${combined_stdin}" <<'PY'
import sys
from pathlib import Path

system = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").rstrip("\n")
prompt = Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace")
Path(sys.argv[3]).write_text(system + "\n\n" + prompt, encoding="utf-8")
PY
  stdin_file="${combined_stdin}"
fi

run_once() {
  local use_model="$1"
  local raw_file="$2"
  local text_file="$3"
  local err_file="$4"
  local stderr_file="$5"
  local -a cmd
  local cmd_code=0
  local parse_code=0

  cmd=(opencode run --format json)
  if [[ "${use_model}" -eq 1 && -n "${MODEL}" ]]; then
    cmd+=(-m "${MODEL}")
  fi
  if [[ -n "${AGENT}" ]]; then
    cmd+=(--agent "${AGENT}")
  fi
  if [[ -n "${VARIANT}" ]]; then
    cmd+=(--variant "${VARIANT}")
  fi
  if [[ "${THINKING}" -eq 1 ]]; then
    cmd+=(--thinking)
  fi

  set +e
  "${cmd[@]}" <"${stdin_file}" >"${raw_file}" 2>"${stderr_file}"
  cmd_code=$?
  set -e

  parse_opencode_json "${raw_file}" "${text_file}" "${err_file}" || parse_code=$?

  if [[ "${parse_code}" -eq 0 && "${cmd_code}" -eq 0 ]]; then
    return 0
  fi
  if [[ "${parse_code}" -eq 0 && "${cmd_code}" -ne 0 ]]; then
    {
      printf 'OpenCode exited with code %s but produced valid text output.\n' "${cmd_code}"
      if [[ -s "${stderr_file}" ]]; then
        echo "stderr tail:"
        tail -n 20 "${stderr_file}" || true
      fi
    } >"${err_file}"
    cat "${err_file}" >&2
    return 0
  fi

  {
    printf 'OpenCode exit code: %s\n' "${cmd_code}"
    if [[ -s "${stderr_file}" ]]; then
      echo "stderr tail:"
      tail -n 20 "${stderr_file}" || true
    fi
  } >>"${err_file}"
  return "${parse_code}"
}

run_with_retries() {
  local use_model="$1"
  local label="$2"

  local attempt=1
  local raw_file
  local text_file
  local err_file
  local stderr_file
  local rc=0
  local sleep_for=0

  while true; do
    raw_file="${tmp_dir}/raw_${label}_${attempt}.log"
    text_file="${tmp_dir}/text_${label}_${attempt}.txt"
    err_file="${tmp_dir}/err_${label}_${attempt}.txt"
    stderr_file="${tmp_dir}/stderr_${label}_${attempt}.log"

    rc=0
    run_once "${use_model}" "${raw_file}" "${text_file}" "${err_file}" "${stderr_file}" || rc=$?
    last_raw="${raw_file}"
    last_err="${err_file}"
    last_stderr="${stderr_file}"

    if [[ "${rc}" -eq 0 ]]; then
      mkdir -p "$(dirname "${OUT}")"
      mv "${text_file}" "${OUT}"
      return 0
    fi

    if [[ "${rc}" -eq 10 ]]; then
      return 10
    fi

    if [[ "${attempt}" -ge "${MAX_ATTEMPTS}" ]]; then
      return "${rc}"
    fi

    sleep_for=$(( SLEEP_SECS * (2 ** (attempt - 1)) ))
    if [[ "${sleep_for}" -gt "${MAX_BACKOFF_SECS}" ]]; then
      sleep_for="${MAX_BACKOFF_SECS}"
    fi
    echo "OpenCode attempt ${attempt} (${label}) failed; retrying in ${sleep_for}s..." >&2
    if [[ -s "${err_file}" ]]; then
      tail -n 5 "${err_file}" >&2 || true
    fi
    sleep "${sleep_for}"
    attempt=$(( attempt + 1 ))
  done
}

print_failure() {
  local message="$1"
  echo "${message}" >&2
  if [[ -n "${last_err}" && -f "${last_err}" && -s "${last_err}" ]]; then
    echo "Failure detail:" >&2
    cat "${last_err}" >&2
  fi
  if [[ -n "${last_raw}" && -f "${last_raw}" ]]; then
    echo "Raw output tail:" >&2
    tail -n 40 "${last_raw}" >&2 || true
  fi
  if [[ -n "${last_stderr}" && -f "${last_stderr}" && -s "${last_stderr}" ]]; then
    echo "stderr tail:" >&2
    tail -n 40 "${last_stderr}" >&2 || true
  fi
}

if [[ -n "${MODEL}" ]]; then
  primary_rc=0
  run_with_retries 1 "model" || primary_rc=$?
  if [[ "${primary_rc}" -eq 0 ]]; then
    exit 0
  fi

  if [[ "${NO_FALLBACK}" -eq 1 ]]; then
    print_failure "OpenCode run failed with model '${MODEL}' and fallback is disabled."
    exit 1
  fi
  if [[ "${primary_rc}" -ne 10 ]]; then
    print_failure "OpenCode run failed with model '${MODEL}'. Not retrying with default model because failure is not model-not-found."
    exit 1
  fi

  echo "OpenCode run with model '${MODEL}' failed; retrying with CLI default model..." >&2
  fallback_rc=0
  run_with_retries 0 "default" || fallback_rc=$?
  if [[ "${fallback_rc}" -eq 0 ]]; then
    exit 0
  fi

  print_failure "OpenCode fallback run (default model) failed."
  exit 1
fi

single_rc=0
run_with_retries 0 "default" || single_rc=$?
if [[ "${single_rc}" -eq 0 ]]; then
  exit 0
fi

print_failure "OpenCode run failed."
exit 1
