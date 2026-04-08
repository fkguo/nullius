#!/usr/bin/env bash
set -euo pipefail

ROOT=""
PROJECT=""
PROFILE=""
FORCE=0

usage() {
  cat <<'EOF'
scaffold_theory_mechanisms.sh

Usage:
  scaffold_theory_mechanisms.sh --root <project_root> --project <project_name> [--profile PROFILE] [--force]

Creates (if missing) minimal executable artifacts for theory-breakthrough mechanisms:
  - mechanisms/00_pre_task_clarifier.md
  - mechanisms/01_analogy_mining.md
  - mechanisms/02_problem_framing_protocol.md

These are templates/playbooks (NOT hard gates).

Exit codes:
  0  success
  1  runtime error
  2  usage / input error
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${ROOT}" || -z "${PROJECT}" ]]; then
  echo "ERROR: --root and --project are required" >&2
  usage
  exit 2
fi
if [[ ! -d "${ROOT}" ]]; then
  echo "ERROR: root dir not found: ${ROOT}" >&2
  exit 2
fi

if [[ -z "${PROFILE}" ]]; then
  PROFILE="mixed"
fi
case "${PROFILE}" in
  theory_only|numerics_only|mixed|exploratory|literature_review|methodology_dev|toolkit_extraction|custom) ;;
  *)
    echo "ERROR: invalid --profile: ${PROFILE}" >&2
    echo "  allowed: theory_only|numerics_only|mixed|exploratory|literature_review|methodology_dev|toolkit_extraction|custom" >&2
    exit 2
    ;;
esac

ASSETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../assets" && pwd)"
MECH_ASSETS="${ASSETS_DIR}/mechanisms"
if [[ ! -d "${MECH_ASSETS}" ]]; then
  echo "ERROR: missing mechanisms assets dir: ${MECH_ASSETS}" >&2
  exit 2
fi

mkdir -p "${ROOT}/mechanisms"

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

copy_template "${MECH_ASSETS}/clarifier_template.md" "${ROOT}/mechanisms/00_pre_task_clarifier.md"
copy_template "${MECH_ASSETS}/analogy_mining_template.md" "${ROOT}/mechanisms/01_analogy_mining.md"
copy_template "${MECH_ASSETS}/problem_framing_protocol_template.md" "${ROOT}/mechanisms/02_problem_framing_protocol.md"

echo "[done] theory mechanisms scaffolded under: ${ROOT}/mechanisms"
