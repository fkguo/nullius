#!/usr/bin/env bash
set -euo pipefail

# Gemini CLI runner: one-shot with file-based prompt input and model fallback.
# Default to the CLI's standard headless mode. `--approval-mode plan` remains
# available as an opt-in, but official Gemini CLI docs describe plan mode as
# not yet fully functional, so it should not be the default invocation path.

SYSTEM_PROMPT_FILE=""
PROMPT_FILE=""
OUT=""
MODEL=""
OUTPUT_FORMAT="text"
TOOL_MODE="none"
EXTENSIONS_MODE=""
APPROVAL_MODE="default"
APPROVAL_MODE_EXPLICIT=0
SANDBOX=0
DRY_RUN=0
NO_FALLBACK=0
NO_PROXY_FIRST=0
GEMINI_CLI_HOME_OVERRIDE="${GEMINI_CLI_HOME:-}"

usage() {
  cat <<'EOF'
run_gemini.sh

Usage:
  run_gemini.sh --prompt-file PROMPT.txt --out OUT.txt

Options:
  --model MODEL           Optional (e.g. gemini-3.1-pro-preview). If invalid, script falls back to default model.
  --output-format FORMAT  Default: text (choices depend on gemini CLI; typically text/json/stream-json)
  --tool-mode MODE        Default: none. Choices: none, review. "review" maps to approval-mode=plan + sandbox + --extensions none.
  --approval-mode MODE    Default: default. Choices: default, auto_edit, yolo, plan.
  --sandbox               Run Gemini CLI in sandbox mode.
  --system-prompt-file F  Optional. If set, it is prepended to stdin before the prompt file (separated by a blank line).
  --gemini-cli-home DIR   Optional. If set, run Gemini with GEMINI_CLI_HOME=DIR (isolated state dir).
  --prompt-file FILE      Required
  --out PATH              Required
  --no-fallback           If set, do not retry without -m when the model alias is invalid (strict mode).
  --no-proxy-first        Skip the generateContent fast-path and force the local Gemini CLI path.
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

load_proxy_env_from_interactive_shell() {
  if [[ -n "${http_proxy:-}" || -n "${https_proxy:-}" || -n "${all_proxy:-}" || -n "${HTTP_PROXY:-}" || -n "${HTTPS_PROXY:-}" || -n "${ALL_PROXY:-}" ]]; then
    return 0
  fi
  if ! command -v zsh >/dev/null 2>&1; then
    return 0
  fi

  local proxy_lines=""
  proxy_lines="$(
    zsh -lic '
      if command -v proxy_on >/dev/null 2>&1; then
        proxy_on >/dev/null 2>&1 || exit 0
        env | grep -E "^(http_proxy|https_proxy|all_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)=" || true
      fi
    ' 2>/dev/null || true
  )"

  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    export "${line}"
  done <<EOF
${proxy_lines}
EOF
}

print_gemini_cmd_with_sandbox() {
  if [[ "${SANDBOX}" -eq 1 ]]; then
    print_gemini_cmd --sandbox "$@"
  else
    print_gemini_cmd "$@"
  fi
}

