#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the optional literature_trace_gate:
# scaffold -> enable gate -> gate fails (template empty) -> append trace row (no network) -> gate passes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_literature_trace.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "ERROR: gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeLitTraceGate" --profile "mixed" >/dev/null 2>&1

# Enable the gate.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["literature_trace_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

set +e
python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >"${tmp_root}/fail.log" 2>&1
code=$?
set -e
if [[ ${code} -eq 0 ]]; then
  echo "[fail] expected literature trace gate to fail on empty template; got:" >&2
  sed -n '1,120p' "${tmp_root}/fail.log" >&2 || true
  exit 1
fi

# Append a single trace row deterministically (no network).
python3 "${BIN_DIR}/literature_fetch.py" trace-add \
  --trace-path "${tmp_root}/knowledge_base/methodology_traces/literature_queries.md" \
  --source "Manual" \
  --query "smoke: query -> shortlist -> decision" \
  --filters "none" \
  --shortlist "[DOI:10.0000/dummy](https://doi.org/10.0000/dummy)" \
  --decision "Accepted (smoke)" \
  --kb-notes "[dummy](../literature/dummy.md)" \
  >/dev/null 2>&1

python3 "${GATE}" --notes "${tmp_root}/research_contract.md" >/dev/null 2>&1

echo "[ok] literature trace gate smoke test passed"

