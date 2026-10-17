# Sourced by run_team_cycle.sh and run_draft_cycle.sh (needs PROJECT_ROOT and SKILLS_DIR).
#
# Sets LOCAL_CLAUDE_RUNNER to the project's scripts/run_claude.sh when that copy carries the
# context-exclusion marker. A copy made before the exclusion existed loads the operator's own
# CLAUDE.md / AGENTS.md / auto memory into every reviewer lane, so it is replaced for this run by
# the shared claude-cli-runner (same arguments, context excluded); the project file is left
# untouched. Refresh the copy with: cp <skills>/research-team/assets/run_claude.sh scripts/run_claude.sh
RESEARCH_TEAM_CLAUDE_RUNNER_MARKER="research-team-claude-runner: context-excluded"
LOCAL_CLAUDE_RUNNER="${PROJECT_ROOT}/scripts/run_claude.sh"
if [[ -f "${LOCAL_CLAUDE_RUNNER}" ]] && ! grep -q -- "${RESEARCH_TEAM_CLAUDE_RUNNER_MARKER}" "${LOCAL_CLAUDE_RUNNER}"; then
  _shared_claude_runner="${SKILLS_DIR}/claude-cli-runner/scripts/run_claude.sh"
  if [[ -f "${_shared_claude_runner}" ]]; then
    echo "[warn] ${LOCAL_CLAUDE_RUNNER} predates the operator-context exclusion (it would load your CLAUDE.md, AGENTS.md and auto memory into reviewer lanes); using ${_shared_claude_runner} for this run. Refresh it: cp '${SKILLS_DIR}/research-team/assets/run_claude.sh' '${LOCAL_CLAUDE_RUNNER}'" >&2
    LOCAL_CLAUDE_RUNNER="${_shared_claude_runner}"
  else
    echo "[error] ${LOCAL_CLAUDE_RUNNER} predates the operator-context exclusion and the shared claude-cli-runner is not available; refresh the copy from research-team/assets/run_claude.sh" >&2
    exit 2
  fi
fi
