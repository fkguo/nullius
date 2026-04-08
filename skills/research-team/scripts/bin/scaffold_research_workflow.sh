#!/usr/bin/env bash
set -euo pipefail

ROOT=""
PROJECT=""
PROFILE="mixed"
FORCE=0
SKIP_PREFLIGHT=0
VARIANT="minimal"
WITH_HEP_PROVIDER=0
PROJECT_POLICY="real_project"

usage() {
  cat <<'EOF'
Usage:
  scaffold_research_workflow.sh --root <project_root> --project <project_name> [--profile PROFILE] [--full] [--with-hep-provider] [--project-policy real_project|maintainer_fixture] [--force] [--skip-prework]

Default behavior creates the canonical minimal project scaffold:
  - project_charter.md
  - project_index.md
  - research_plan.md
  - research_notebook.md
  - research_contract.md
  - .mcp.template.json

Use --full to add research-team host-local surfaces:
  - prompts/
  - research_team_config.json
  - knowledge_base/
  - knowledge_graph/
  - mechanisms/
  - references/
  - team/
  - scripts/

Use --with-hep-provider to add provider-local HEP surfaces on top of either scaffold:
  - .hep/workspace.json
  - .hep/mappings.json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --full) VARIANT="full"; shift ;;
    --minimal) VARIANT="minimal"; shift ;;
    --with-hep-provider) WITH_HEP_PROVIDER=1; shift ;;
    --project-policy) PROJECT_POLICY="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --skip-prework) SKIP_PREFLIGHT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${ROOT}" || -z "${PROJECT}" ]]; then
  echo "ERROR: --root and --project are required" >&2
  usage
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ASSETS_DIR="${SKILL_ROOT}/assets"
PROJECT_CONTRACTS_SRC="${REPO_ROOT}/packages/project-contracts/src"

case "${PROJECT_POLICY}" in
  real_project|maintainer_fixture) ;;
  *)
    echo "ERROR: invalid --project-policy: ${PROJECT_POLICY} (expected real_project|maintainer_fixture)" >&2
    exit 2
    ;;
esac

copy_template() {
  local src="$1"
  local dst="$2"
  if [[ -e "${dst}" && "${FORCE}" -ne 1 ]]; then
    echo "[skip] exists: ${dst}"
    return 0
  fi
  mkdir -p "$(dirname "${dst}")"
  python3 - "$src" "$dst" "$PROJECT" "$ROOT" "$PROFILE" <<'PY'
from __future__ import annotations
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
project = sys.argv[3]
root = sys.argv[4]
profile = sys.argv[5]
text = src.read_text(encoding="utf-8")
text = text.replace("<PROJECT_NAME>", project).replace("<PROJECT_ROOT>", root).replace("<PROFILE>", profile)
dst.write_text(text, encoding="utf-8")
PY
  echo "[ok] wrote: ${dst}"
}

echo "[step] render canonical scaffold (${VARIANT})"
if [[ -d "${PROJECT_CONTRACTS_SRC}" ]]; then
  PYTHONPATH="${PROJECT_CONTRACTS_SRC}${PYTHONPATH:+:${PYTHONPATH}}" python3 -m project_contracts.project_scaffold_cli \
    --root "${ROOT}" \
    --project "${PROJECT}" \
    --profile "${PROFILE}" \
    --variant "${VARIANT}" \
    --project-policy "${PROJECT_POLICY}" \
    $([[ "${FORCE}" -eq 1 ]] && printf '%s' -- '--force')
else
  python3 -m project_contracts.project_scaffold_cli \
    --root "${ROOT}" \
    --project "${PROJECT}" \
    --profile "${PROFILE}" \
    --variant "${VARIANT}" \
    --project-policy "${PROJECT_POLICY}" \
    $([[ "${FORCE}" -eq 1 ]] && printf '%s' -- '--force')
fi

if [[ "${VARIANT}" != "full" ]]; then
  echo "[done] minimal scaffold created in: ${ROOT}"
  exit 0
fi

mkdir -p "${ROOT}/prompts" "${ROOT}/team/runs" "${ROOT}/artifacts/runs"
mkdir -p "${ROOT}/references/inspire" "${ROOT}/references/arxiv_src" "${ROOT}/references/github"
mkdir -p "${ROOT}/knowledge_base/literature" "${ROOT}/knowledge_base/methodology_traces" "${ROOT}/knowledge_base/priors"
mkdir -p "${ROOT}/knowledge_graph" "${ROOT}/mechanisms"

if [[ "${WITH_HEP_PROVIDER}" -eq 1 ]]; then
  copy_template "${ASSETS_DIR}/hep_workspace_template.json" "${ROOT}/.hep/workspace.json"
  copy_template "${ASSETS_DIR}/hep_mappings_template.json" "${ROOT}/.hep/mappings.json"
