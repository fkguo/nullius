# project_brief.md

Paste the user's initial project instruction here. This file is used for auto-fill.

Recommended next step (human review):
- Generate `PROJECT_START_PROMPT.md` (kickoff prompt) and review/approve it before auto-run:
  - `python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/generate_project_start_prompt.py" --root .`
  - Set `Status: APPROVED` in that file when ready.

Example:
- Goal:
- Background:
- Required references (if any):
- Constraints:
