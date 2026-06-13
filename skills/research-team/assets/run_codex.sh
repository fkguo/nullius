#!/usr/bin/env bash
set -euo pipefail

# Codex CLI runner: one-shot with file-based prompt input.
#
# Interface matches claude-cli-runner-style usage:
#   --model MODEL (optional)
#   --reasoning-effort low|medium|high|xhigh (optional)
#   --system-prompt-file FILE (required)
#   --prompt-file FILE (required)
#   --out PATH (required)
#
# Notes:
# - Uses stdin to avoid command-length limits.
# - Runs with --sandbox read-only for safety.

SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
MODEL=""
REASONING_EFFORT=""
MAX_RETRIES=6
SLEEP_SECS=10

usage() {
  cat <<'EOF'
run_codex.sh

Usage:
  run_codex.sh --system-prompt-file SYS.txt --prompt-file PROMPT.txt --out OUT.md

Options:
  --model MODEL              Optional (Codex model name/alias; defaults to Codex CLI config default).
  --reasoning-effort EFFORT  Optional Codex reasoning effort: low|medium|high|xhigh.
  --system-prompt-file FILE  Required
  --prompt-file FILE         Required
  --out PATH                 Required
  --max-retries N            Optional retry cap on failure / empty output (default: 6).
  --sleep-secs SECONDS       Optional base backoff seconds, exponential (default: 10).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --reasoning-effort) REASONING_EFFORT="$2"; shift 2;;
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
if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found in PATH" >&2
  exit 2
fi
if [[ -n "${REASONING_EFFORT}" ]]; then
  case "${REASONING_EFFORT}" in
    low|medium|high|xhigh) ;;
    *)
      echo "Invalid --reasoning-effort: ${REASONING_EFFORT} (allowed: low|medium|high|xhigh)" >&2
      exit 2
      ;;
  esac
fi
if ! [[ "${MAX_RETRIES}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --max-retries: ${MAX_RETRIES} (must be a positive integer)" >&2
  exit 2
fi
if ! [[ "${SLEEP_SECS}" =~ ^[0-9]+$ ]]; then
  echo "Invalid --sleep-secs: ${SLEEP_SECS} (must be a non-negative integer)" >&2
  exit 2
fi

tmp_stdin="$(mktemp)"
tmp_stdout="$(mktemp)"
tmp_stderr="$(mktemp)"
trap 'rm -f "${tmp_stdin}" "${tmp_stdout}" "${tmp_stderr}"' EXIT

{
  echo "SYSTEM (follow strictly):"
  cat "${SYSTEM_PROMPT_FILE}"
  echo
  echo "USER:"
  cat "${PROMPT_FILE}"
} >"${tmp_stdin}"

mkdir -p "$(dirname "${OUT}")"

cmd=( codex exec --sandbox read-only --skip-git-repo-check --output-last-message "${OUT}" )
if [[ -n "${MODEL}" ]]; then
  cmd+=( --model "${MODEL}" )
fi
if [[ -n "${REASONING_EFFORT}" ]]; then
  cmd+=( -c "model_reasoning_effort=\"${REASONING_EFFORT}\"" )
fi
cmd+=( -c 'approval_policy="never"' - )

# Retry on failure OR the known "codex exits 0 with an empty output file" mode
# (documented incident: codex exec returns 0 but --output-last-message is never
# written for large/long runs). Exponential backoff, capped at --max-retries.
attempt=1
while true; do
  : >"${tmp_stdout}"
  : >"${tmp_stderr}"
  rm -f "${OUT}"

  set +e
  cat "${tmp_stdin}" | "${cmd[@]}" >"${tmp_stdout}" 2>"${tmp_stderr}"
  code=$?
  set -e

  if [[ ${code} -eq 0 && -s "${OUT}" ]]; then
    exit 0
  fi

  if [[ ${code} -eq 0 ]]; then
    reason="exit 0 but empty output ${OUT}"
    code=2
  else
    reason="exit ${code}"
  fi

  {
    cat "${tmp_stderr}"
    if [[ -s "${tmp_stdout}" ]]; then
      echo ""
      cat "${tmp_stdout}"
    fi
  } >&2

  if [[ ${attempt} -ge ${MAX_RETRIES} ]]; then
    echo "ERROR: codex failed after ${MAX_RETRIES} attempt(s) (${reason})" >&2
    exit ${code}
  fi

  sleep_for=$(( SLEEP_SECS * (2 ** (attempt - 1)) ))
  echo "Attempt ${attempt} failed (${reason}); retrying in ${sleep_for}s..." >&2
  sleep "${sleep_for}"
  attempt=$(( attempt + 1 ))
done
