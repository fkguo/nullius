#!/usr/bin/env bash
set -euo pipefail

REGISTRY=""
RUNS_DIR=""
ONLY_NAME=""
IN_PLACE=0
COPY_MODE="full"
STAGE_OVERRIDE=""
EXTRA_EXCLUDES=()
WITH_REVIEWS=0

usage() {
  cat <<'EOF'
run_real_project_regression.sh

Run "realism regression" on one or more registered real projects.

Default behavior is SAFE:
- creates a snapshot copy under <runs_dir>/... (so your real project is not modified)
- runs `run_team_cycle.sh --preflight-only` against the snapshot

Usage:
  bash scripts/dev/run_real_project_regression.sh

Options:
  --registry PATH          Registry JSON path (default: <skill_root>/skilldev/regression/real_projects.json).
  --runs-dir PATH          Where to store snapshots + results (default: <skill_root>/skilldev/regression/runs).
  --name NAME              Only run one registered project by name.
  --in-place               Run directly in the real project (unsafe; may auto-fill/patch docs).
  --copy-mode MODE         full|minimal (default: full).
  --exclude PATTERN        Extra rsync exclude patterns (repeatable).
  --stage STAGE            Override stage for this regression run (exploration|development|publication).
  --with-reviews           Run full team cycle (calls external Claude+Gemini CLIs).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    --runs-dir) RUNS_DIR="${2:-}"; shift 2 ;;
    --name) ONLY_NAME="${2:-}"; shift 2 ;;
    --in-place) IN_PLACE=1; shift ;;
    --copy-mode) COPY_MODE="${2:-}"; shift 2 ;;
    --exclude) EXTRA_EXCLUDES+=( "${2:-}" ); shift 2 ;;
    --stage) STAGE_OVERRIDE="${2:-}"; shift 2 ;;
    --with-reviews) WITH_REVIEWS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

case "${COPY_MODE}" in
  full|minimal) ;;
  *)
    echo "ERROR: invalid --copy-mode: ${COPY_MODE} (expected full|minimal)" >&2
    exit 2
    ;;
esac

if [[ -n "${STAGE_OVERRIDE}" ]]; then
  case "${STAGE_OVERRIDE}" in
    exploration|development|publication) ;;
    *)
      echo "ERROR: invalid --stage: ${STAGE_OVERRIDE} (expected exploration|development|publication)" >&2
      exit 2
      ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${REGISTRY}" ]]; then
  REGISTRY="${SKILL_ROOT}/skilldev/regression/real_projects.json"
fi
if [[ -z "${RUNS_DIR}" ]]; then
  RUNS_DIR="${SKILL_ROOT}/skilldev/regression/runs"
fi

if [[ ! -f "${REGISTRY}" ]]; then
  echo "ERROR: registry not found: ${REGISTRY}" >&2
  echo "Hint: register at least one project first:" >&2
  echo "  bash scripts/dev/register_real_project_regression.sh --name <NAME> --root /path/to/project" >&2
  exit 2
fi

run_id="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "${RUNS_DIR}"

proj_list="${RUNS_DIR}/.${run_id}.projects.tsv"

python3 - "${REGISTRY}" "${ONLY_NAME}" <<'PY' >"${proj_list}"
from __future__ import annotations

import json
import sys
from pathlib import Path

reg = Path(sys.argv[1])
only = str(sys.argv[2] or "").strip()

data = json.loads(reg.read_text(encoding="utf-8", errors="replace"))
projects = data.get("projects", [])
if not isinstance(projects, list):
    projects = []

def field(d: dict, k: str, default: str = "") -> str:
    v = d.get(k, default)
    return str(v).strip() if v is not None else ""

rows = []
for p in projects:
    if not isinstance(p, dict):
        continue
    name = field(p, "name")
    if not name:
        continue
    if only and name != only:
        continue
    rows.append(
        "\t".join(
            [
                name,
                field(p, "root"),
                field(p, "notes", "Draft_Derivation.md"),
                field(p, "out_dir", "team"),
                field(p, "member_a_system", "prompts/_system_member_a.txt"),
                field(p, "member_b_system", "prompts/_system_member_b.txt"),
                field(p, "stage_override", ""),
            ]
        )
    )

