#!/usr/bin/env bash
set -euo pipefail

# Minimal Gemini runner for review-swarm when the local gateway only returns
# meaningful content via streaming output.
#
# Contract:
# - Accepts the same core flags as gemini-cli-runner's run_gemini.sh:
#   --model MODEL (optional), --prompt-file FILE (required), --out FILE (required)
# - Writes extracted assistant text to --out.
# - On failure or empty extraction, writes the raw stream output to --out and exits non-zero.

MODEL=""
PROMPT_FILE=""
OUT=""

usage() {
  cat <<'EOF'
run_gemini_stream_extract.sh

Usage:
  run_gemini_stream_extract.sh --prompt-file PROMPT.txt --out OUT.md [--model MODEL]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
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

tmp_stream="$(mktemp)"
cleanup() { rm -f "${tmp_stream}" || true; }
trap cleanup EXIT

set +e
if [[ -n "${MODEL}" ]]; then
  gemini -m "${MODEL}" -o stream-json -p " " <"${PROMPT_FILE}" >"${tmp_stream}" 2>&1
  code=$?
else
  gemini -o stream-json -p " " <"${PROMPT_FILE}" >"${tmp_stream}" 2>&1
  code=$?
fi
set -e

mkdir -p "$(dirname "${OUT}")"

if [[ $code -ne 0 ]]; then
  mv "${tmp_stream}" "${OUT}"
  exit $code
fi

python3 - "${tmp_stream}" "${OUT}" <<'PY'
import json
import sys
from pathlib import Path

stream_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])

raw = stream_path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
lines = raw.split("\n")

assistant_deltas: list[str] = []
assistant_full: str | None = None
result_status: str | None = None

for line in lines:
    s = line.strip()
    if not s.startswith("{"):
        continue
    try:
        obj = json.loads(s)
    except Exception:
        continue
    if obj.get("type") == "message" and obj.get("role") == "assistant":
        content = obj.get("content") or ""
        if obj.get("delta") is True:
            assistant_deltas.append(content)
        else:
            assistant_full = content
    if obj.get("type") == "result":
        result_status = obj.get("status")

text = assistant_full if assistant_full is not None else "".join(assistant_deltas)
text = text.strip()

if result_status == "error" or not text:
    # Keep the raw output for debugging.
    out_path.write_text(raw, encoding="utf-8")
    raise SystemExit(1)

out_path.write_text(text + "\n", encoding="utf-8")
PY