run_gemini_cmd_with_sandbox() {
  if [[ "${SANDBOX}" -eq 1 ]]; then
    run_gemini_cmd --sandbox "$@"
  else
    run_gemini_cmd "$@"
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
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n").lstrip()

hook_re = re.compile(r"^Hook registry initialized with \d+ hook entries\s*")
inline_prefix_res = [
    hook_re,
    re.compile(r"^MCP issues detected\. Run /mcp list for status\.\s*"),
]
startup_line_res = [
    re.compile(r"^Hook registry initialized with \d+ hook entries$"),
    re.compile(r"^MCP issues detected\. Run /mcp list for status\.$"),
    re.compile(r"^Registering notification handlers for server '.*'\. Capabilities: .*"),
    re.compile(r"^(completions|resources|tools): .*"),
    re.compile(r"^\}$"),
    re.compile(r"^Server '.*' has tools but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.$"),
    re.compile(r"^Server '.*' has resources but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.$"),
    re.compile(r"^Server '.*' has prompts but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.$"),
    re.compile(r"^Server '.*' supports tool updates\. Listening for changes\.\.\.$"),
    re.compile(r"^Server '.*' supports resource updates\. Listening for changes\.\.\.$"),
    re.compile(r"^Scheduling MCP context refresh\.\.\.$"),
    re.compile(r"^Executing MCP context refresh\.\.\.$"),
    re.compile(r"^MCP context refresh complete\.$"),
]

while text:
    changed = False
    for pattern in inline_prefix_res:
        match = pattern.match(text)
        if match:
            text = text[match.end():].lstrip()
            changed = True
            break
    if changed:
        continue

    lines = text.splitlines()
    if not lines:
        break
    first = lines[0].strip()
    if not first:
        text = "\n".join(lines[1:]).lstrip()
        continue
    if any(pattern.match(first) for pattern in startup_line_res):
        text = "\n".join(lines[1:]).lstrip()
        continue
    break

if text and not text.startswith("{") and not text.startswith("```"):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip().startswith("VERDICT: "):
            text = "\n".join(lines[i:]).lstrip()
            break
    else:
        json_start = text.find("{")
        if json_start > 0:
            candidate = text[json_start:]
            try:
                json.loads(candidate)
            except Exception:
                pass
            else:
                text = candidate

path.write_text(text.rstrip() + "\n", encoding="utf-8")
PY
}

require_meaningful_output() {
  local f="$1"
  [[ -f "${f}" ]] || return 1
  if ! command -v python3 >/dev/null 2>&1; then
    [[ -s "${f}" ]]
    return
  fi

  python3 - "${f}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace").strip()
raise SystemExit(0 if text else 1)
PY
}

load_auth_env_from_default_home() {
  if [[ -z "${GEMINI_CLI_HOME_OVERRIDE}" ]]; then
    return 0
  fi
  if [[ -n "${GEMINI_API_KEY:-}" || -n "${GOOGLE_API_KEY:-}" || -n "${GOOGLE_GEMINI_BASE_URL:-}" || -n "${GOOGLE_GENAI_USE_VERTEXAI:-}" || -n "${GOOGLE_GENAI_USE_GCA:-}" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  local dotenv_path="${HOME}/.gemini/.env"
  [[ -f "${dotenv_path}" ]] || return 0

  local auth_lines
  auth_lines="$(
    python3 - "${dotenv_path}" <<'PY'
import sys
from pathlib import Path

allowed = {
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_GEMINI_BASE_URL",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
}

path = Path(sys.argv[1])
for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if key not in allowed:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]
    print(f"{key}={value}")
PY
  )"

  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    export "${line}"
  done <<EOF
${auth_lines}
EOF
}

bridge_oauth_personal_from_default_home() {
  if [[ -z "${GEMINI_CLI_HOME_OVERRIDE}" ]]; then
    return 0
  fi
  if [[ -n "${GEMINI_API_KEY:-}" || -n "${GOOGLE_API_KEY:-}" || -n "${GOOGLE_GEMINI_BASE_URL:-}" || -n "${GOOGLE_GENAI_USE_VERTEXAI:-}" || -n "${GOOGLE_GENAI_USE_GCA:-}" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  local default_gemini_home="${HOME}/.gemini"
  local default_settings="${default_gemini_home}/settings.json"
  [[ -f "${default_settings}" ]] || return 0

  python3 - "${default_gemini_home}" "${GEMINI_CLI_HOME_OVERRIDE}" <<'PY'
import json
import shutil
import sys
from pathlib import Path

source_home = Path(sys.argv[1])
target_home = Path(sys.argv[2])
source_settings = source_home / "settings.json"
target_settings = target_home / ".gemini" / "settings.json"

try:
    source_payload = json.loads(source_settings.read_text(encoding="utf-8", errors="replace"))
except Exception:
    raise SystemExit(0)

security = source_payload.get("security")
if not isinstance(security, dict):
    raise SystemExit(0)
auth = security.get("auth")
if not isinstance(auth, dict):
    raise SystemExit(0)
selected_type = auth.get("selectedType")
if not isinstance(selected_type, str) or not selected_type.startswith("oauth"):
    raise SystemExit(0)

target_payload = {}
if target_settings.exists():
    try:
        existing = json.loads(target_settings.read_text(encoding="utf-8", errors="replace"))
        if isinstance(existing, dict):
            target_payload = existing
    except Exception:
        target_payload = {}

target_security = target_payload.get("security")
if not isinstance(target_security, dict):
    target_security = {}
target_security["auth"] = auth
target_payload["security"] = target_security

target_root = target_settings.parent
target_root.mkdir(parents=True, exist_ok=True)
target_settings.write_text(json.dumps(target_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

for name in ("oauth_creds.json", "google_accounts.json"):
    src = source_home / name
    if src.is_file():
        shutil.copy2(src, target_root / name)
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
    --tool-mode) TOOL_MODE="$2"; shift 2;;
    --approval-mode) APPROVAL_MODE="$2"; APPROVAL_MODE_EXPLICIT=1; shift 2;;
    --sandbox) SANDBOX=1; shift 1;;
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2;;
    --gemini-cli-home) GEMINI_CLI_HOME_OVERRIDE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --no-fallback) NO_FALLBACK=1; shift 1;;
    --no-proxy-first) NO_PROXY_FIRST=1; shift 1;;
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

