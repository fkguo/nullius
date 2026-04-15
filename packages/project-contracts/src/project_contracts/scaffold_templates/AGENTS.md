# AGENTS.md

This file anchors the workflow for this research project.
Use it as the restart checklist before any new milestone, context switch, or long pause.

## Read order

1) [project_index.md](project_index.md)
2) [project_charter.md](project_charter.md)
3) [research_plan.md](research_plan.md)
4) [research_contract.md](research_contract.md)

## Quick rules

- Human notebook: `research_notebook.md`
- Machine contract: `research_contract.md`
- Evidence-first: every meaningful action writes auditable artifacts under `artifacts/runs/<TAG>/`.
- Approval gates A1–A5 stay active unless the project owner explicitly changes policy in `docs/APPROVAL_GATES.md`.
- Keep the task board in `research_plan.md` current enough that a new agent run can resume without relying on memory.

## Markdown and links

- Prefer Markdown links over bare URLs in project docs and agent notes.
- Use relative Markdown links for files inside the project so the scaffold remains portable across machines.
- Keep link labels semantic and stable; avoid dumping raw paths inline when a short label is clearer.
- When citing artifacts or outputs in Markdown, point to the canonical project-relative path or artifact URI instead of prose-only references.

## Restart trigger

When this project also has research-team host surfaces, run one deterministic preflight before the next team cycle:

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag \
  --preflight-only
```

If the project does not yet include `prompts/` or `team/`, use the same read order and update `research_plan.md` manually until the host layer is added.

## Minimal checkpoints

- `project_charter.md` declares the goal hierarchy and profile.
- `research_plan.md` has an actionable Task Board and Progress Log.
- `research_contract.md` stays in sync with `research_notebook.md`.
- `docs/ARTIFACT_CONTRACT.md` and `docs/EVAL_GATE_CONTRACT.md` remain the default safety contract for outputs and checks.
