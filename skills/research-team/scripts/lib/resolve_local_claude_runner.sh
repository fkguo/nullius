# Sourced by run_team_cycle.sh (needs PROJECT_ROOT and SKILLS_DIR).
#
# Sets LOCAL_CLAUDE_RUNNER to the project's scripts/run_claude.sh when that copy is current: it
# carries the context-exclusion marker line AND the --safe-mode flag on every real `claude --print` line
# (a copy edited to drop the flag from any of them is stale). A stale copy loads the operator's own CLAUDE.md / AGENTS.md /
# auto memory into every reviewer lane, so it is replaced for this run by the shared claude-cli-runner
# (same arguments, context excluded); the project file is left untouched.
# Refresh the copy with: cp <skills>/research-team/assets/run_claude.sh scripts/run_claude.sh
#
# Once the members' runner kinds are final, run_team_cycle.sh calls
# research_team_check_local_claude_runner, which warns (or refuses, see below) only if a member
# actually uses the Claude runner.
RESEARCH_TEAM_CLAUDE_RUNNER_MARKER="research-team-claude-runner: context-excluded"
LOCAL_CLAUDE_RUNNER="${PROJECT_ROOT}/scripts/run_claude.sh"
STALE_LOCAL_CLAUDE_RUNNER=""
# Every `claude --print` line must carry --safe-mode: the asset has two (with and without --model), and
# run_team_cycle.sh passes --model only when a member model is set, so a flag on one line alone leaves the
# other path loading the operator's context. The flag must stand as a whole option on the line itself (a
# trailing comment is ignored, `--safe-modeX` does not count); a flag on a continuation line is not seen
# (treated as stale). One awk pass, so the answer does not depend on `set -o pipefail` in the caller.
if [[ -f "${LOCAL_CLAUDE_RUNNER}" ]] && ! { grep -q -- "${RESEARCH_TEAM_CLAUDE_RUNNER_MARKER}" "${LOCAL_CLAUDE_RUNNER}" \
    && awk '/^[ \t]*claude --print/ { n++; line = $0; sub(/[ \t]+#.*/, "", line)
              if (line !~ /(^|[ \t])--safe-mode([ \t]|\\|$)/) bad = 1 }
            END { exit !(n > 0 && !bad) }' "${LOCAL_CLAUDE_RUNNER}"; }; then
  STALE_LOCAL_CLAUDE_RUNNER="${LOCAL_CLAUDE_RUNNER}"
  _shared_claude_runner="${SKILLS_DIR}/claude-cli-runner/scripts/run_claude.sh"
  if [[ -f "${_shared_claude_runner}" ]]; then
    LOCAL_CLAUDE_RUNNER="${_shared_claude_runner}"
  fi
fi

# Args: whether member A / member B use the Claude runner through the project copy (1/0), and
# whether an API endpoint/key option is set for it (the shared runner rejects --api-base-url /
# --api-key-env, only the project copy accepts them).
research_team_check_local_claude_runner() {
  local a_uses="$1" b_uses="$2" api_set="$3"
  [[ -n "${STALE_LOCAL_CLAUDE_RUNNER}" ]] || return 0
  [[ "${a_uses}" == 1 || "${b_uses}" == 1 ]] || return 0
  local refresh="cp '${SKILLS_DIR}/research-team/assets/run_claude.sh' '${STALE_LOCAL_CLAUDE_RUNNER}'"
  if [[ "${api_set}" == 1 ]]; then
    echo "[error] ${STALE_LOCAL_CLAUDE_RUNNER} predates the operator-context exclusion and an API endpoint/key option is set for a Claude member, which the shared claude-cli-runner does not accept; refresh the copy first: ${refresh}" >&2
    return 2
  fi
  if [[ "${LOCAL_CLAUDE_RUNNER}" == "${STALE_LOCAL_CLAUDE_RUNNER}" ]]; then
    echo "[error] ${STALE_LOCAL_CLAUDE_RUNNER} predates the operator-context exclusion and the shared claude-cli-runner is not available; refresh the copy: ${refresh}" >&2
    return 2
  fi
  echo "[warn] ${STALE_LOCAL_CLAUDE_RUNNER} predates the operator-context exclusion (it would load your CLAUDE.md, AGENTS.md and auto memory into reviewer lanes); using ${LOCAL_CLAUDE_RUNNER} for this run. Refresh it: ${refresh}" >&2
}