case "${TOOL_MODE}" in
  none)
    ;;
  review)
    if [[ "${APPROVAL_MODE_EXPLICIT}" -eq 1 && "${APPROVAL_MODE}" != "plan" ]]; then
      echo "--tool-mode review requires --approval-mode plan (or no explicit --approval-mode)." >&2
      exit 2
    fi
    APPROVAL_MODE="plan"
    EXTENSIONS_MODE="none"
    NO_PROXY_FIRST=1
    SANDBOX=1
    ;;
  *)
    echo "Invalid --tool-mode: ${TOOL_MODE}. Expected one of: none, review" >&2
    exit 2
    ;;
esac

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
base_args=(--approval-mode "${APPROVAL_MODE}" -o "${OUTPUT_FORMAT}")
if [[ -n "${EXTENSIONS_MODE}" ]]; then
  base_args+=(--extensions "${EXTENSIONS_MODE}")
fi
base_args+=(-p "${prompt_suffix}")

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
  echo "tool_mode: ${TOOL_MODE}"
  echo "output_format: ${OUTPUT_FORMAT}"
  echo "approval_mode: ${APPROVAL_MODE}"
  if [[ -n "${EXTENSIONS_MODE}" ]]; then
    echo "extensions: ${EXTENSIONS_MODE}"
  else
    echo "extensions: (default)"
  fi
  echo "sandbox: ${SANDBOX}"
  echo "no_proxy_first: ${NO_PROXY_FIRST}"
  if [[ -n "${GEMINI_CLI_HOME_OVERRIDE}" ]]; then
    echo "gemini_cli_home: ${GEMINI_CLI_HOME_OVERRIDE}"
  else
    echo "gemini_cli_home: (default)"
  fi
  if [[ -n "${MODEL}" ]]; then
    echo "model: ${MODEL}"
    echo "no_fallback: ${NO_FALLBACK}"
    echo -n "command: "; print_gemini_cmd_with_sandbox -m "${MODEL}" "${base_args[@]}"; echo "< ${stdin_desc}"
    if [[ "${NO_FALLBACK}" -ne 1 ]]; then
      echo -n "fallback_command: "; print_gemini_cmd_with_sandbox "${base_args[@]}"; echo "< ${stdin_desc}"
    fi
  else
    echo "model: (default)"
    echo -n "command: "; print_gemini_cmd_with_sandbox "${base_args[@]}"; echo "< ${stdin_desc}"
  fi
  exit 0
fi

tmp_out=""
stdin_file="${PROMPT_FILE}"
combined_stdin=""
tmp_raw_out=""
tmp_err=""
if [[ -n "${GEMINI_CLI_HOME_OVERRIDE}" ]]; then
  mkdir -p "${GEMINI_CLI_HOME_OVERRIDE}"
fi
load_proxy_env_from_interactive_shell
load_auth_env_from_default_home
bridge_oauth_personal_from_default_home
cleanup() {
  # Do not let cleanup affect the script exit status.
  if [[ -n "${tmp_out}" ]]; then
    rm -f "${tmp_out}" || true
  fi
  if [[ -n "${tmp_raw_out}" ]]; then
    rm -f "${tmp_raw_out}" || true
  fi
  if [[ -n "${tmp_err}" ]]; then
    rm -f "${tmp_err}" || true
  fi
  if [[ -n "${combined_stdin}" ]]; then
    rm -f "${combined_stdin}" || true
  fi
}
trap cleanup EXIT

