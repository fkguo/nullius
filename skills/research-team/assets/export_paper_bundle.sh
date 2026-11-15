#!/usr/bin/env bash
set -euo pipefail

# Project-local convenience wrapper (keeps commands short and shareable).
#
# Usage:
#   bash scripts/export_paper_bundle.sh --tag M3-r1 --out export [--tex paper/main.tex --bib references.bib]
#   bash scripts/export_paper_bundle.sh --tag M3-r1 --without-project-docs --writer-export paper/export_manifest.json
#   bash scripts/export_paper_bundle.sh --tag M3-r1 --without-project-docs --include reports/stage.md --include paper/main.pdf

SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/export_paper_bundle.sh" "$@"
