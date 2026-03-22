#!/usr/bin/env bash
set -euo pipefail

# Claude CLI runner: one-shot (--print) with retries and file-based prompts.
#
# Why a script?
# - Avoids copy/paste errors with long prompts
# - Adds exponential backoff for transient overload/5xx
# - Keeps tool access disabled by default

MODEL=""
SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
MAX_RETRIES=6
SLEEP_SECS=10
TOOL_MODE="none"
TOOLS=""
TOOLS_EXPLICIT=0
STRICT_MCP_CONFIG=1
DRY_RUN=0

usage() {
  cat <<'EOF'
run_claude.sh

Usage:
  run_claude.sh --system-prompt-file SYS.txt --prompt-file PROMPT.txt --out OUT.txt

Options:
  --model MODEL            Optional. If omitted, uses Claude CLI configured default model.
  --tool-mode MODE         Default: "none". Choices: none, review. "review" maps to Read,Glob,Grep.
  --tools TOOLS            Explicit tool list override. Use "" to disable all tools.
  --strict-mcp-config      Default: enabled (skip MCP tool loading)
  --no-strict-mcp-config   Disable --strict-mcp-config
  --system-prompt-file F   Required
  --prompt-file F          Required
  --out PATH               Required (stdout+stderr captured)
  --dry-run                Print invocation details and exit 0 (no Claude call)
  --max-retries N          Default: 6
  --sleep-secs SECONDS     Default: 10 (base; exponential backoff)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --tool-mode) TOOL_MODE="$2"; shift 2;;
    --tools) TOOLS="$2"; TOOLS_EXPLICIT=1; shift 2;;
    --strict-mcp-config) STRICT_MCP_CONFIG=1; shift 1;;
    --no-strict-mcp-config) STRICT_MCP_CONFIG=0; shift 1;;
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift 1;;
    --max-retries) MAX_RETRIES="$2"; shift 2;;
    --sleep-secs) SLEEP_SECS="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ -z "${SYSTEM_PROMPT_FILE}" || -z "${PROMPT_FILE}" || -z "${OUT}" ]]; then
  echo "Missing required args." >&2
  usage
  exit 2
fi
if [[ ! -f "${SYSTEM_PROMPT_FILE}" ]]; then
  echo "System prompt file not found: ${SYSTEM_PROMPT_FILE}" >&2
  exit 2
fi
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "Prompt file not found: ${PROMPT_FILE}" >&2
  exit 2
fi

case "${TOOL_MODE}" in
  none)
    if [[ "${TOOLS_EXPLICIT}" -ne 1 ]]; then
      TOOLS=""
    fi
    ;;
  review)
    if [[ "${TOOLS_EXPLICIT}" -ne 1 ]]; then
      TOOLS='Read,Glob,Grep'
    fi
    ;;
  *)
    echo "Invalid --tool-mode: ${TOOL_MODE}. Expected one of: none, review" >&2
    exit 2
    ;;
esac

STRICT_ARG=()
if [[ "${STRICT_MCP_CONFIG}" -eq 1 ]]; then
  STRICT_ARG=(--strict-mcp-config)
fi

file_sha256() {
  local f="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${f}" | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${f}" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "${f}" | awk '{print $2}'
    return 0
  fi
  python3 - "${f}" <<'PY'
import hashlib
import sys
from pathlib import Path
p=Path(sys.argv[1])
h=hashlib.sha256()
with p.open("rb") as fp:
  for chunk in iter(lambda: fp.read(1024*1024), b""):
    h.update(chunk)
print(h.hexdigest())
PY
}

file_size_bytes() {
  local f="$1"
  if stat -f %z "${f}" >/dev/null 2>&1; then
    stat -f %z "${f}"
    return 0
  fi
  if stat -c %s "${f}" >/dev/null 2>&1; then
    stat -c %s "${f}"
    return 0
  fi
  wc -c <"${f}" | tr -d ' '
}

if [[ "${DRY_RUN}" -eq 1 ]]; then
  sys_size="$(file_size_bytes "${SYSTEM_PROMPT_FILE}")"
  sys_sha="$(file_sha256 "${SYSTEM_PROMPT_FILE}")"
  prompt_size="$(file_size_bytes "${PROMPT_FILE}")"
  prompt_sha="$(file_sha256 "${PROMPT_FILE}")"

  echo "DRY RUN (no Claude call)"
  if [[ -n "${MODEL}" ]]; then
    echo "Model: ${MODEL}"
  else
    echo "Model: (Claude CLI default)"
  fi
  echo "Tool mode: ${TOOL_MODE}"
  echo "Tools: ${TOOLS}"
  if [[ "${STRICT_MCP_CONFIG}" -eq 1 ]]; then
    echo "Strict MCP config: enabled (--strict-mcp-config)"
  else
    echo "Strict MCP config: disabled (--no-strict-mcp-config)"
  fi
  echo "System prompt file: ${SYSTEM_PROMPT_FILE} (bytes=${sys_size}, sha256=${sys_sha})"
  echo "Prompt file (stdin): ${PROMPT_FILE} (bytes=${prompt_size}, sha256=${prompt_sha})"
  echo "Output (stdout+stderr): ${OUT}"
  echo "Invocation:"
  echo -n "  claude --print --no-session-persistence"
  if [[ "${STRICT_MCP_CONFIG}" -eq 1 ]]; then
    echo -n " --strict-mcp-config"
  fi
  if [[ -n "${MODEL}" ]]; then
    echo -n " --model ${MODEL}"
  fi
  printf ' --tools %q --input-format text --system-prompt <omitted> < %q > %q\n' "${TOOLS}" "${PROMPT_FILE}" "${OUT}"
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found in PATH" >&2
  exit 2
