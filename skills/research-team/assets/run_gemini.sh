#!/usr/bin/env bash
set -euo pipefail

# Gemini CLI runner: one-shot with file-based prompt input and model fallback.
# Vendored copy for project-local use.

PROMPT_FILE=""
OUT=""
MODEL=""
OUTPUT_FORMAT="text"
INTERNAL_FORMAT="json"

usage() {
  cat <<'EOF'
run_gemini.sh

Usage:
  run_gemini.sh --prompt-file PROMPT.txt --out OUT.txt

Options:
  --model MODEL           Optional (runner-specific alias). If invalid, script falls back to default model.
  --output-format FORMAT  Default: text (choices depend on gemini CLI; typically text/json/stream-json)
  --prompt-file FILE      Required
  --out PATH              Required
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --output-format) OUTPUT_FORMAT="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ -z "${PROMPT_FILE}" || -z "${OUT}" ]]; then
  echo "Missing required args." >&2
  usage
  exit 2
fi
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "Prompt file not found: ${PROMPT_FILE}" >&2
  exit 2
fi
if ! command -v gemini >/dev/null 2>&1; then
  echo "gemini CLI not found in PATH" >&2
  exit 2
fi

extract_json_response() {
  python3 -c "$(cat <<'PY'
from __future__ import annotations

import json
import sys

raw = sys.stdin.read()
raw = raw.strip()
if not raw:
    print("ERROR: gemini returned empty stdout (json).", file=sys.stderr)
    raise SystemExit(2)

try:
    obj = json.loads(raw)
except Exception:
    # Fallback: try to locate the first JSON object in the stream.
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        obj = json.loads(raw[start : end + 1])
    else:
        print("ERROR: gemini returned non-JSON stdout in json mode.", file=sys.stderr)
        raise SystemExit(2)

resp = obj.get("response", "")
if not isinstance(resp, str):
    print("ERROR: gemini json missing string field: response", file=sys.stderr)
    raise SystemExit(2)
resp = resp.strip()
if not resp:
    print("ERROR: gemini json response is empty (possible auth/config/model issue).", file=sys.stderr)
    raise SystemExit(2)
sys.stdout.write(resp + "\n")
PY
)"
}

extract_json_object() {
  python3 -c "$(cat <<'PY'
from __future__ import annotations

import json
import sys

raw = sys.stdin.read().strip()
if not raw:
    print("ERROR: gemini returned empty output in json mode.", file=sys.stderr)
    raise SystemExit(2)

try:
    obj = json.loads(raw)
except Exception:
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        obj = json.loads(raw[start : end + 1])
    else:
        print("ERROR: gemini returned non-JSON output in json mode.", file=sys.stderr)
        raise SystemExit(2)

sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
PY
)"
}

tmp_stdout="$(mktemp)"
tmp_stderr="$(mktemp)"
tmp_response="$(mktemp)"
trap 'rm -f "${tmp_stdout}" "${tmp_stderr}" "${tmp_response}"' EXIT

run_once() {
  local model="${1:-}"
  local fmt="${2:-json}"
  local -a cmd=( gemini --output-format "${fmt}" )
  if [[ -n "${model}" ]]; then
    cmd+=( --model "${model}" )
  fi
  # Prefer stdin over positional prompt to avoid command-length limits.
  cat "${PROMPT_FILE}" | "${cmd[@]}" >"${tmp_stdout}" 2>"${tmp_stderr}"
}

if [[ "${OUTPUT_FORMAT}" == "stream-json" ]]; then
  INTERNAL_FORMAT="stream-json"
else
  INTERNAL_FORMAT="json"
fi

set +e
run_once "${MODEL}" "${INTERNAL_FORMAT}"
code=$?
set -e

if [[ $code -ne 0 && -n "${MODEL}" ]]; then
  # Fallback: omit -m in case the local CLI uses different model aliases.
  set +e
  run_once "" "${INTERNAL_FORMAT}"
  code=$?
  set -e
fi

if [[ $code -ne 0 ]]; then
  cat "${tmp_stderr}" >&2
  if [[ -s "${tmp_stdout}" ]]; then
    echo "" >&2
    cat "${tmp_stdout}" >&2
  fi
  exit $code
fi

mkdir -p "$(dirname "${OUT}")"
if [[ "${OUTPUT_FORMAT}" == "json" || "${OUTPUT_FORMAT}" == "stream-json" ]]; then
  # Some gemini CLI builds may emit the JSON payload on stderr even with exit=0.
  # In that case, extract the JSON object from stderr and write JSON-only output.
  if [[ -s "${tmp_stdout}" ]]; then
    mv "${tmp_stdout}" "${OUT}"
  else
    extract_json_object <"${tmp_stderr}" >"${tmp_response}" 2>>"${tmp_stderr}" || {
      cat "${tmp_stderr}" >&2
      exit 2
    }
    mv "${tmp_response}" "${OUT}"
  fi
else
  # Default: extract the main response from JSON output and write plain text.
  json_in="${tmp_stdout}"
  if [[ ! -s "${tmp_stdout}" && -s "${tmp_stderr}" ]]; then
    # Recovery path: stdout empty but stderr might contain JSON (plus harmless preamble).
    json_in="${tmp_stderr}"
  fi
  extract_json_response <"${json_in}" >"${tmp_response}" 2>>"${tmp_stderr}" || {
    cat "${tmp_stderr}" >&2
    if [[ -s "${tmp_stdout}" ]]; then
      echo "" >&2
      cat "${tmp_stdout}" >&2
    fi
    exit 2
  }
  mv "${tmp_response}" "${OUT}"
fi
