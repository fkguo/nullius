#!/usr/bin/env bash
set -euo pipefail

# Codex CLI runner: one-shot (codex exec) with retries, file-based prompts,
# and exponential backoff.
#
# Analogous to run_claude.sh / run_gemini.sh but for the OpenAI Codex CLI.
# Uses `codex exec` in non-interactive mode. The sandbox is controlled SOLELY by
# --sandbox (default read-only). The runner intentionally never passes codex's
# deprecated --full-auto flag: in codex >=0.140 `--full-auto` silently implies
# `--sandbox workspace-write`, which would OVERRIDE the read-only default and
# hand a review / text-generation run write access. Non-interactivity is pinned
# via `-c approval_policy="never"` instead (codex exec has no approval prompts to
# skip). Request write access explicitly with `--sandbox workspace-write`.

MODEL=""
SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
SANDBOX="read-only"
PROFILE=""
SKIP_GIT_CHECK=1
MAX_RETRIES=6
SLEEP_SECS=10
DRY_RUN=0
EXTRA_CONFIGS=()

usage() {
  cat <<'EOF'
run_codex.sh — One-shot Codex CLI runner with retries

Usage:
  run_codex.sh --prompt-file PROMPT.txt --out OUT.txt [OPTIONS]

Required:
  --prompt-file FILE          User prompt file (fed via stdin)
  --out PATH                  Output file (agent's last message)

Optional:
  --model MODEL               Model override (e.g. o3, gpt-4.1)
  --system-prompt-file FILE   System instructions (prepended to prompt)
  --sandbox MODE              read-only | workspace-write | danger-full-access (default: read-only)
  --profile PROFILE           Config profile from config.toml
  --config KEY=VALUE          Repeatable config overrides (-c)
  --skip-git-repo-check       Run outside git repos (default: enabled)
  --no-skip-git-repo-check    Require git repo
  --max-retries N             Default: 6
  --sleep-secs SECONDS        Base sleep; exponential backoff (default: 10)
  --dry-run                   Print planned command; exit 0 (no Codex call)
  -h, --help                  Show this help

Sandbox safety:
  Defaults to --sandbox read-only (no file writes), the safe policy for review
  and text-generation. Pass --sandbox workspace-write to allow writes in the
  working directory. The runner never sends codex's deprecated --full-auto flag,
  so the selected sandbox is never silently upgraded to workspace-write.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --sandbox) SANDBOX="$2"; shift 2;;
    --profile) PROFILE="$2"; shift 2;;
    --config) EXTRA_CONFIGS+=("$2"); shift 2;;
    --skip-git-repo-check) SKIP_GIT_CHECK=1; shift 1;;
    --no-skip-git-repo-check) SKIP_GIT_CHECK=0; shift 1;;
    --max-retries) MAX_RETRIES="$2"; shift 2;;
    --sleep-secs) SLEEP_SECS="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift 1;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

# --- Validation ---

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
case "${SANDBOX}" in
  read-only|workspace-write|danger-full-access) ;;
  *)
    echo "Invalid --sandbox: ${SANDBOX} (allowed: read-only, workspace-write, danger-full-access)" >&2
    exit 2
    ;;
esac

# --- Helpers ---

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
    openssl dgst -sha256 "${f}" | awk '{print $NF}'
    return 0
  fi
  python3 - "${f}" <<'PY'
import hashlib, sys
from pathlib import Path
h = hashlib.sha256()
with Path(sys.argv[1]).open("rb") as fp:
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

# --- Build merged prompt (system + user) ---

build_merged_prompt() {
  local tmp_merged
  tmp_merged="$(mktemp)"

  if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
    {
      echo "=== System Instructions ==="
      cat "${SYSTEM_PROMPT_FILE}"
      echo ""
      echo "=== Task ==="
      cat "${PROMPT_FILE}"
    } >"${tmp_merged}"
  else
    cat "${PROMPT_FILE}" >"${tmp_merged}"
  fi

  echo "${tmp_merged}"
}

