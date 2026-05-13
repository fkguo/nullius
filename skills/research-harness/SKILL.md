---
name: research-harness
description: Use when working inside an external research project that has or may need autoresearch state, research_plan.md, research_contract.md, artifacts/runs, team/runs, Codex/Claude Code continuation, recovery, verification, approval, export, or handoff.
---

# Research Harness

Use this skill as the thin project-harness entrypoint for Codex, Claude Code, or OpenCode inside a real external research project.

It does not replace the research executors. It restores the project state, routes work to the right surface, and makes sure durable conclusions land back in the project contract and run artifacts.

## Authority Map

- `autoresearch`: generic TS CLI and project lifecycle control plane.
- `research-team`: milestone execution and multi-agent research progress.
- `hep-mcp`: HEP literature, evidence, INSPIRE/arXiv, bibliography, and export tooling.
- `hepar` / `hep-autoresearch`: retired public shell. Never use it as the control plane or fallback.

## Recovery First

Work from the external project root, not from the `autoresearch-lab` development repo.

1. Prefer the project-local CLI when it exists:
   ```bash
   ./.autoresearch/bin/autoresearch status --json
   ```
2. Otherwise use the installed CLI:
   ```bash
   autoresearch status --json
   ```
3. Read and align the durable project surfaces:
   - `research_plan.md`, especially `# Current Status`
   - `research_contract.md`
   - `research_notebook.md` when it contains substantive project notes
   - the relevant `artifacts/runs/<run_id>/` and `team/runs/` directories

If no project state exists and the user is in a real external research root, initialize with:

```bash
autoresearch init
```

## Route The Work

- If the research question is still not scoped, create a plan with:
  ```bash
  autoresearch workflow-plan --recipe research_brainstorm
  ```
- If the user needs milestone execution, invoke `research-team` and keep the milestone boundary explicit.
- If the task needs HEP literature, evidence, INSPIRE/arXiv, source reading, bibliography, or export support, use `hep-mcp`.
- If the task is lifecycle, verification, approval, pause/resume, final conclusions, or export, keep it on `autoresearch`.

Do not invent compatibility commands or call retired `hepar` / `hep-autoresearch` public entrypoints. If a user asks for them, say they are retired and route to `autoresearch` plus the relevant skill/tool layer.

## Fold Results Back

`research-team` output is not complete while it only lives in `team/runs`.

After a milestone or run produces a stable result:

- Summarize the durable conclusion in `research_contract.md`.
- Update `research_plan.md#Current Status` with the current state, next step, blockers, and evidence pointers.
- Link or copy the relevant run evidence under `artifacts/runs/<run_id>/`.
- Preserve unresolved questions as explicit blockers rather than burying them in chat or transient team logs.

## Closeout

Before handing off or claiming completion, run the narrowest applicable closeout command:

```bash
autoresearch verify
autoresearch final-conclusions
autoresearch approve <approval_id>
autoresearch export --run-id <run_id>
```

Use the command that matches the project state. If approval is pending, stop at the approval boundary and report the exact approval id and evidence path.