fi
copy_template "${ASSETS_DIR}/team_packet_template.txt" "${ROOT}/prompts/_team_packet.txt"
copy_template "${ASSETS_DIR}/system_member_a.txt" "${ROOT}/prompts/_system_member_a.txt"
copy_template "${ASSETS_DIR}/system_member_b.txt" "${ROOT}/prompts/_system_member_b.txt"
copy_template "${ASSETS_DIR}/system_draft_member_a.txt" "${ROOT}/prompts/_system_draft_member_a.txt"
copy_template "${ASSETS_DIR}/system_draft_member_b.txt" "${ROOT}/prompts/_system_draft_member_b.txt"
copy_template "${ASSETS_DIR}/system_draft_member_c_leader.txt" "${ROOT}/prompts/_system_draft_member_c_leader.txt"
copy_template "${ASSETS_DIR}/prompts_readme_template.md" "${ROOT}/prompts/README.md"
copy_template "${ASSETS_DIR}/system_member_c_numerics.txt" "${ROOT}/prompts/_system_member_c_numerics.txt"
copy_template "${ASSETS_DIR}/scan_dependency_rules_template.json" "${ROOT}/scan_dependency_rules.json"
copy_template "${ASSETS_DIR}/research_team_config_template.json" "${ROOT}/research_team_config.json"
copy_template "${ASSETS_DIR}/run_full_cycle.sh" "${ROOT}/scripts/run_full_cycle.sh"
copy_template "${ASSETS_DIR}/run_autopilot.sh" "${ROOT}/scripts/run_autopilot.sh"
copy_template "${ASSETS_DIR}/run_claude.sh" "${ROOT}/scripts/run_claude.sh"
copy_template "${ASSETS_DIR}/run_gemini.sh" "${ROOT}/scripts/run_gemini.sh"
copy_template "${ASSETS_DIR}/execute_task.sh" "${ROOT}/scripts/execute_task.sh"
copy_template "${ASSETS_DIR}/export_paper_bundle.sh" "${ROOT}/scripts/export_paper_bundle.sh"
copy_template "${ASSETS_DIR}/references_readme_template.md" "${ROOT}/references/README.md"
copy_template "${ASSETS_DIR}/team_latest_template.md" "${ROOT}/team/LATEST.md"
copy_template "${ASSETS_DIR}/team_latest_team_template.md" "${ROOT}/team/LATEST_TEAM.md"
copy_template "${ASSETS_DIR}/team_latest_draft_template.md" "${ROOT}/team/LATEST_DRAFT.md"
copy_template "${ASSETS_DIR}/artifacts_latest_template.md" "${ROOT}/artifacts/LATEST.md"
copy_template "${ASSETS_DIR}/knowledge_base_readme_template.md" "${ROOT}/knowledge_base/README.md"
copy_template "${ASSETS_DIR}/methodology_trace_template.md" "${ROOT}/knowledge_base/methodology_traces/_template.md"
copy_template "${ASSETS_DIR}/literature_queries_template.md" "${ROOT}/knowledge_base/methodology_traces/literature_queries.md"
copy_template "${ASSETS_DIR}/knowledge_graph_readme_template.md" "${ROOT}/knowledge_graph/README.md"
copy_template "${ASSETS_DIR}/mechanisms/clarifier_template.md" "${ROOT}/mechanisms/00_pre_task_clarifier.md"
copy_template "${ASSETS_DIR}/mechanisms/analogy_mining_template.md" "${ROOT}/mechanisms/01_analogy_mining.md"
copy_template "${ASSETS_DIR}/mechanisms/problem_framing_protocol_template.md" "${ROOT}/mechanisms/02_problem_framing_protocol.md"

profile_lc="$(printf '%s' "${PROFILE}" | tr '[:upper:]' '[:lower:]')"
if [[ "${profile_lc}" == "toolkit_extraction" ]]; then
  copy_template "${ASSETS_DIR}/TOOLKIT_API_template.md" "${ROOT}/TOOLKIT_API.md"
fi

for rel in \
  "knowledge_graph/claims.jsonl" \
  "knowledge_graph/edges.jsonl" \
  "knowledge_graph/evidence_manifest.jsonl"
do
  if [[ ! -e "${ROOT}/${rel}" || "${FORCE}" -eq 1 ]]; then
    mkdir -p "$(dirname "${ROOT}/${rel}")"
    : > "${ROOT}/${rel}"
    echo "[ok] wrote: ${ROOT}/${rel}"
  fi
done

python3 - "${ROOT}/research_team_config.json" "${WITH_HEP_PROVIDER}" <<'PY'
from __future__ import annotations
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
with_hep_provider = sys.argv[2] == "1"
data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
if isinstance(data, dict):
    features = data.get("features", {})
    if not isinstance(features, dict):
        features = {}
    features["hep_workspace_gate"] = with_hep_provider
    data["features"] = features
    data["scaffold_variant"] = "full"
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

if [[ "${SKIP_PREFLIGHT}" -eq 1 && -f "${ROOT}/research_team_config.json" ]]; then
  python3 - "${ROOT}/research_team_config.json" <<'PY'
from __future__ import annotations
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
features = data.get("features", {})
if not isinstance(features, dict):
    features = {}
features["knowledge_layers_gate"] = False
features["problem_framing_snapshot_gate"] = False
data["features"] = features
prework = data.get("prework", {})
if not isinstance(prework, dict):
    prework = {}
prework["required"] = False
data["prework"] = prework
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
fi

chmod +x "${ROOT}/scripts/"*.sh
echo "[done] full research-team scaffold created in: ${ROOT}"
