#!/usr/bin/env bash
set -euo pipefail

# run_openai_compat.sh — Generic OpenAI-compatible runner.
#
# Calls /v1/chat/completions on any OpenAI-compatible endpoint
# (DeepSeek, Qwen, vLLM, LM Studio, Ollama, etc.).
#
# API key is read from the env var named by --api-key-env.
# The key value is never passed as a CLI argument.
#
# Usage:
#   run_openai_compat.sh \
#     --system-prompt-file SYS.txt \
#     --prompt-file PROMPT.txt \
#     --out OUT.txt \
#     --api-base-url https://api.deepseek.com \
#     --api-key-env DEEPSEEK_API_KEY \
#     [--model deepseek-chat] \
#     [--max-tokens 16384] \
#     [--temperature 0.7]

MODEL=""
SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
API_BASE_URL=""
API_KEY_ENV=""
MAX_TOKENS=16384
TEMPERATURE=0.7
MAX_RETRIES=4
SLEEP_SECS=10

usage() {
  cat <<'EOF'
run_openai_compat.sh

Generic OpenAI-compatible runner for DeepSeek, Qwen, vLLM, LM Studio, etc.

Usage:
  run_openai_compat.sh \
    --system-prompt-file SYS.txt --prompt-file PROMPT.txt --out OUT.txt \
    --api-base-url URL --api-key-env ENV_VAR_NAME

Options:
  --system-prompt-file F   Required
  --prompt-file F          Required
  --out PATH               Required
  --api-base-url URL       Required. Base URL of the OpenAI-compatible endpoint.
                           E.g. https://api.deepseek.com  or  http://localhost:11434/v1
  --api-key-env VAR        Required. Name of the env var holding the API key.
                           The key value is NEVER passed as a CLI argument.
  --model MODEL            Optional. Model name (default: provider default)
  --max-tokens N           Default: 16384
  --temperature F          Default: 0.7
  --max-retries N          Default: 4
  --sleep-secs N           Default: 10 (base; exponential backoff)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --api-base-url) API_BASE_URL="$2"; shift 2;;
    --api-key-env) API_KEY_ENV="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --max-tokens) MAX_TOKENS="$2"; shift 2;;
    --temperature) TEMPERATURE="$2"; shift 2;;
    --max-retries) MAX_RETRIES="$2"; shift 2;;
    --sleep-secs) SLEEP_SECS="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    # Accept unused runner-compat args silently (tools, output-format, api-provider).
    --tools|--output-format|--api-provider) shift 2;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

# --- Validate required args -----------------------------------------------

if [[ -z "${SYSTEM_PROMPT_FILE}" || -z "${PROMPT_FILE}" || -z "${OUT}" ]]; then
  echo "ERROR: --system-prompt-file, --prompt-file, --out are required." >&2
  usage; exit 2
fi
if [[ -z "${API_BASE_URL}" ]]; then
  echo "ERROR: --api-base-url is required for run_openai_compat.sh." >&2
  exit 2
fi
if [[ -z "${API_KEY_ENV}" ]]; then
  echo "ERROR: --api-key-env is required. Pass the env var NAME (not the key value)." >&2
  exit 2
fi
if [[ ! -f "${SYSTEM_PROMPT_FILE}" ]]; then
  echo "ERROR: system prompt file not found: ${SYSTEM_PROMPT_FILE}" >&2; exit 2
fi
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "ERROR: prompt file not found: ${PROMPT_FILE}" >&2; exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required but not found in PATH." >&2; exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required but not found in PATH." >&2; exit 2
fi

# Resolve API key from named env var — never from a CLI argument.
_api_key="${!API_KEY_ENV:-}"
if [[ -z "${_api_key}" ]]; then
  echo "ERROR: env var '${API_KEY_ENV}' is empty or unset." >&2
  exit 2
fi

# Normalise base URL (strip trailing slash).
API_BASE_URL="${API_BASE_URL%/}"
ENDPOINT="${API_BASE_URL}/v1/chat/completions"

