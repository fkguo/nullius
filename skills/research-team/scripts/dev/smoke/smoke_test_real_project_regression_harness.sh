#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

proj="${tmp_root}/proj"
registry="${tmp_root}/registry.json"
runs_dir="${tmp_root}/runs"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${proj}" --project "SmokeRealRegression" --profile "exploratory" >/dev/null 2>&1
bash "${BIN_DIR}/generate_demo_milestone.sh" --root "${proj}" --tag "M0-demo" --force >/dev/null 2>&1

# Force exploration stage so warn-only gates won't block this harness smoke.
python3 - "${proj}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
if not isinstance(d, dict):
    d = {}
d["project_stage"] = "exploration"
p.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
PY

bash "${SKILL_ROOT}/scripts/dev/register_real_project_regression.sh" \
  --name smoke \
  --root "${proj}" \
  --registry "${registry}" \
  --stage exploration >/dev/null

bash "${SKILL_ROOT}/scripts/dev/run_real_project_regression.sh" \
  --registry "${registry}" \
  --runs-dir "${runs_dir}" \
  --copy-mode full >/dev/null

test -f "${runs_dir}/"*_summary.md
test -f "${runs_dir}/"*_summary.json

echo "[ok] real-project regression harness smoke test passed"

