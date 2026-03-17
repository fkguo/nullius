# research-team skill

Milestone-based research workflow for theory + computation projects with
reproducible artifacts, independent LLM cross-checks (default: Member A + Member B),
and a strict convergence gate. Optional sidecar reviewers can be added as a small
reviewer swarm.

## Quick start

This skill is designed to be driven by a tool-using LLM agent. The commands below
are what the agent runs; you can also run them manually for reproducibility and
debugging.

1) Scaffold a project:

```bash
bash ~/.codex/skills/research-team/scripts/bin/scaffold_research_workflow.sh \
  --root /path/to/project \
  --project "My Project" \
  --full
```

If the project will actually use the HEP provider bundle, add `--with-hep-provider`; otherwise the default full scaffold stays host-local and does not precreate `.hep/` or enable the HEP workspace gate.

2) Keep derivations in `research_notebook.md`, then refresh / maintain the machine-facing `research_contract.md`.

3) Run a team cycle (preflight + reviewers):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

Note: the scaffolded `research_team_config.json` defaults to `review_access_mode=full_access` (reviewers request file reads/commands/network via a proxy with evidence logs). To force offline/packet-only review, set `review_access_mode=packet_only`.
Optional: configure non-blocking sidecar reviewers via `sidecar_review` (single) or `sidecar_reviews` (list) in `research_team_config.json`.

## Requirements

- bash, python3
- julia (recommended)
- rg (optional)
- claude CLI and gemini CLI (optional, only for live multi-review runs)

## Docs

See:
- `SKILL.md` for the full workflow, gates, and templates.
- `references/usage_guide.md` for the full usage manual (English).
- `references/usage_guide.zh.md` for the Chinese usage manual (human-oriented).
- `RUNBOOK.md` for gate failure diagnosis + rerun commands.
- `FULL_VALIDATION_CONTRACT.md` for the validation definition and acceptance criteria.
- `ROADMAP.md` for the skill development roadmap.
- `references/kb_index.md` for the KB index exporter (English).

## Maintainers

- Self-audit entrypoint (creates a local `skilldev/` workspace and runs preflight-only by default): `bash scripts/dev/run_skilldev_self_audit.sh`
- Exploration debt dashboard (for projects that used `project_stage=exploration`): `python3 scripts/bin/exploration_debt_dashboard.py summary --team-dir team`
- Realism regression (run preflight-only on registered real projects, snapshot-by-default): `bash scripts/dev/run_real_project_regression.sh`

## Repository layout

- `scripts/bin/`: entrypoints and orchestrators
- `scripts/gates/`: deterministic gate scripts
- `scripts/lib/`: shared helpers used by scripts
- `scripts/scaffold/`: project scaffold helpers
- `scripts/dev/`: smoke tests and developer utilities
- `scripts/validation/`: deterministic full-contract harness
- `assets/`: templates copied into projects
- `references/`: supporting docs