SYSTEM_PROMPT="$(cat "${SYSTEM_PROMPT_FILE}")"
USER_PROMPT="$(cat "${PROMPT_FILE}")"

# --- Build request JSON via python3 (safe quoting) ------------------------

build_request() {
  python3 - "${MODEL}" "${MAX_TOKENS}" "${TEMPERATURE}" <<'PY'
import json, sys

model   = sys.argv[1]
max_tok = int(sys.argv[2])
temp    = float(sys.argv[3])

system_prompt = open("/dev/stdin").read()   # not used here; see stdin piping below

# Read system_prompt and user_prompt from environment (set by parent shell).
import os
system_prompt = os.environ.get("_SYSTEM_PROMPT", "")
user_prompt   = os.environ.get("_USER_PROMPT", "")

messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user",   "content": user_prompt},
]
payload = {"messages": messages, "max_tokens": max_tok, "temperature": temp}
if model:
    payload["model"] = model
print(json.dumps(payload, ensure_ascii=False))
PY
}

# Pass prompt content via env vars to avoid command-length limits.
tmp_out="$(mktemp)"
tmp_body="$(mktemp)"
tmp_auth="$(mktemp)"
chmod 0600 "${tmp_auth}"
# Write Authorization header to a temp file — key value never appears in process args.
printf 'Authorization: Bearer %s\n' "${_api_key}" > "${tmp_auth}"
trap 'rm -f "${tmp_out}" "${tmp_body}" "${tmp_auth}"' EXIT

_SYSTEM_PROMPT="${SYSTEM_PROMPT}" _USER_PROMPT="${USER_PROMPT}" \
  build_request > "${tmp_body}"

# --- Retry loop -----------------------------------------------------------

extract_content() {
  python3 -c "
import json, sys
raw = sys.stdin.read().strip()
try:
    obj = json.loads(raw)
except Exception:
    print('ERROR: non-JSON response from endpoint.', file=sys.stderr)
    raise SystemExit(2)
choices = obj.get('choices', [])
if not choices:
    err = obj.get('error', {})
    msg = err.get('message', '') if isinstance(err, dict) else str(err)
    print(f'ERROR: no choices in response. error={msg!r}', file=sys.stderr)
    raise SystemExit(2)
content = choices[0].get('message', {}).get('content', '')
if not content:
    print('ERROR: empty content in response.', file=sys.stderr)
    raise SystemExit(2)
sys.stdout.write(content + '\n')
"
}

attempt=1
while true; do
  set +e
  curl -s -S --fail-with-body \
    --max-time 300 \
    -H "@${tmp_auth}" \
    -H "Content-Type: application/json" \
    -d @"${tmp_body}" \
    "${ENDPOINT}" > "${tmp_out}" 2>&1
  code=$?
  set -e

  if [[ $code -eq 0 ]]; then
    extracted=""
    set +e
    extracted="$(extract_content < "${tmp_out}")"
    ext_code=$?
    set -e
    if [[ $ext_code -eq 0 ]]; then
      mkdir -p "$(dirname "${OUT}")"
      printf '%s\n' "${extracted}" > "${OUT}"
      exit 0
    fi
    echo "[run_openai_compat] attempt ${attempt}: content extraction failed (curl ok but bad JSON/empty content)." >&2
    cat "${tmp_out}" >&2
    code=2
  else
    echo "[run_openai_compat] attempt ${attempt}: curl failed (exit ${code})." >&2
    cat "${tmp_out}" >&2
  fi

  if [[ $attempt -ge $MAX_RETRIES ]]; then
    echo "run_openai_compat: failed after ${MAX_RETRIES} attempts (last exit ${code})." >&2
    exit $code
  fi

  sleep_for=$(( SLEEP_SECS * (2 ** (attempt - 1)) ))
  echo "[run_openai_compat] retrying in ${sleep_for}s (attempt $((attempt + 1))/${MAX_RETRIES})..." >&2
  sleep "${sleep_for}"
  attempt=$(( attempt + 1 ))
done
