#!/usr/bin/env bash
set -euo pipefail

ROOT=""
PROJECT=""
PROFILE=""
FORCE=0
SKIP_PREWORK=0
MINIMAL=0

usage() {
  cat <<'EOF'
Usage:
  scaffold_research_workflow.sh --root <project_root> --project <project_name> [--profile PROFILE] [--force] [--skip-prework] [--minimal]

Creates (if missing) a reproducible research workflow scaffold:
  - PROJECT_MAP.md
  - RESEARCH_PLAN.md
  - Draft_Derivation.md
  - INNOVATION_LOG.md
  - PROJECT_CHARTER.md
  - AGENTS.md
  - PREWORK.md
  - INITIAL_INSTRUCTION.md
  - (Draft_Derivation includes a mandatory Reproducibility Capsule block)
  - prompts/_team_packet.txt
  - prompts/_system_member_a.txt
  - prompts/_system_member_b.txt
  - research_team_config.json
  - knowledge_base/README.md
  - knowledge_base/methodology_traces/_template.md
  - references/README.md (and references/arxiv_src, references/inspire, references/github)
  - scripts/run_full_cycle.sh
  - team/ (runs/ + LATEST.md)
  - artifacts/ (runs/ + LATEST.md)

--force overwrites existing files.
--skip-prework creates the scaffold but relaxes prework enforcement by disabling
  the knowledge-layers and problem framing snapshot gates in research_team_config.json.
--minimal creates a smaller scaffold focused on the core workflow (docs + config + 2-member team cycle).
  Optional components can be added later by re-running this command without --minimal (no --force).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --skip-prework) SKIP_PREWORK=1; shift ;;
    --minimal) MINIMAL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${ROOT}" || -z "${PROJECT}" ]]; then
  echo "ERROR: --root and --project are required" >&2
  usage
  exit 2
fi

if [[ -n "${PROFILE}" ]]; then
  case "${PROFILE}" in
    theory_only|numerics_only|mixed|exploratory|literature_review|methodology_dev|toolkit_extraction|custom) ;;
    *)
      echo "ERROR: invalid --profile: ${PROFILE}" >&2
      echo "  allowed: theory_only|numerics_only|mixed|exploratory|literature_review|methodology_dev|toolkit_extraction|custom" >&2
      exit 2
      ;;
  esac
fi

ASSETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../assets" && pwd)"

mkdir -p "${ROOT}/prompts" "${ROOT}/team/runs"
if [[ "${MINIMAL}" -ne 1 ]]; then
  mkdir -p "${ROOT}/scripts"
fi
mkdir -p "${ROOT}/artifacts/runs"
mkdir -p "${ROOT}/references/inspire" "${ROOT}/references/arxiv_src" "${ROOT}/references/github"

escape_sed_repl() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//&/\\&}"
  s="${s//\//\\/}"
  printf '%s' "${s}"
}

copy_template() {
  local src="$1"
  local dst="$2"
  if [[ -e "${dst}" && "${FORCE}" -ne 1 ]]; then
    echo "[skip] exists: ${dst}"
    return 0
  fi
  mkdir -p "$(dirname "${dst}")"
  # Replace a minimal placeholder set.
  local project_escaped
  local root_escaped
  local profile_escaped
  project_escaped="$(escape_sed_repl "${PROJECT}")"
  root_escaped="$(escape_sed_repl "${ROOT}")"
  profile_escaped="$(escape_sed_repl "${PROFILE}")"
  sed \
    -e "s/<PROJECT_NAME>/${project_escaped}/g" \
    -e "s/<PROJECT_ROOT>/${root_escaped}/g" \
    -e "s/<PROFILE>/${profile_escaped}/g" \
    "${src}" > "${dst}"
  echo "[ok] wrote: ${dst}"
}

# hep-research-mcp ecosystem bootstrap (v1): per-project workspace + mappings under .hep/
copy_template "${ASSETS_DIR}/hep_workspace_template.json" "${ROOT}/.hep/workspace.json"
copy_template "${ASSETS_DIR}/hep_mappings_template.json" "${ROOT}/.hep/mappings.json"

