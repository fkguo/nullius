# skilldev (local workspace)

This directory is a **local self-evolution workspace** for developing `research-team` using its own workflow.

- Default usage is via the maintainer entrypoint: `bash scripts/dev/run_skilldev_self_audit.sh`
- The workspace is **generated** (scaffold + demo milestone) and is ignored by the repo root `.gitignore`,
  except for this `README.md` and `skilldev/.gitignore`.
- Safe to delete. Rerun the entrypoint to recreate.

## Realism regression (optional)

If you have one or more real research projects, you can register them as local regression targets (snapshot-by-default)
to prevent the skill from drifting away from real workflows:

- Register a project (writes to `skilldev/regression/real_projects.json`, git-ignored):
  - `bash scripts/dev/register_real_project_regression.sh --name <NAME> --root /path/to/project`
- Run regressions:
  - `bash scripts/dev/run_real_project_regression.sh`