# --- Build codex exec args (single source of truth for dry-run AND execution) ---
#
# Populates the global CMD_ARGS array. Sandbox is whatever --sandbox selected
# (default read-only); the --sandbox flag is authoritative in codex (it wins over
# a -c sandbox_mode override), so the runner's sandbox is unambiguous.
# approval_policy is pinned to "never" so the run stays unattended regardless of
# config.toml, WITHOUT upgrading the sandbox; a user --config approval_policy=...
# is appended afterward so it can still override.
# No --full-auto is ever emitted (it would force workspace-write).
CMD_ARGS=()
build_cmd_args() {
  CMD_ARGS=()

  if [[ -n "${MODEL}" ]]; then
    CMD_ARGS+=(-m "${MODEL}")
  fi

  CMD_ARGS+=(--sandbox "${SANDBOX}")

  if [[ "${SKIP_GIT_CHECK}" -eq 1 ]]; then
    CMD_ARGS+=(--skip-git-repo-check)
  fi

  if [[ -n "${PROFILE}" ]]; then
    CMD_ARGS+=(-p "${PROFILE}")
  fi

  CMD_ARGS+=(-c 'approval_policy="never"')

  for cfg in "${EXTRA_CONFIGS[@]+"${EXTRA_CONFIGS[@]}"}"; do
    CMD_ARGS+=(-c "${cfg}")
  done

  CMD_ARGS+=(-o "${OUT}")

  # Read prompt from stdin
  CMD_ARGS+=(-)
}

# --- Dry run ---

if [[ "${DRY_RUN}" -eq 1 ]]; then
  build_cmd_args

  prompt_size="$(file_size_bytes "${PROMPT_FILE}")"
  prompt_sha="$(file_sha256 "${PROMPT_FILE}")"

  echo "DRY RUN (no Codex call)"
  echo "Model: ${MODEL:-"(from config.toml)"}"
  echo "Sandbox: ${SANDBOX}"
  echo "Approval policy: never (pinned)"
  echo "Skip git check: ${SKIP_GIT_CHECK}"

  if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
    sys_size="$(file_size_bytes "${SYSTEM_PROMPT_FILE}")"
    sys_sha="$(file_sha256 "${SYSTEM_PROMPT_FILE}")"
    echo "System prompt file: ${SYSTEM_PROMPT_FILE} (bytes=${sys_size}, sha256=${sys_sha})"
  fi

  echo "Prompt file (stdin): ${PROMPT_FILE} (bytes=${prompt_size}, sha256=${prompt_sha})"
  echo "Output: ${OUT}"

  if [[ -n "${PROFILE}" ]]; then
    echo "Profile: ${PROFILE}"
  fi

  if [[ ${#EXTRA_CONFIGS[@]} -gt 0 ]]; then
    echo "Config overrides:"
    for cfg in "${EXTRA_CONFIGS[@]}"; do
      echo "  -c ${cfg}"
    done
  fi

  # Print the planned invocation as the exact TOKEN sequence from CMD_ARGS (the
  # same array execution passes to codex), so --dry-run reflects the real sandbox
  # and flags. This is a readable token list, not a shell-quoted copy-paste line:
  # a -c value containing spaces/quotes prints unquoted — the token sequence,
  # not re-shelling fidelity, is what the safety check relies on.
  echo ""
  echo "Invocation:"
  echo -n "  codex exec"
  for arg in "${CMD_ARGS[@]}"; do
    echo -n " ${arg}"
  done
  echo " < <merged_prompt>"
  exit 0
fi

# --- Preflight ---

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found in PATH" >&2
  exit 2
fi

# --- Build merged prompt ---

MERGED_PROMPT="$(build_merged_prompt)"
trap 'rm -f "${MERGED_PROMPT}"' EXIT

# --- Execute with retries ---

build_cmd_args

mkdir -p "$(dirname "${OUT}")"

attempt=1
while true; do
  set +e
  codex exec "${CMD_ARGS[@]}" <"${MERGED_PROMPT}" 2>&1
  code=$?
  set -e

  if [[ $code -eq 0 ]]; then
    if [[ -s "${OUT}" ]]; then
      exit 0
    elif [[ -f "${OUT}" ]]; then
      echo "Warning: codex exited 0 but output file is empty: ${OUT} — treating as failure, will retry" >&2
    else
      echo "Warning: codex exited 0 but output file not found: ${OUT}" >&2
      exit 1
    fi
  fi

  if [[ $attempt -ge $MAX_RETRIES ]]; then
    echo "Codex failed after ${MAX_RETRIES} attempts (last exit ${code})." >&2
    exit $code
  fi

  sleep_for=$(( SLEEP_SECS * (2 ** (attempt - 1)) ))
  echo "Attempt ${attempt} failed (exit ${code}); retrying in ${sleep_for}s..." >&2
  sleep "${sleep_for}"
  attempt=$(( attempt + 1 ))
done
