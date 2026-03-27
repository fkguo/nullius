#!/usr/bin/env bash
set -euo pipefail

# Thin wrapper: delegate argument parsing to the skill implementation so that calls like
# `bash scripts/run_autopilot.sh . --once --mode assist` work as expected.
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/run_autopilot.sh" "$@"
