# 2026-04-08 Branch / Worktree Cleanup

This note records the repo-hygiene cleanup performed on `main` after the
generic-front-door / legacy-retirement convergence batch.

## Deleted merged branches

The following branches were already merged into `main` and were removed:

- `codex/m22-gatespec-research-team-convergence-first`
- `codex/new-r05-paper-identity-fail-closed-first`
- `codex/new-r05-shared-evidence-authority-convergence-first`
- `codex/new-r05-shared-evidence-authority-convergence-plan`
- `codex/new-r06-analysis-types-live-authority-convergence-first`
- `codex/perf-audit-workspace-build-fixes`
- `codex/validation-env`
- `lane/doctor-bridge-delete-first`
- `lane/run-card-wrapper-contraction`

## Deleted repo-side worktrees

The following repo-side lane worktrees were removed after confirming they were
clean and already merged:

- `doctor-bridge-delete`
- `run-card-lane`

## Retained items

The following items were intentionally retained:

- `lane/runtime-permission-profile-v1`
  - Still merged into `main`, but its bound worktree remains dirty, so it was
    not deleted in this pass.
- `lane/legacy-residue-audit`
- `codex/omx-closure-experiment`
- `codex/post-runtime-runtime-diagnostics-bridge-first`
- `lane/runtime-handle-v1`
  - These were not deleted because they are unmerged or otherwise still active.
- detached worktrees under temp / tool-managed directories
  - These were not deleted from `main` because ownership and liveness were not
    fully attributable from the coordinator thread alone.

## Safety rule used for this cleanup

Deletion only proceeded when all of the following were true:

- the branch was merged into `main`
- the worktree was clean or already absent
- no active uncommitted lane state needed to be preserved

Anything failing those checks stayed in place for a later explicit pass.
