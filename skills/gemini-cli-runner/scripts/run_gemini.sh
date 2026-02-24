#!/usr/bin/env bash
set -euo pipefail

# Gemini CLI runner: one-shot with file-based prompt input and model fallback.

SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
MODEL=""
OUTPUT_FORMAT="text"
DRY_RUN=0
NO_FALLBACK=0
GEMINI_CLI_HOME_OVERRIDE="${GEMINI_CLI_HOME:-}"

usage() {
  cat <<'EOF'
run_gemini.sh

Usage:
  run_gemini.sh --prompt-file PROMPT.txt --out OUT.txt

Options:
  --model MODEL           Optional (e.g. gemini-3.1-pro-preview). If invalid, script falls back to default model.
  --output-format FORMAT  Default: text (choices depend on gemini CLI; typically text/json/stream-json)
  --system-prompt-file F  Optional. If set, it is prepended to stdin before the prompt file (separated by a blank line).
  --gemini-cli-home DIR   Optional. If set, run Gemini with GEMINI_CLI_HOME=DIR (isolated state dir).
  --prompt-file FILE      Required
  --out PATH              Required
  --no-fallback           If set, do not retry without -m when the model alias is invalid (strict mode).
  --dry-run               Do not call gemini. Print the planned command + prompt file size/hash. Returns 0.
EOF
}

file_size_bytes() {
  # Portable across macOS/Linux; trims whitespace/newlines.
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
  # Prints a shell-escaped command line (no trailing newline).
  while (($#)); do
    printf '%q ' "$1"
    shift
  done
}

print_gemini_cmd() {
  if [[ -n "${GEMINI_CLI_HOME_OVERRIDE}" ]]; then
    print_shell_cmd env "GEMINI_CLI_HOME=${GEMINI_CLI_HOME_OVERRIDE}" gemini "$@"
  else
    print_shell_cmd gemini "$@"
  fi
}

run_gemini_cmd() {
  if [[ -n "${GEMINI_CLI_HOME_OVERRIDE}" ]]; then
    env "GEMINI_CLI_HOME=${GEMINI_CLI_HOME_OVERRIDE}" gemini "$@"
  else
    gemini "$@"
  fi
}

sanitize_gemini_output() {
  local f="$1"
  [[ -f "${f}" ]] || return 0
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Warning: python3 not found; skipping output sanitization." >&2
    return 0
  fi

  python3 - "${f}" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
lines = text.split("\n")

hook_re = re.compile(r"^Hook registry initialized with \d+ hook entries$")
while lines and hook_re.match(lines[0]):
    lines.pop(0)

# Strip leading empty lines for deterministic first-line checks.
while lines and lines[0].strip() == "":
    lines.pop(0)

path.write_text("\n".join(lines), encoding="utf-8")
PY
}

try_generatecontent_fallback() {
  # Fallback path for environments where `gemini` CLI fails (e.g. invalid/placeholder API key),
  # but a local proxy is available via GOOGLE_GEMINI_BASE_URL (typically http://127.0.0.1:5000).
  #
  # This uses the non-streaming Google GenAI `generateContent` endpoint and extracts the first
  # candidate text. Output format is text-only.
  local model="$1"
  local stdin_file="$2"
  local out_path="$3"

  if [[ -z "${model}" ]]; then
    return 1
  fi
  if [[ "${OUTPUT_FORMAT}" != "text" ]]; then
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi

  local base_url="${GOOGLE_GEMINI_BASE_URL:-}"
  local api_key="${GEMINI_API_KEY:-}"

  # If env vars are unset (common), try to read the Gemini CLI dotenv.
  local dotenv_path="${HOME}/.gemini/.env"
  if [[ (-z "${base_url}" || -z "${api_key}") && -f "${dotenv_path}" ]]; then
    if [[ -z "${base_url}" ]]; then
      base_url="$(python3 - "${dotenv_path}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
    if line.startswith("GOOGLE_GEMINI_BASE_URL="):
        print(line.split("=", 1)[1].strip())
        break
PY
)"
    fi
    if [[ -z "${api_key}" ]]; then
      api_key="$(python3 - "${dotenv_path}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
    if line.startswith("GEMINI_API_KEY="):
        print(line.split("=", 1)[1].strip())
        break
PY
)"
    fi
  fi

  # As a last resort, attempt the default local CC switch proxy.
  if [[ -z "${base_url}" ]]; then
    base_url="http://127.0.0.1:5000"
  fi

  local endpoint="${base_url%/}/v1beta/models/${model}:generateContent"
  local tmp_body
  tmp_body="$(mktemp)"
  local tmp_json
  tmp_json="$(mktemp)"
  local tmp_err
  tmp_err="$(mktemp)"

  # Build payload: send the entire prompt as a single user text part.
  python3 - "${stdin_file}" "${tmp_body}" <<'PY'
import json
import sys
from pathlib import Path

stdin_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
text = stdin_path.read_text(encoding="utf-8", errors="replace")

payload = {
  "contents": [{"role": "user", "parts": [{"text": text}]}],
  "generationConfig": {
    "temperature": 0.0,
  },
}
out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
PY

  # If an explicit API key is present and not the PROXY_MANAGED placeholder, forward it.
  # Otherwise omit the header (local proxies may inject keys internally).
  local -a curl_cmd
  curl_cmd=(curl -sS -H 'Content-Type: application/json' -d @"${tmp_body}" "${endpoint}")
  if [[ -n "${api_key}" && "${api_key}" != "PROXY_MANAGED" ]]; then
    curl_cmd=(curl -sS -H 'Content-Type: application/json' -H "x-goog-api-key: ${api_key}" -d @"${tmp_body}" "${endpoint}")
  fi

  set +e
  "${curl_cmd[@]}" >"${tmp_json}" 2>"${tmp_err}"
  local code=$?
  set -e
  if [[ $code -ne 0 ]]; then
    cat "${tmp_err}" >&2
    rm -f "${tmp_body}" "${tmp_json}" "${tmp_err}" || true
    return 1
  fi

  # Extract assistant text (first candidate, concatenated parts).
  set +e
  python3 - "${tmp_json}" "${out_path}" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])

