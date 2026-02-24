#!/usr/bin/env bash
set -euo pipefail

ROOT=""
PROJECT=""
FORCE=0

usage() {
  cat <<'EOF'
scaffold_claim_dag.sh

Usage:
  scaffold_claim_dag.sh --root <project_root> --project <project_name> [--force]

Creates a minimal Claim DAG + Evidence scaffold under:
  knowledge_graph/
    claims.jsonl
    edges.jsonl
    evidence_manifest.jsonl
    README.md

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

ASSETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../assets" && pwd)"
README_TPL="${ASSETS_DIR}/knowledge_graph_readme_template.md"
if [[ ! -f "${README_TPL}" ]]; then
  echo "ERROR: missing README template: ${README_TPL}" >&2
  exit 2
fi

escape_sed_repl() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//&/\\&}"
  s="${s//\//\\/}"
  printf '%s' "${s}"
}

write_file_if_needed() {
  local path="$1"
  local content="$2"
  if [[ -e "${path}" && "${FORCE}" -ne 1 ]]; then
    echo "[skip] exists: ${path}"
    return 0
  fi
  mkdir -p "$(dirname "${path}")"
  printf "%s" "${content}" > "${path}"
  echo "[ok] wrote: ${path}"
}

# Ensure directory exists.
mkdir -p "${ROOT}/knowledge_graph"

write_file_if_needed "${ROOT}/knowledge_graph/claims.jsonl" $'\n'
write_file_if_needed "${ROOT}/knowledge_graph/edges.jsonl" $'\n'
write_file_if_needed "${ROOT}/knowledge_graph/evidence_manifest.jsonl" $'\n'

if [[ -e "${ROOT}/knowledge_graph/README.md" && "${FORCE}" -ne 1 ]]; then
  echo "[skip] exists: ${ROOT}/knowledge_graph/README.md"
else
  project_escaped="$(escape_sed_repl "${PROJECT}")"
  sed -e "s/<PROJECT_NAME>/${project_escaped}/g" "${README_TPL}" > "${ROOT}/knowledge_graph/README.md"
  echo "[ok] wrote: ${ROOT}/knowledge_graph/README.md"
fi

echo "[done] knowledge_graph scaffold created in: ${ROOT}/knowledge_graph"
