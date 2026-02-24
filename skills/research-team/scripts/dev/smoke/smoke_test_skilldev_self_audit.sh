#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${SKILL_ROOT}/scripts/dev/run_skilldev_self_audit.sh" --workspace "${tmp_root}" --stage development

packet="${tmp_root}/team/runs/SKILLDEV-M0/team_packet_SKILLDEV-M0.txt"
if [[ ! -f "${packet}" ]]; then
  echo "ERROR: expected packet not found: ${packet}" >&2
  exit 1
fi

echo "[ok] skilldev self-audit smoke test passed"
