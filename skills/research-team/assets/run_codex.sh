#!/usr/bin/env bash
set -euo pipefail

# Codex CLI runner: one-shot with file-based prompt input.
#
# Interface matches claude-cli-runner-style usage:
#   --model MODEL (optional)
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

usage() {
  cat <<'EOF'
run_codex.sh

Usage:
  run_codex.sh --system-prompt-file SYS.txt --prompt-file PROMPT.txt --out OUT.md

Options:
  --model MODEL              Optional (Codex model name/alias; defaults to Codex CLI config default).
  --system-prompt-file FILE  Required
  --prompt-file FILE         Required
  --out PATH                 Required
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
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
cmd+=( -c 'approval_policy="never"' - )

set +e
cat "${tmp_stdin}" | "${cmd[@]}" >"${tmp_stdout}" 2>"${tmp_stderr}"
code=$?
set -e

if [[ ${code} -ne 0 ]]; then
  cat "${tmp_stderr}" >&2
  if [[ -s "${tmp_stdout}" ]]; then
    echo "" >&2
    cat "${tmp_stdout}" >&2
  fi
  exit ${code}
fi

if [[ ! -s "${OUT}" ]]; then
  echo "ERROR: codex produced empty output: ${OUT}" >&2
  if [[ -s "${tmp_stderr}" ]]; then
    cat "${tmp_stderr}" >&2
  fi
  exit 2
fi

