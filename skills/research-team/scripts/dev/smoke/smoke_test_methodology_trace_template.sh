#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

echo "[test1] scaffold copies updated methodology trace template"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeMethTrace" --profile "mixed" --full >/dev/null 2>&1

trace_tmpl="${tmp_root}/knowledge_base/methodology_traces/_template.md"
if [[ ! -f "${trace_tmpl}" ]]; then
  echo "[fail] missing scaffolded methodology trace template: ${trace_tmpl}" >&2
  exit 1
fi

query_log="${tmp_root}/knowledge_base/methodology_traces/literature_queries.md"
if [[ ! -f "${query_log}" ]]; then
  echo "[fail] missing scaffolded query log file: ${query_log}" >&2
  exit 1
fi
if ! grep -nF "append-only log" "${query_log}" >/dev/null 2>&1; then
  echo "[fail] expected query log header/policy in ${query_log}; got:" >&2
  sed -n '1,120p' "${query_log}" >&2 || true
  exit 1
fi

if ! grep -nF "## Candidate methods (compare before implementing)" "${trace_tmpl}" >/dev/null 2>&1; then
  echo "[fail] expected Candidate methods section in methodology trace template; got:" >&2
  sed -n '1,220p' "${trace_tmpl}" >&2 || true
  exit 1
fi

if ! grep -nF "Append-only query log" "${trace_tmpl}" >/dev/null 2>&1; then
  echo "[fail] expected query log section in methodology trace template; got:" >&2
  sed -n '1,220p' "${trace_tmpl}" >&2 || true
  exit 1
fi

if ! grep -nF "[literature_queries.md](literature_queries.md)" "${trace_tmpl}" >/dev/null 2>&1; then
  echo "[fail] expected clickable literature_queries.md link (relative) in methodology trace template; got:" >&2
  sed -n '1,220p' "${trace_tmpl}" >&2 || true
  exit 1
fi

if grep -nE '`\[[^]]+\]\([^)]+\)`' "${trace_tmpl}" >/dev/null 2>&1; then
  echo "[fail] found a Markdown link wrapped in backticks (not clickable); got:" >&2
  grep -nE '`\[[^]]+\]\([^)]+\)`' "${trace_tmpl}" >&2 || true
  exit 1
fi

echo "[ok] methodology trace template smoke tests passed"
