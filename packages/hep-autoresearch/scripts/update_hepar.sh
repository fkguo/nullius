#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "[update_hepar] error: python not found: ${PYTHON_BIN}" >&2
  exit 1
fi

echo "[update_hepar] repo: ${REPO_ROOT}"
echo "[update_hepar] python: ${PYTHON_BIN}"
echo "[update_hepar] installing editable package (user site)..."
"${PYTHON_BIN}" -m pip install --user -e "${REPO_ROOT}" "$@"

USER_BASE="$("${PYTHON_BIN}" -m site --user-base)"
BIN_DIR="${USER_BASE}/bin"
HEPAR_BIN="${BIN_DIR}/hepar"

if [[ ! -x "${HEPAR_BIN}" ]]; then
  echo "[update_hepar] warning: expected entrypoint not found at ${HEPAR_BIN}" >&2
  exit 0
fi

echo "[update_hepar] hepar entrypoint: ${HEPAR_BIN}"
"${HEPAR_BIN}" --help >/dev/null

if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  echo "[update_hepar] note: ${BIN_DIR} is not in PATH for current shell." >&2
  echo "[update_hepar] add this to ~/.zshrc: export PATH=\"${BIN_DIR}:\$PATH\"" >&2
fi

echo "[update_hepar] done"