raw = src.read_text(encoding="utf-8", errors="replace")
try:
    obj = json.loads(raw)
except Exception:
    raise SystemExit(1)

if isinstance(obj, dict) and obj.get("error"):
    raise SystemExit(1)

cands = (obj.get("candidates") if isinstance(obj, dict) else None) or []
if not cands:
    raise SystemExit(1)

content = cands[0].get("content") or {}
parts = content.get("parts") or []
texts = []
for p in parts:
    t = p.get("text")
    if isinstance(t, str):
        texts.append(t)
text = "".join(texts).strip()
if not text:
    raise SystemExit(1)

dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(text + "\n", encoding="utf-8")
PY
  code=$?
  set -e

  rm -f "${tmp_body}" "${tmp_json}" "${tmp_err}" || true

  if [[ $code -ne 0 ]]; then
    return 1
  fi

  sanitize_gemini_output "${out_path}" || true
  return 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --output-format) OUTPUT_FORMAT="$2"; shift 2;;
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2;;
    --gemini-cli-home) GEMINI_CLI_HOME_OVERRIDE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
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
if [[ "${DRY_RUN}" -ne 1 ]]; then
  if ! command -v gemini >/dev/null 2>&1; then
    echo "gemini CLI not found in PATH" >&2
    exit 2
  fi
fi

prompt_bytes="$(file_size_bytes "${PROMPT_FILE}")"
prompt_sha256="$(file_sha256 "${PROMPT_FILE}")"

# If a system prompt is provided, we prepend it to stdin before the prompt file.
system_bytes=""
system_sha256=""
stdin_desc="$(printf '%q' "${PROMPT_FILE}")"
if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
  system_bytes="$(file_size_bytes "${SYSTEM_PROMPT_FILE}")"
  system_sha256="$(file_sha256 "${SYSTEM_PROMPT_FILE}")"
  stdin_desc="concat($(printf '%q' "${SYSTEM_PROMPT_FILE}"), blank_line, $(printf '%q' "${PROMPT_FILE}"))"
fi

# Gemini CLI supports -p/--prompt by appending the provided string to stdin.
# To avoid "Argument list too long" with huge prompts, feed the prompt via stdin
# and keep the CLI prompt argument minimal.
#
# IMPORTANT: Some gemini CLI builds treat an *empty* -p argument as "no prompt"
# and may ignore stdin. Use a single space to reliably trigger headless mode
# while keeping semantics neutral.
prompt_suffix=" "

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
  echo "output_format: ${OUTPUT_FORMAT}"
  if [[ -n "${GEMINI_CLI_HOME_OVERRIDE}" ]]; then
    echo "gemini_cli_home: ${GEMINI_CLI_HOME_OVERRIDE}"
  else
    echo "gemini_cli_home: (default)"
  fi
  if [[ -n "${MODEL}" ]]; then
    echo "model: ${MODEL}"
    echo "no_fallback: ${NO_FALLBACK}"
    echo -n "command: "; print_gemini_cmd -m "${MODEL}" -o "${OUTPUT_FORMAT}" -p "${prompt_suffix}"; echo "< ${stdin_desc}"
    if [[ "${NO_FALLBACK}" -ne 1 ]]; then
      echo -n "fallback_command: "; print_gemini_cmd -o "${OUTPUT_FORMAT}" -p "${prompt_suffix}"; echo "< ${stdin_desc}"
    fi
  else
    echo "model: (default)"
    echo -n "command: "; print_gemini_cmd -o "${OUTPUT_FORMAT}" -p "${prompt_suffix}"; echo "< ${stdin_desc}"
  fi
  exit 0
