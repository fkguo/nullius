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
PERSIST_SESSION=0
SESSION_ID_FILE=""
RESUME_SESSION=""

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

Session continuation (OPT-IN; the default stays a clean-room one-shot with --no-session-persistence):
  --persist-session        Record this conversation so a later invocation can resume it.
  --session-id-file FILE   Also capture the new session id to FILE (implies --persist-session).
                           Internally switches to --output-format json; OUT then receives ONLY the
                           final result text (parsed from the JSON envelope), not raw stdout+stderr.
  --resume-session ID      Send this prompt as the NEXT turn of a previously persisted session
                           (claude --resume ID; implies --persist-session). Chain multi-turn
                           workflows: run 1 with --session-id-file, run 2 with --resume-session.
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
    --persist-session) PERSIST_SESSION=1; shift 1;;
    --session-id-file) SESSION_ID_FILE="$2"; shift 2;;
    --resume-session) RESUME_SESSION="$2"; shift 2;;
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

# Session semantics: the runner's default contract is a CLEAN-ROOM one-shot (claude
# --no-session-persistence — nothing recorded, nothing resumable). Session features are opt-in and
# any of them implies persistence; --session-id-file additionally switches the claude output to the
# JSON envelope so the new session id can be extracted programmatically.
if [[ -n "${SESSION_ID_FILE}" || -n "${RESUME_SESSION}" ]]; then
  PERSIST_SESSION=1
fi
SESSION_ARGS=()
if [[ "${PERSIST_SESSION}" -ne 1 ]]; then
  SESSION_ARGS+=(--no-session-persistence)
fi
if [[ -n "${RESUME_SESSION}" ]]; then
  SESSION_ARGS+=(--resume "${RESUME_SESSION}")
fi
FORMAT_ARGS=()
if [[ -n "${SESSION_ID_FILE}" ]]; then
  FORMAT_ARGS=(--output-format json)
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
  if [[ "${PERSIST_SESSION}" -eq 1 ]]; then
    echo -n "Session: persisted"
    [[ -n "${RESUME_SESSION}" ]] && echo -n ", resuming ${RESUME_SESSION}"
    [[ -n "${SESSION_ID_FILE}" ]] && echo -n ", id -> ${SESSION_ID_FILE}"
    echo ""
  fi
  echo "Invocation:"
  # NOTE: this display is built SEPARATELY from the real invocation in the retry loop below — when
  # adding flags, update BOTH (a display-only edit silently diverges from what actually runs).
  echo -n "  claude --print"
  if [[ "${PERSIST_SESSION}" -ne 1 ]]; then
    echo -n " --no-session-persistence"
  fi
  if [[ -n "${RESUME_SESSION}" ]]; then
    echo -n " --resume ${RESUME_SESSION}"
  fi
  if [[ -n "${SESSION_ID_FILE}" ]]; then
    echo -n " --output-format json"
  fi
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
        'invalid value' \
        'not eligible' \
        'not currently available in your location' \
        'location is not supported' \
        'unauthorized' \
        'forbidden' \
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

attempt=1
while true; do
  : >"${tmp_stdout}"
  : >"${tmp_stderr}"
  set +e
  claude --print "${SESSION_ARGS[@]+"${SESSION_ARGS[@]}"}" "${FORMAT_ARGS[@]+"${FORMAT_ARGS[@]}"}" "${STRICT_ARG[@]}" "${MODEL_ARG[@]+"${MODEL_ARG[@]}"}" --tools "${TOOLS}" \
    --input-format text \
    --system-prompt "${SYSTEM_PROMPT}" \
    <"${PROMPT_FILE}" >"${tmp_stdout}" 2>"${tmp_stderr}"
  code=$?
  set -e

  if [[ $code -eq 0 && -n "${SESSION_ID_FILE}" ]]; then
    # JSON-envelope mode: OUT receives only the final result text; the new session id goes to its
    # own file so a later invocation can chain with --resume-session.
    if python3 - "${tmp_stdout}" "${tmp_out}" "${SESSION_ID_FILE}" <<'PY'
import json
import sys

raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
obj = json.loads(raw)
result = obj.get("result")
sid = obj.get("session_id")
if not isinstance(result, str) or not isinstance(sid, str) or not sid:
    raise SystemExit(1)
open(sys.argv[2], "w", encoding="utf-8").write(result)
open(sys.argv[3], "w", encoding="utf-8").write(sid + "\n")
PY
    then
      :
    else
      echo "Warning: could not parse the claude JSON envelope; OUT falls back to raw stdout+stderr and NO session id was captured." >&2
      cat "${tmp_stdout}" "${tmp_stderr}" >"${tmp_out}" || true
    fi
  else
    cat "${tmp_stdout}" "${tmp_stderr}" >"${tmp_out}" || true
  fi

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

  # Deterministic failures reproduce identically on every retry: fail
  # immediately with the diagnostic instead of burning the backoff budget.
  if det_reason="$(classify_deterministic_failure "${code}" "${tmp_stderr}")"; then
    echo "Claude failed with a deterministic error (${det_reason}); not retrying." >&2
    cat "${tmp_out}" >&2
    exit $code
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
