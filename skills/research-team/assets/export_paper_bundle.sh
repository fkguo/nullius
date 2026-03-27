#!/usr/bin/env bash
set -euo pipefail

# Project-local convenience wrapper (keeps commands short and shareable).
#
# Usage:
#   bash scripts/export_paper_bundle.sh --tag M3-r1 --out export [--tex paper/main.tex --bib references.bib]

SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/export_paper_bundle.sh" "$@"