fi

tmp_out=""
stdin_file="${PROMPT_FILE}"
combined_stdin=""
if [[ -n "${GEMINI_CLI_HOME_OVERRIDE}" ]]; then
  mkdir -p "${GEMINI_CLI_HOME_OVERRIDE}"
fi
cleanup() {
  # Do not let cleanup affect the script exit status.
  if [[ -n "${tmp_out}" ]]; then
    rm -f "${tmp_out}" || true
  fi
  if [[ -n "${combined_stdin}" ]]; then
    rm -f "${combined_stdin}" || true
  fi
}
trap cleanup EXIT

if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
  combined_stdin="$(mktemp)"
  cat "${SYSTEM_PROMPT_FILE}" >"${combined_stdin}"
  printf '\n\n' >>"${combined_stdin}"
  cat "${PROMPT_FILE}" >>"${combined_stdin}"
  stdin_file="${combined_stdin}"
fi

tmp_out="$(mktemp)"

# Proxy-first fast path:
# In some environments GEMINI_API_KEY is a placeholder (e.g. PROXY_MANAGED) while
# GOOGLE_GEMINI_BASE_URL points at a local proxy that injects credentials.
# The `gemini` CLI may then fail/hang in streaming mode. Try generateContent first.
dotenv_path="${HOME}/.gemini/.env"
proxy_first=0
if [[ "${GEMINI_API_KEY:-}" == "PROXY_MANAGED" ]]; then
  proxy_first=1
fi
if [[ "${GOOGLE_GEMINI_BASE_URL:-}" == *"127.0.0.1:5000"* || "${GOOGLE_GEMINI_BASE_URL:-}" == *"localhost:5000"* ]]; then
  proxy_first=1
fi
if [[ -f "${dotenv_path}" ]]; then
  if grep -q '^GEMINI_API_KEY=PROXY_MANAGED' "${dotenv_path}" \
    && grep -Eq '^GOOGLE_GEMINI_BASE_URL=.*(127\.0\.0\.1|localhost):5000' "${dotenv_path}"; then
    proxy_first=1
  fi
fi
if [[ "${proxy_first}" -eq 1 ]]; then
  if try_generatecontent_fallback "${MODEL}" "${stdin_file}" "${OUT}"; then
    echo "Note: used generateContent proxy-first via local GOOGLE_GEMINI_BASE_URL." >&2
    exit 0
  fi
fi

set +e
if [[ -n "${MODEL}" ]]; then
  run_gemini_cmd -m "${MODEL}" -o "${OUTPUT_FORMAT}" -p "${prompt_suffix}" <"${stdin_file}" >"${tmp_out}" 2>&1
  code=$?
else
  run_gemini_cmd -o "${OUTPUT_FORMAT}" -p "${prompt_suffix}" <"${stdin_file}" >"${tmp_out}" 2>&1
  code=$?
fi
set -e

if [[ $code -ne 0 && -n "${MODEL}" ]]; then
  # Fallback: omit -m in case the local CLI uses different model aliases.
  if [[ "${NO_FALLBACK}" -ne 1 ]]; then
    set +e
    run_gemini_cmd -o "${OUTPUT_FORMAT}" -p "${prompt_suffix}" <"${stdin_file}" >"${tmp_out}" 2>&1
    code=$?
    set -e
  fi
fi

if [[ $code -ne 0 ]]; then
  # Try a non-streaming proxy fallback via GOOGLE_GEMINI_BASE_URL (if configured).
  if try_generatecontent_fallback "${MODEL}" "${stdin_file}" "${OUT}"; then
    echo "Note: gemini CLI failed; used generateContent fallback via GOOGLE_GEMINI_BASE_URL." >&2
    exit 0
  fi

  cat "${tmp_out}" >&2
  exit $code
fi

if ! sanitize_gemini_output "${tmp_out}"; then
  echo "Warning: output sanitization failed (non-fatal)." >&2
fi

mkdir -p "$(dirname "${OUT}")"
mv "${tmp_out}" "${OUT}"
