#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
DEV_DIR="${SKILL_ROOT}/scripts/dev"

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

echo "[smoke] tmp_root=${tmp_root}"

proj="${tmp_root}/proj"

echo "[setup] full scaffold"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${proj}" --project "SmokePrune" --profile "mixed" --full >/dev/null 2>&1

if [[ ! -f "${proj}/scripts/run_full_cycle.sh" ]]; then
  echo "ERROR: expected wrapper present before prune: ${proj}/scripts/run_full_cycle.sh" >&2
  exit 1
fi
if [[ ! -d "${proj}/knowledge_graph" ]]; then
  echo "ERROR: expected knowledge_graph present before prune: ${proj}/knowledge_graph" >&2
  exit 1
fi
if [[ ! -d "${proj}/mechanisms" ]]; then
  echo "ERROR: expected mechanisms present before prune: ${proj}/mechanisms" >&2
  exit 1
fi

echo "[test] dry-run (no moves)"
dry_archive="${proj}/artifacts/migrations/prune_smoke_dry"
python3 "${BIN_DIR}/prune_optional_scaffold.py" --root "${proj}" --archive-dir "${dry_archive}" >/dev/null

if [[ ! -f "${proj}/scripts/run_full_cycle.sh" ]]; then
  echo "ERROR: wrapper moved during dry-run: ${proj}/scripts/run_full_cycle.sh" >&2
  exit 1
fi
if [[ ! -f "${dry_archive}/prune_report.json" || ! -f "${dry_archive}/prune_report.md" ]]; then
  echo "ERROR: expected dry-run reports under: ${dry_archive}" >&2
  exit 1
fi

echo "[test] apply (moves)"
apply_archive="${proj}/artifacts/migrations/prune_smoke_apply"
python3 "${BIN_DIR}/prune_optional_scaffold.py" --root "${proj}" --apply --archive-dir "${apply_archive}" >/dev/null

if [[ -f "${proj}/scripts/run_full_cycle.sh" ]]; then
  echo "ERROR: wrapper still present after apply prune: ${proj}/scripts/run_full_cycle.sh" >&2
  exit 1
fi
if [[ ! -f "${apply_archive}/scripts/run_full_cycle.sh" ]]; then
  echo "ERROR: expected archived wrapper missing: ${apply_archive}/scripts/run_full_cycle.sh" >&2
  exit 1
fi
if [[ -d "${proj}/knowledge_graph" ]]; then
  echo "ERROR: knowledge_graph still present after apply prune: ${proj}/knowledge_graph" >&2
  exit 1
fi
if [[ -d "${proj}/mechanisms" ]]; then
  echo "ERROR: mechanisms still present after apply prune: ${proj}/mechanisms" >&2
  exit 1
fi

echo "[test] minimal scaffold contract passes"
bash "${DEV_DIR}/check_scaffold_output_contract.sh" --root "${proj}" --variant minimal >/dev/null

echo "[ok] prune_optional_scaffold smoke test passed"