if only and not rows:
    print(f"ERROR: project not found in registry: {only}", file=sys.stderr)
    raise SystemExit(2)

print("\n".join(rows))
PY

if [[ ! -s "${proj_list}" ]]; then
  echo "ERROR: no projects in registry (or filtered list is empty): ${REGISTRY}" >&2
  rm -f "${proj_list}" || true
  exit 2
fi

summary_md="${RUNS_DIR}/${run_id}_summary.md"
summary_json="${RUNS_DIR}/${run_id}_summary.json"

echo "# Realism regression summary" >"${summary_md}"
echo "" >>"${summary_md}"
echo "- Run ID: ${run_id}" >>"${summary_md}"
echo "- Registry: ${REGISTRY}" >>"${summary_md}"
echo "- Mode: $([[ ${IN_PLACE} -eq 1 ]] && echo in-place || echo snapshot)" >>"${summary_md}"
echo "- Copy mode: ${COPY_MODE}" >>"${summary_md}"
if [[ -n "${STAGE_OVERRIDE}" ]]; then
  echo "- Stage override: ${STAGE_OVERRIDE}" >>"${summary_md}"
fi
echo "" >>"${summary_md}"
echo "Results:" >>"${summary_md}"
echo "" >>"${summary_md}"

results_json_lines=()
overall_ok=1

default_excludes=(
  ".git/"
  ".venv/"
  "__pycache__/"
  "node_modules/"
  ".DS_Store"
  "team/runs/"
  "team/autopilot_state.json"
  "artifacts/runs/"
  ".tmp/"
)

minimal_includes=(
  "Draft_Derivation.md"
  "PROJECT_CHARTER.md"
  "PROJECT_MAP.md"
  "PREWORK.md"
  "RESEARCH_PLAN.md"
  "AGENTS.md"
  "research_team_config.json"
  "scan_dependency_rules.json"
)