fi

SYSTEM_PROMPT="$(cat "${SYSTEM_PROMPT_FILE}")"
declare -a MODEL_ARG=()
if [[ -n "${MODEL}" ]]; then
  MODEL_ARG=(--model "${MODEL}")
fi

tmp_out="$(mktemp)"
tmp_stdout="$(mktemp)"
tmp_stderr="$(mktemp)"
trap 'rm -f "${tmp_out}" "${tmp_stdout}" "${tmp_stderr}"' EXIT

ATTEMPT_LOG_DIR="${RESEARCH_TEAM_ATTEMPT_LOG_DIR:-}"
ATTEMPT_LOG_PREFIX="${RESEARCH_TEAM_ATTEMPT_LOG_PREFIX:-}"
ATTEMPT_EXCERPT_LINES="${RESEARCH_TEAM_ATTEMPT_EXCERPT_LINES:-20}"
ATTEMPT_LOG_ENABLED=0

if [[ -n "${ATTEMPT_LOG_DIR}" ]]; then
  if mkdir -p "${ATTEMPT_LOG_DIR}" >/dev/null 2>&1 && [[ -w "${ATTEMPT_LOG_DIR}" ]]; then
    ATTEMPT_LOG_ENABLED=1
  fi
fi

write_attempt_logs() {
  local attempt_no="$1"
  local exit_code="$2"
  local backoff_secs="$3"
  local stdout_file="$4"
  local stderr_file="$5"
  if [[ "${ATTEMPT_LOG_ENABLED}" -ne 1 ]]; then
    return 0
  fi

  local attempt_tag=""
  local base=""
  local stdout_log=""
  local stderr_log=""
  local meta_log=""
  local ts=""

  printf -v attempt_tag '%02d' "${attempt_no}"
  base="${ATTEMPT_LOG_DIR}/${ATTEMPT_LOG_PREFIX}attempt_${attempt_tag}"
  stdout_log="${base}.stdout.log"
  stderr_log="${base}.stderr.log"
  meta_log="${base}.meta.json"

  cp "${stdout_file}" "${stdout_log}" 2>/dev/null || true
  cp "${stderr_file}" "${stderr_log}" 2>/dev/null || true

  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  python3 - "${attempt_no}" "${exit_code}" "${backoff_secs}" "${MODEL:-default}" "${stdout_log}" "${stderr_log}" "${ts}" >"${meta_log}" 2>/dev/null <<'PY' || true
import json
import sys

attempt_no = int(sys.argv[1])
exit_code = int(sys.argv[2])
backoff_secs = int(sys.argv[3])
model = sys.argv[4]
stdout_log = sys.argv[5]
stderr_log = sys.argv[6]
timestamp = sys.argv[7]

obj = {
    "attempt": attempt_no,
    "exit_code": exit_code,
    "backoff_secs": backoff_secs,
    "model": model,
    "timestamp_utc": timestamp,
    "stdout_log": stdout_log,
    "stderr_log": stderr_log,
}
print(json.dumps(obj, ensure_ascii=False))
PY
}

print_stderr_excerpt() {
  local stderr_file="$1"
  if [[ ! -s "${stderr_file}" ]]; then
    return 0
  fi
  echo "  stderr tail (last ${ATTEMPT_EXCERPT_LINES} lines):" >&2
  tail -n "${ATTEMPT_EXCERPT_LINES}" "${stderr_file}" >&2 || true
}

attempt=1
while true; do
  : >"${tmp_stdout}"
  : >"${tmp_stderr}"
  set +e
  claude --print --no-session-persistence "${STRICT_ARG[@]}" "${MODEL_ARG[@]+"${MODEL_ARG[@]}"}" --tools "${TOOLS}" \
    --input-format text \
    --system-prompt "${SYSTEM_PROMPT}" \
    <"${PROMPT_FILE}" >"${tmp_stdout}" 2>"${tmp_stderr}"
  code=$?
  set -e

  cat "${tmp_stdout}" "${tmp_stderr}" >"${tmp_out}" || true

  sleep_for=0
  if [[ $attempt -lt $MAX_RETRIES ]]; then
    sleep_for=$(( SLEEP_SECS * (2 ** (attempt - 1)) ))
  fi
  write_attempt_logs "${attempt}" "${code}" "${sleep_for}" "${tmp_stdout}" "${tmp_stderr}"

  if [[ $code -eq 0 ]]; then
    mkdir -p "$(dirname "${OUT}")"
    mv "${tmp_out}" "${OUT}"
    exit 0
  fi

  if [[ $attempt -ge $MAX_RETRIES ]]; then
    echo "Claude failed after ${MAX_RETRIES} attempts (last exit ${code})." >&2
    cat "${tmp_out}" >&2
    exit $code
  fi

  echo "Attempt ${attempt} failed (exit ${code}); retrying in ${sleep_for}s..." >&2
  print_stderr_excerpt "${tmp_stderr}"
  sleep "${sleep_for}"
  attempt=$(( attempt + 1 ))
done
