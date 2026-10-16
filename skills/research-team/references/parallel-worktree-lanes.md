# Research team: parallel worktree lanes

## Parallel worktree lanes: judgment-point stops and merge authority

When independent workstreams run as separate git worktrees/branches driven by
separate agents (any host), four conventions keep the fan-out auditable,
mergeable, and affordable on disk; real multi-lane runs had to invent them ad
hoc (or paid for their absence), so they are recorded here as the standing
contract:

- **Stop only at judgment points.** A lane runs autonomously until it reaches a
  decision only the coordinator (or the human) can make, then stops and reports
  a machine-readable status — e.g. `merge_decision_needed`,
  `blocker_decision_needed`, `done` — with what it is waiting on and where its
  artifacts live. Lanes do not pause for routine progress confirmation, and
  they do not push past a blocker by guessing.
- **The coordinator is the only merge authority.** Worker lanes never merge to
  the main branch and never merge each other; they leave their branch at the
  judgment point. The coordinator reviews, decides, merges, and resolves
  cross-lane conflicts with the whole portfolio in view. This also keeps the
  independent-review boundary intact: a reviewer lane stays read-only.
- **Track liveness through the harness, not bare background jobs.** Long-running
  computations inside a lane use the `research-harness` checkpoint + heartbeat +
  deadline + resume machinery (see that skill), so a killed or hung lane is
  detectable and resumable. A small per-lane status file (lane id, status,
  waiting-on, artifact paths, last-heartbeat) in a gitignored scratch area is
  enough for the coordinator to poll; keep it out of the durable artifact tree.
- **Keep lane checkouts light, and close them after the merge.** A worktree
  re-checks out every tracked file, so in a project whose history holds bulk
  run outputs a lane that does not read them leaves them out with git's own
  sparse checkout, and materializes only the stowed outputs of the run
  directories it does read (see `research-harness`, Run Storage). After the
  coordinator merges a lane, it runs `run_storage.py worktree-check <lane path>`
  before removing it: `git worktree remove` silently deletes ignored files, so
  a lane is removed only when the check reports nothing that exists solely in
  that checkout. Idle merged lanes are not left behind.