copy_template "${ASSETS_DIR}/research_plan_template.md" "${ROOT}/RESEARCH_PLAN.md"
copy_template "${ASSETS_DIR}/derivation_notes_template.md" "${ROOT}/Draft_Derivation.md"
copy_template "${ASSETS_DIR}/innovation_log_template.md" "${ROOT}/INNOVATION_LOG.md"
copy_template "${ASSETS_DIR}/AGENTS_template.md" "${ROOT}/AGENTS.md"
if [[ "${SKIP_PREWORK}" -ne 1 ]]; then
  copy_template "${ASSETS_DIR}/PREWORK_template.md" "${ROOT}/PREWORK.md"
else
  echo "[skip] --skip-prework: not creating PREWORK.md"
fi
copy_template "${ASSETS_DIR}/INITIAL_INSTRUCTION_template.md" "${ROOT}/INITIAL_INSTRUCTION.md"
copy_template "${ASSETS_DIR}/PROJECT_CHARTER_template.md" "${ROOT}/PROJECT_CHARTER.md"
copy_template "${ASSETS_DIR}/project_map_template.md" "${ROOT}/PROJECT_MAP.md"
if [[ "${PROFILE}" == "toolkit_extraction" ]]; then
  copy_template "${ASSETS_DIR}/TOOLKIT_API_template.md" "${ROOT}/TOOLKIT_API.md"
fi
copy_template "${ASSETS_DIR}/team_packet_template.txt" "${ROOT}/prompts/_team_packet.txt"
copy_template "${ASSETS_DIR}/system_member_a.txt" "${ROOT}/prompts/_system_member_a.txt"
copy_template "${ASSETS_DIR}/system_member_b.txt" "${ROOT}/prompts/_system_member_b.txt"
if [[ "${MINIMAL}" -ne 1 ]]; then
  copy_template "${ASSETS_DIR}/system_draft_member_a.txt" "${ROOT}/prompts/_system_draft_member_a.txt"
  copy_template "${ASSETS_DIR}/system_draft_member_b.txt" "${ROOT}/prompts/_system_draft_member_b.txt"
  copy_template "${ASSETS_DIR}/system_draft_member_c_leader.txt" "${ROOT}/prompts/_system_draft_member_c_leader.txt"
  copy_template "${ASSETS_DIR}/prompts_readme_template.md" "${ROOT}/prompts/README.md"
  copy_template "${ASSETS_DIR}/system_member_c_numerics.txt" "${ROOT}/prompts/_system_member_c_numerics.txt"
else
  echo "[skip] --minimal: not creating draft/sidecar review prompts"
fi
copy_template "${ASSETS_DIR}/scan_dependency_rules_template.json" "${ROOT}/scan_dependency_rules.json"
copy_template "${ASSETS_DIR}/research_team_config_template.json" "${ROOT}/research_team_config.json"
if [[ "${MINIMAL}" -ne 1 ]]; then
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
else
  echo "[skip] --minimal: not creating wrapper scripts or pointer files"
fi

# Knowledge base scaffold (domain-neutral).
mkdir -p "${ROOT}/knowledge_base/literature" "${ROOT}/knowledge_base/methodology_traces" "${ROOT}/knowledge_base/priors"
copy_template "${ASSETS_DIR}/knowledge_base_readme_template.md" "${ROOT}/knowledge_base/README.md"
copy_template "${ASSETS_DIR}/methodology_trace_template.md" "${ROOT}/knowledge_base/methodology_traces/_template.md"
copy_template "${ASSETS_DIR}/literature_queries_template.md" "${ROOT}/knowledge_base/methodology_traces/literature_queries.md"

if [[ "${SKIP_PREWORK}" -eq 1 && -f "${ROOT}/research_team_config.json" ]]; then
  echo "[info] --skip-prework: patching research_team_config.json to disable prework-related gates"
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

path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print("[ok] patched:", path)
PY
fi

if [[ "${MINIMAL}" -ne 1 ]]; then
  if [[ -f "${ROOT}/scripts/run_full_cycle.sh" ]]; then
    chmod +x "${ROOT}/scripts/run_full_cycle.sh"
  fi
  if [[ -f "${ROOT}/scripts/run_autopilot.sh" ]]; then
    chmod +x "${ROOT}/scripts/run_autopilot.sh"
  fi
  if [[ -f "${ROOT}/scripts/run_claude.sh" ]]; then
    chmod +x "${ROOT}/scripts/run_claude.sh"
  fi
  if [[ -f "${ROOT}/scripts/run_gemini.sh" ]]; then
    chmod +x "${ROOT}/scripts/run_gemini.sh"
  fi
  if [[ -f "${ROOT}/scripts/execute_task.sh" ]]; then
    chmod +x "${ROOT}/scripts/execute_task.sh"
  fi
  if [[ -f "${ROOT}/scripts/export_paper_bundle.sh" ]]; then
    chmod +x "${ROOT}/scripts/export_paper_bundle.sh"
  fi