while IFS=$'\t' read -r name root notes out_dir member_a_system member_b_system stage_override_reg; do
  if [[ -z "${name}" || -z "${root}" ]]; then
    continue
  fi
  if [[ ! -d "${root}" ]]; then
    echo "[warn] skip missing root: ${name} root=${root}" >&2
    echo "- ${name}: SKIP (missing root: ${root})" >>"${summary_md}"
    results_json_lines+=( "{\"name\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${name}"),\"status\":\"skip\",\"reason\":\"missing root\"}" )
    continue
  fi

  run_dir="${RUNS_DIR}/${name}/${run_id}"
  work_root="${root}"
  mode="in-place"
  if [[ ${IN_PLACE} -ne 1 ]]; then
    mode="snapshot"
    work_root="${run_dir}/project"
    mkdir -p "${work_root}"

    if [[ "${COPY_MODE}" == "minimal" ]]; then
      for rel in "${minimal_includes[@]}"; do
        if [[ -f "${root}/${rel}" ]]; then
          mkdir -p "$(dirname "${work_root}/${rel}")"
          cp -p "${root}/${rel}" "${work_root}/${rel}"
        fi
      done
      for rel_dir in prompts knowledge_base scripts src; do
        if [[ -d "${root}/${rel_dir}" ]]; then
          mkdir -p "${work_root}/${rel_dir}"
          rsync -a --delete "${root}/${rel_dir}/" "${work_root}/${rel_dir}/" >/dev/null
        fi
      done
    else
      rsync_args=( -a --delete )
      for ex in "${default_excludes[@]}"; do
        rsync_args+=( --exclude "${ex}" )
      done
      if [[ ${#EXTRA_EXCLUDES[@]} -gt 0 ]]; then
        for ex in "${EXTRA_EXCLUDES[@]}"; do
          if [[ -n "${ex}" ]]; then
            rsync_args+=( --exclude "${ex}" )
          fi
        done
      fi
      rsync "${rsync_args[@]}" "${root}/" "${work_root}/" >/dev/null
    fi
  fi

  # Apply stage override (CLI flag wins over registry) to the copied snapshot only.
  stage_final="${STAGE_OVERRIDE}"
  if [[ -z "${stage_final}" && -n "${stage_override_reg}" ]]; then
    stage_final="${stage_override_reg}"
  fi

  if [[ "${mode}" == "snapshot" && -n "${stage_final}" && -f "${work_root}/research_team_config.json" ]]; then
    python3 - "${work_root}/research_team_config.json" "${stage_final}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
stage = str(sys.argv[2]).strip().lower()
if stage not in ("exploration", "development", "publication"):
    raise SystemExit(2)
data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
if not isinstance(data, dict):
    data = {}
data["project_stage"] = stage
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print("[ok] patched:", path)
PY
  fi

  safe_tag="REG-${name}-${run_id}"
  code=0
  pushd "${work_root}" >/dev/null
  set +e
  cycle_args=(
    --tag "${safe_tag}"
    --notes "${notes}"
    --out-dir "${out_dir}"
    --member-a-system "${member_a_system}"
    --member-b-system "${member_b_system}"
  )
  if [[ "${WITH_REVIEWS}" -ne 1 ]]; then
    cycle_args+=( --preflight-only )
  fi
  bash "${SKILL_ROOT}/scripts/bin/run_team_cycle.sh" "${cycle_args[@]}"
  code=$?
  set -e
  popd >/dev/null

  status="ok"
  if [[ ${code} -ne 0 ]]; then
    status="fail"
    overall_ok=0
  fi

  packet="${work_root}/${out_dir}/runs/${safe_tag}/team_packet_${safe_tag}.txt"
  packet_note=""
  if [[ -f "${packet}" ]]; then
    packet_note=" packet=${packet}"
  fi

  echo "- ${name}: ${status} (exit=${code})${packet_note}" >>"${summary_md}"

  results_json_lines+=( "$(python3 - "${name}" "${root}" "${mode}" "${run_dir}" "${safe_tag}" "${code}" "${packet}" <<'PY'
from __future__ import annotations

import json
import sys

name, root, mode, run_dir, tag, code_s, packet = sys.argv[1:8]
try:
    code = int(code_s)
except Exception:
    code = 1

obj = {
    "name": name,
    "root": root,
    "mode": mode,
    "run_dir": run_dir,
    "tag": tag,
    "exit_code": code,
    "status": "ok" if code == 0 else "fail",
}
if packet and packet != "":  # may be missing
    obj["packet"] = packet
print(json.dumps(obj, ensure_ascii=False))
PY
)" )

done <"${proj_list}"

{
  echo "{"
  echo "  \"run_id\": \"${run_id}\","
  echo "  \"registry\": \"${REGISTRY}\","
  echo "  \"mode\": \"$([[ ${IN_PLACE} -eq 1 ]] && echo in-place || echo snapshot)\","
  echo "  \"copy_mode\": \"${COPY_MODE}\","
  if [[ -n "${STAGE_OVERRIDE}" ]]; then
    echo "  \"stage_override\": \"${STAGE_OVERRIDE}\","
  fi
  echo "  \"results\": ["
  for i in "${!results_json_lines[@]}"; do
    comma=","
    if [[ $i -eq $((${#results_json_lines[@]} - 1)) ]]; then
      comma=""
    fi
    echo "    ${results_json_lines[$i]}${comma}"
  done
  echo "  ]"
  echo "}"
} >"${summary_json}"

rm -f "${proj_list}" || true

echo "[ok] wrote: ${summary_md}" >&2
echo "[ok] wrote: ${summary_json}" >&2

if [[ ${overall_ok} -eq 1 ]]; then
  exit 0
fi
exit 1