if [[ -n "${SYSTEM_PROMPT_FILE}" ]]; then
  combined_stdin="$(mktemp)"
  system_text="$(cat "${SYSTEM_PROMPT_FILE}")"
  printf '%s\n\n' "${system_text}" >"${combined_stdin}"
  cat "${PROMPT_FILE}" >>"${combined_stdin}"
  stdin_file="${combined_stdin}"
fi

tmp_out="$(mktemp)"
tmp_raw_out="$(mktemp)"
tmp_err="$(mktemp)"

# Proxy-first fast path:
# In some environments GEMINI_API_KEY is a placeholder (e.g. PROXY_MANAGED) while
# GOOGLE_GEMINI_BASE_URL points at a local proxy that injects credentials.
# The `gemini` CLI may then fail/hang in streaming mode. Try generateContent first.
# Skipped when --no-proxy-first is set (e.g. for agentic reviews needing file access).
dotenv_path="${HOME}/.gemini/.env"
proxy_first=0
if [[ "${NO_PROXY_FIRST}" -eq 0 ]]; then
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
fi
if [[ "${proxy_first}" -eq 1 ]]; then
  if try_generatecontent_fallback "${MODEL}" "${stdin_file}" "${OUT}"; then
    echo "Note: used generateContent proxy-first via local GOOGLE_GEMINI_BASE_URL." >&2
    exit 0
  fi
fi

set +e
if [[ -n "${MODEL}" ]]; then
  run_gemini_cmd_with_sandbox -m "${MODEL}" "${base_args[@]}" <"${stdin_file}" >"${tmp_out}" 2>"${tmp_err}"
  code=$?
else
  run_gemini_cmd_with_sandbox "${base_args[@]}" <"${stdin_file}" >"${tmp_out}" 2>"${tmp_err}"
  code=$?
fi
set -e

if [[ $code -ne 0 && -n "${MODEL}" ]]; then
  # Fallback: omit -m in case the local CLI uses different model aliases.
  if [[ "${NO_FALLBACK}" -ne 1 ]]; then
    set +e
    run_gemini_cmd_with_sandbox "${base_args[@]}" <"${stdin_file}" >"${tmp_out}" 2>"${tmp_err}"
    code=$?
    set -e
  fi
fi

if [[ $code -ne 0 ]]; then
  # Try a non-streaming proxy fallback via GOOGLE_GEMINI_BASE_URL (if configured).
  # Skip this fallback when --no-proxy-first is set — agentic mode is required.
  if [[ "${NO_PROXY_FIRST}" -eq 0 ]] && try_generatecontent_fallback "${MODEL}" "${stdin_file}" "${OUT}"; then
    echo "Note: gemini CLI failed; used generateContent fallback via GOOGLE_GEMINI_BASE_URL." >&2
    exit 0
  fi

  if [[ -s "${tmp_err}" ]]; then
    cat "${tmp_err}" >&2
  fi
  if [[ -s "${tmp_out}" ]]; then
    echo "--- raw Gemini stdout preview ---" >&2
    sed -n '1,120p' "${tmp_out}" >&2 || true
    echo "--- end raw Gemini stdout preview ---" >&2
  fi
  exit $code
fi

cp "${tmp_out}" "${tmp_raw_out}"

if ! sanitize_gemini_output "${tmp_out}"; then
  echo "Warning: output sanitization failed (non-fatal)." >&2
fi

if ! require_meaningful_output "${tmp_out}"; then
  echo "Gemini CLI returned no meaningful output after sanitization." >&2
  if [[ -s "${tmp_err}" ]]; then
    echo "--- raw Gemini stderr preview ---" >&2
    sed -n '1,120p' "${tmp_err}" >&2 || true
    echo "--- end raw Gemini stderr preview ---" >&2
  fi
  if [[ -s "${tmp_raw_out}" ]]; then
    echo "--- raw Gemini stdout preview ---" >&2
    sed -n '1,120p' "${tmp_raw_out}" >&2 || true
    echo "--- end raw Gemini stdout preview ---" >&2
  fi
  exit 1
fi

mkdir -p "$(dirname "${OUT}")"
mv "${tmp_out}" "${OUT}"
