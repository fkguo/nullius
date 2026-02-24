#!/usr/bin/env bash
set -euo pipefail

# Claude CLI runner: one-shot (--print) with retries and file-based prompts.
# Vendored copy for project-local use.

MODEL=""
SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
MAX_RETRIES=6
SLEEP_SECS=10
TOOLS='""'

usage() {
  cat <<'EOF'
run_claude.sh

Usage:
  run_claude.sh --system-prompt-file SYS.txt --prompt-file PROMPT.txt --out OUT.txt

Options:
  --model MODEL            Optional (defaults to claude CLI default)
  --tools TOOLS            Default: "" (disable tools). Example: "default"
  --system-prompt-file F   Required
  --prompt-file F          Required
  --out PATH               Required (stdout+stderr captured)
  --max-retries N          Default: 6
  --sleep-secs SECONDS     Default: 10 (base; exponential backoff)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --tools) TOOLS="$2"; shift 2;;
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
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
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found in PATH" >&2
  exit 2
fi

SYSTEM_PROMPT="$(cat "${SYSTEM_PROMPT_FILE}")"
PROMPT="$(cat "${PROMPT_FILE}")"

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
  python3 - "${attempt_no}" "${exit_code}" "${backoff_secs}" "${MODEL}" "${stdout_log}" "${stderr_log}" "${ts}" >"${meta_log}" 2>/dev/null <<'PY' || true
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
  if [[ -n "${MODEL}" ]]; then
    # shellcheck disable=SC2086
    claude --print --no-session-persistence --model "${MODEL}" --tools ${TOOLS} \
      --system-prompt "${SYSTEM_PROMPT}" \
      "${PROMPT}" >"${tmp_stdout}" 2>"${tmp_stderr}"
  else
    # shellcheck disable=SC2086
    claude --print --no-session-persistence --tools ${TOOLS} \
      --system-prompt "${SYSTEM_PROMPT}" \
      "${PROMPT}" >"${tmp_stdout}" 2>"${tmp_stderr}"
  fi
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
