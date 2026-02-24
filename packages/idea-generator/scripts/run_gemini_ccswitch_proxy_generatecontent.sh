#!/usr/bin/env bash
set -euo pipefail

# Run Gemini via a CC Switch proxy (default: 127.0.0.1:5000) using the
# Google GenAI `generateContent` endpoint (non-streaming).
#
# This is a minimal drop-in replacement for gemini-cli-runner's run_gemini.sh
# for use in review-swarm, when the `gemini` CLI has model-alias or streaming issues.
#
# Contract:
# - Accepts: --model MODEL (optional), --prompt-file FILE (required), --out FILE (required)
# - Writes extracted assistant text to --out.
# - On failure, writes the raw JSON response (or curl error output) to --out and exits non-zero.

MODEL="gemini-3-pro-preview"
PROMPT_FILE=""
OUT=""
BASE_URL="${GOOGLE_GEMINI_BASE_URL:-http://127.0.0.1:5000}"
API_KEY="${GEMINI_API_KEY:-}"

usage() {
  cat <<'EOF'
run_gemini_ccswitch_proxy_generatecontent.sh

Usage:
  run_gemini_ccswitch_proxy_generatecontent.sh --prompt-file PROMPT.txt --out OUT.md [--model MODEL]
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

if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found in PATH" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found in PATH" >&2
  exit 2
fi

mkdir -p "$(dirname "${OUT}")"

tmp_body="$(mktemp)"
tmp_json="$(mktemp)"
cleanup() {
  rm -f "${tmp_body}" "${tmp_json}" || true
}
trap cleanup EXIT

python3 - "${PROMPT_FILE}" "${tmp_body}" <<'PY'
import json
import sys
from pathlib import Path

prompt_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])

text = prompt_path.read_text(encoding="utf-8", errors="replace")

payload = {
  "contents": [{"role": "user", "parts": [{"text": text}]}],
  "generationConfig": {
    "temperature": 0.0,
  },
}
out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
PY

set +e
curl_args=(
  -sS
  -H 'Content-Type: application/json'
  -d @"${tmp_body}"
)
if [[ -n "${API_KEY}" && "${API_KEY}" != "PROXY_MANAGED" ]]; then
  curl_args+=(-H "x-goog-api-key: ${API_KEY}")
fi
curl "${curl_args[@]}" \
  "${BASE_URL%/}/v1beta/models/${MODEL}:generateContent" \
  >"${tmp_json}" 2>&1
code=$?
set -e

if [[ $code -ne 0 ]]; then
  mv "${tmp_json}" "${OUT}"
  exit $code
fi

python3 - "${tmp_json}" "${OUT}" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])

raw = src.read_text(encoding="utf-8", errors="replace")
try:
    obj = json.loads(raw)
except Exception:
    dst.write_text(raw, encoding="utf-8")
    raise SystemExit(1)

if isinstance(obj, dict) and obj.get("error"):
    dst.write_text(raw, encoding="utf-8")
    raise SystemExit(1)

cands = (obj.get("candidates") if isinstance(obj, dict) else None) or []
if not cands:
    dst.write_text(raw, encoding="utf-8")
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
    dst.write_text(raw, encoding="utf-8")
    raise SystemExit(1)

dst.write_text(text + "\n", encoding="utf-8")
PY
