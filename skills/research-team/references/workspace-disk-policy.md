# Research team: workspace disk policy

**Workspace disk policy**: `artifacts/runs/<tag>/research_team/workspaces/` contains per-member
project snapshots that the reviewer subprocess runs against. They can grow
large (full project tree × 2 members × N runs). They are **ephemeral scratch
space**, not durable artifacts — every piece of forensic data needed to audit
a run lives at the run_dir top level (`cycle_state.json`, `<tag>_member_*.md`,
`member_*_evidence.json`, `member_*_audit.jsonl`, `logs/member_*/`).

- `run_team_cycle.sh` deletes `workspaces/` automatically when the cycle
  completes successfully. Set `RESEARCH_TEAM_KEEP_WORKSPACES=1` to disable.
- On failure the workspaces are preserved by default for debugging. Set
  `RESEARCH_TEAM_KEEP_WORKSPACES_ON_FAILURE=0` to also clean up on failure.
- At the start of every new cycle, `run_team_cycle.sh` also sweeps orphaned
  workspaces from any earlier cycle whose `on_exit` trap could not fire
  (SIGKILL / OOM kill / power loss). The startup sweep only deletes workspaces
  of clean successful exits (status `completed|converged|early_stop|preflight_only`)
  and only when the workspace mtime is at least 30 minutes old. Set
  `RESEARCH_TEAM_KEEP_WORKSPACES_AT_STARTUP=1` to disable the sweep.
- To reclaim disk on existing projects whose old runs still carry workspaces,
  use the prune utility. Defaults are `--keep-last 0`, `--keep-failed` unset,
  and dry-run; pass `--apply` to actually delete and any combination of the
  flags below to widen what survives:
  ```bash
  # Dry-run preview of all eligible workspaces (deletes nothing).
  python3 "${SKILL_DIR}/scripts/bin/prune_team_workspaces.py" --root /path/to/project
  # Apply, preserving the 3 most-recent runs and any failed runs:
  python3 "${SKILL_DIR}/scripts/bin/prune_team_workspaces.py" --root /path/to/project \
    --keep-last 3 --keep-failed --apply
  ```
  The tool only touches `artifacts/runs/<tag>/research_team/workspaces/` subdirectories; all
  forensic data at the run_dir top level is preserved. Pass `--json` to emit
  a machine-readable plan plus, after `--apply`, a `result` envelope.
- For projects that run cycles in an unattended loop, either keep the
  `RESEARCH_TEAM_KEEP_WORKSPACES_ON_FAILURE=1` default and schedule a periodic
  `prune_team_workspaces.py --root <project> --keep-last N --keep-failed --apply`
  sweep (cron / launchd / scheduled task), or set
  `RESEARCH_TEAM_KEEP_WORKSPACES_ON_FAILURE=0` to clean up failures inline
  once the loop is known healthy.
