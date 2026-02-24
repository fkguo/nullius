#!/usr/bin/env bash
set -euo pipefail

# Smoke test: literature_fetch.py trace-add creates/appends a trace row (no network).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
FETCH="${SKILL_ROOT}/scripts/bin/literature_fetch.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

trace_path="${tmp_root}/knowledge_base/methodology_traces/literature_queries.md"

python3 "${FETCH}" trace-add \
  --source "Manual" \
  --query "demo query" \
  --filters "demo filters" \
  --shortlist "[A](https://doi.org/10.1103/PhysRevD.7.2333)" \
  --decision "demo decision" \
  --kb-notes "[kb](knowledge_base/literature/demo.md)" \
  --trace-path "${trace_path}" >/dev/null

if [[ ! -f "${trace_path}" ]]; then
  echo "[smoke][fail] expected trace file to exist: ${trace_path}" >&2
  exit 1
fi
if ! grep -nF "| Timestamp (UTC) |" "${trace_path}" >/dev/null 2>&1; then
  echo "[smoke][fail] expected trace table header in: ${trace_path}" >&2
  sed -n '1,80p' "${trace_path}" >&2
  exit 1
fi
if ! grep -nF "| Manual | demo query |" "${trace_path}" >/dev/null 2>&1; then
  echo "[smoke][fail] expected appended row in: ${trace_path}" >&2
  sed -n '1,120p' "${trace_path}" >&2
  exit 1
fi

echo "[smoke][ok] trace-add appends a trace row"

exit 0

