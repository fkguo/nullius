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
- Keep `research_notebook.md` organized by the problem's logic. Do not append large dated run logs there; put run logs in `research_plan.md` progress entries or `artifacts/runs/<TAG>/`, then fold durable insights into the relevant notebook sections.

## Scientific writing discipline

- In project notes, notebooks, plans, and conclusions, use the field's native scientific language rather than engineering, product, or delivery metaphors.
- Do not describe scientific reasoning as `pinning down`, `closing the loop`, `bridging`, `building a pipeline`, `opening a surface`, `running a lane`, shipping, delivery, roadmap execution, or similar software-project metaphors.
- Use those words only when they name a literal domain concept or when the subject is actual code, tooling, automation, environments, repository operations, control systems, or other software-maintenance work.
- Prefer precise scientific verbs such as derive, estimate, bound, test, compare, constrain, check, identify assumptions, separate regimes, quantify uncertainty, and relate observables.

## Literature reading depth

- Treat abstracts as triage only. Do not use an abstract-only reading as decisive evidence for an important or directly related paper.
- For important or directly related papers, read the full text. If arXiv LaTeX source is available, prefer reading the source; otherwise use available local and permitted full-text access such as PDF, Zotero, Crossref, library, or browser tools.
- Record the access level for each core source in project notes or artifacts: `abstract_only`, `full_text_pdf`, `latex_source`, or `unavailable`.
- If full text cannot be obtained, record the missing source and ask the project owner to provide it before relying on the paper for a central claim.

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
- External references must use clickable stable links when available.

## Optional host layers

Some projects add extra host-local team or automation layers on top of this root.
Treat those as opt-in support layers, not the default front door.
If this project already has host-local support surfaces, follow the host's local instructions before using them.
If it does not, keep using the read order above and update `research_plan.md` directly.

## Minimal checkpoints

- `project_charter.md` declares the goal hierarchy and profile.
- `research_plan.md` has an actionable Task Board and Progress Log.
- `research_contract.md` stays in sync with `research_notebook.md`.
- `docs/ARTIFACT_CONTRACT.md` and `docs/EVAL_GATE_CONTRACT.md` remain the default safety contract for outputs and checks.