fi

# Record scaffold variant (best-effort; do not overwrite user edits).
if [[ -f "${ROOT}/research_team_config.json" ]]; then
  variant="full"
  if [[ "${MINIMAL}" -eq 1 ]]; then
    variant="minimal"
  fi
  SCAFFOLD_VARIANT="${variant}" python3 - "${ROOT}/research_team_config.json" <<'PY' || true
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
variant = os.environ.get("SCAFFOLD_VARIANT", "").strip()
if variant and isinstance(data, dict):
    data["scaffold_variant"] = variant
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print("[ok] recorded scaffold_variant:", variant)
PY
fi

# Claim DAG / Evidence scaffold (MVP).
if [[ "${MINIMAL}" -ne 1 ]]; then
  CLAIM_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scaffold" && pwd)/scaffold_claim_dag.sh"
  if [[ -f "${CLAIM_SCRIPT}" ]]; then
    claim_args=( --root "${ROOT}" --project "${PROJECT}" )
    if [[ "${FORCE}" -eq 1 ]]; then
      claim_args+=( --force )
    fi
    bash "${CLAIM_SCRIPT}" "${claim_args[@]}"
  fi
else
  echo "[skip] --minimal: not creating knowledge_graph scaffold"
fi

# Theory breakthrough mechanisms scaffold (templates/playbooks; non-blocking).
if [[ "${MINIMAL}" -ne 1 ]]; then
  MECH_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scaffold" && pwd)/scaffold_theory_mechanisms.sh"
  if [[ -f "${MECH_SCRIPT}" ]]; then
    mech_args=( --root "${ROOT}" --project "${PROJECT}" )
    if [[ -n "${PROFILE}" ]]; then
      mech_args+=( --profile "${PROFILE}" )
    fi
    if [[ "${FORCE}" -eq 1 ]]; then
      mech_args+=( --force )
    fi
    bash "${MECH_SCRIPT}" "${mech_args[@]}" || echo "[warn] theory mechanisms scaffold failed (non-blocking)" >&2
  fi
else
  echo "[skip] --minimal: not creating mechanisms scaffold"
fi

# Backward-compatible: if an existing Draft_Derivation.md lacks capsule markers, insert the capsule template.
NOTES_PATH="${ROOT}/Draft_Derivation.md"
if [[ -f "${NOTES_PATH}" ]]; then
  has_marker=0
  if command -v rg >/dev/null 2>&1; then
    rg -q "<!-- REPRO_CAPSULE_START -->" "${NOTES_PATH}" && has_marker=1 || has_marker=0
  else
    grep -q "<!-- REPRO_CAPSULE_START -->" "${NOTES_PATH}" && has_marker=1 || has_marker=0
  fi
  if [[ "${has_marker}" -ne 1 ]]; then
    echo "[warn] Draft_Derivation.md missing capsule markers; inserting template block."
    tmp="$(mktemp)"
    python3 - "${ASSETS_DIR}/derivation_notes_template.md" "${NOTES_PATH}" "${tmp}" <<'PY'
from __future__ import annotations
import sys
from pathlib import Path

tmpl = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
notes = Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace")
outp = Path(sys.argv[3])

START = "<!-- REPRO_CAPSULE_START -->"
END = "<!-- REPRO_CAPSULE_END -->"

def extract_block(text: str) -> str:
    if START not in text or END not in text:
        return ""
    a = text.index(START)
    b = text.index(END) + len(END)
    return text[a:b].rstrip() + "\n\n"

block = extract_block(tmpl)
if not block:
    raise SystemExit("ERROR: template missing capsule block")

outp.write_text(block + notes, encoding="utf-8")
print("Wrote:", outp)
PY
    mv "${tmp}" "${NOTES_PATH}"
    echo "[ok] inserted capsule template into: ${NOTES_PATH}"
  fi
fi

echo "[done] scaffold created in: ${ROOT}"
