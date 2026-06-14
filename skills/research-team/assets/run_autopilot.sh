#!/usr/bin/env bash
set -euo pipefail

# Thin wrapper: delegate argument parsing to the skill implementation so that calls like
# `bash scripts/run_autopilot.sh . --once --mode assist` work as expected.
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/run_autopilot.sh" "$@"
