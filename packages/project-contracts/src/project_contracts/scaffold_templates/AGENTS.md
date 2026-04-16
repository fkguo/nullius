# AGENTS.md

This file anchors the workflow for this research project.
Use it as the restart checklist before any new milestone, context switch, or long pause.

## Read order

1) [project_index.md](project_index.md)
2) [AGENTS.md](AGENTS.md)
3) [project_charter.md](project_charter.md)
4) [research_plan.md](research_plan.md)
5) [research_contract.md](research_contract.md)
6) [research_notebook.md](research_notebook.md) (when it already contains substantive content)

## Quick rules

- Human notebook: `research_notebook.md`
- Machine contract: `research_contract.md`
- Evidence-first: every meaningful action writes auditable artifacts under `artifacts/runs/<TAG>/`.
- Approval gates A1–A5 stay active unless the project owner explicitly changes policy in `docs/APPROVAL_GATES.md`.
- Keep the task board in `research_plan.md` current enough that a new agent run can resume without relying on memory.

## Reconnect discipline

- On `new session`, `reconnect`, `interruption`, `context reset`, or `handoff`, if `.autoresearch/` exists, run `autoresearch status --json` before taking any new action.
- If `autoresearch` is unavailable on `PATH`, run `.autoresearch/bin/autoresearch status --json` instead.
- Treat that status output as the authoritative recovery briefing for the current run, recovery context, plan view, and bounded workflow outputs.
- After reading status, continue through the checked-in files in the order above, and read [research_notebook.md](research_notebook.md) only when it already contains substantive content.

## Markdown and links

- Prefer Markdown links over bare URLs in project docs and agent notes.
- Use relative Markdown links for files inside the project so the scaffold remains portable across machines.
- Keep link labels semantic and stable; avoid dumping raw paths inline when a short label is clearer.
- When citing artifacts or outputs in Markdown, point to the canonical project-relative path or artifact URI instead of prose-only references.
- Inline math must use `$...$`.
- Display math must use fenced `$$ ... $$`.
- Only inside multi-line display math blocks, do not start a continuation line with `+`, `-`, or `=`.
- Plain Markdown prose lines are not subject to the `+/-/=` rule above.
- `arXiv`, `INSPIRE`, and `DOI` references must use clickable links.

## Optional Host Preflight

Only when this project already includes research-team host surfaces and you are intentionally resuming that host-managed flow, run one deterministic preflight before the next team cycle:

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

If the project does not yet include `prompts/` or `team/`, skip this preflight and continue with the checked-in recovery flow above.

## Minimal checkpoints

- `project_charter.md` declares the goal hierarchy and profile.
- `research_plan.md` has an actionable Task Board and Progress Log.
- `research_contract.md` stays in sync with `research_notebook.md`.
- `docs/ARTIFACT_CONTRACT.md` and `docs/EVAL_GATE_CONTRACT.md` remain the default safety contract for outputs and checks.
