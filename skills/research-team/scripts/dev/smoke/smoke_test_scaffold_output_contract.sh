#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SCAFFOLD="${SKILL_ROOT}/scripts/bin/scaffold_research_workflow.sh"
CHECK="${SKILL_ROOT}/scripts/dev/check_scaffold_output_contract.sh"

if [[ ! -f "${SCAFFOLD}" || ! -f "${CHECK}" ]]; then
  echo "ERROR: missing required scripts under: ${SKILL_ROOT}" >&2
  exit 2
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

echo "[smoke] tmp_root=${tmp_root}"

proj="${tmp_root}/proj"
bash "${SCAFFOLD}" --root "${proj}" --project "SmokeProject" --profile "mixed" --full
bash "${CHECK}" --root "${proj}" --variant full

if [[ -e "${proj}/.hep" ]]; then
  echo "ERROR: default full scaffold should not precreate provider-local .hep surfaces" >&2
  exit 1
fi
python3 - "${proj}/research_team_config.json" <<'PY'
from __future__ import annotations
import json
import sys
from pathlib import Path

cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
features = cfg.get("features", {}) if isinstance(cfg, dict) else {}
if features.get("hep_workspace_gate") is not False:
    raise SystemExit("expected hep_workspace_gate=false for default full scaffold")
PY

proj_hep="${tmp_root}/proj-hep"
bash "${SCAFFOLD}" --root "${proj_hep}" --project "SmokeProjectHep" --profile "mixed" --full --with-hep-provider
bash "${CHECK}" --root "${proj_hep}" --variant full

if [[ ! -f "${proj_hep}/.hep/workspace.json" || ! -f "${proj_hep}/.hep/mappings.json" ]]; then
  echo "ERROR: --with-hep-provider should create provider-local .hep surfaces" >&2
  exit 1
fi
python3 - "${proj_hep}/research_team_config.json" <<'PY'
from __future__ import annotations
import json
import sys
from pathlib import Path

cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
features = cfg.get("features", {}) if isinstance(cfg, dict) else {}
if features.get("hep_workspace_gate") is not True:
    raise SystemExit("expected hep_workspace_gate=true when --with-hep-provider is used")
PY

echo "[ok] scaffold output contract smoke test passed"
