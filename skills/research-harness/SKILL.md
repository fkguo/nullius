---
name: research-harness
description: Use when working inside an external research project that has or may need autoresearch state, research_plan.md, research_contract.md, artifacts/runs, team/runs, Codex/Claude Code continuation, recovery, verification, approval, export, or handoff.
---

# Research Harness

Use this skill as the thin project-harness entrypoint for Codex, Claude Code, OpenCode, or other agents inside a real external research project.

It does not replace the research executors. It restores the project state, routes work to the right surface, and makes sure durable conclusions land back in the project contract and run artifacts.

## Authority Map

- `autoresearch`: generic TS CLI and project lifecycle control plane.
- `research-team`: milestone execution and multi-agent research progress.
- `markdown-hygiene`: standalone Markdown math, TOC, and formatting cleanup before research handoff.
- `hep-mcp`: HEP literature, evidence, INSPIRE/arXiv, bibliography, and export tooling.

## Recovery First

Work from the external project root, not from the `autoresearch-lab` development repo.

1. If `.autoresearch/HARNESS` exists, treat it as the machine-readable runtime handshake: a status receipt is required before new work, milestone execution, closeout, or handoff.
2. Prefer the project-local CLI when it exists:
   ```bash
   ./.autoresearch/bin/autoresearch status --json
   ```
3. Otherwise use the installed CLI:
   ```bash
   autoresearch status --json
   ```

A successful `status --json` call also refreshes the session-level anchor
marker at `.autoresearch/HARNESS_INVOCATION`. Every `*-mcp` dispatcher
(`arxiv-mcp`, `hep-mcp`, `hepdata-mcp`, `idea-mcp`, `openalex-mcp`,
`pdg-mcp`, `zotero-mcp`) verifies this marker for state-touching tool
calls and fails closed with `HARNESS_INVOCATION_REQUIRED` when the marker
is missing, malformed, or older than the most recent change to
`.autoresearch/state.json` or `.autoresearch/ledger.jsonl`. The check is
**event-driven, not clock-based**: once you anchor against current
project state, the anchor stays valid until project state actually
changes — long thinking / reading between tool calls does not invalidate
the anchor. Re-run `status --json` after any lifecycle event (own or
other-process `autoresearch run`/`approve`/`verify`/...) to re-anchor;
you do not need to invoke a separate "anchor" command.

The check is also skipped for:

- pure read-only provider queries (`arxiv_search`, `openalex_get`,
  `pdg_find_particle`, `inspire_resolve_citekey`, `hep_health`, etc.;
  full classification per dispatcher in each `*-mcp` package's
  `state-touch-classification.ts`);
- standalone use where `process.cwd()` has no `.autoresearch/`
  directory (no lifecycle context to drift from);
- `AUTORESEARCH_HARNESS_VERIFY=skip` env override (escape hatch) and
  `NODE_ENV=test` default.
4. If `.autoresearch/` exists but `.autoresearch/HARNESS` is missing, or if both entrypoints are unavailable, repair only the runtime handshake and launcher from the
   known development checkout, then retry the project-local CLI:
   ```bash
   node /Users/fkg/Coding/Agents/autoresearch-lab/packages/orchestrator/dist/cli.js init --runtime-only
   ./.autoresearch/bin/autoresearch status --json
   ```
5. Read and align the durable project surfaces:
   - `research_plan.md`, especially `# Current Status`
   - `research_contract.md`
   - `research_notebook.md` when it contains substantive project notes
   - the relevant `artifacts/runs/<run_id>/` and `team/runs/` directories

If no project state exists and the user is in a real external research root, initialize with:

```bash
autoresearch init
```

If `autoresearch` is unavailable on `PATH`, use the development checkout
entrypoint once to create the project-local fallback instead:

```bash
node /Users/fkg/Coding/Agents/autoresearch-lab/packages/orchestrator/dist/cli.js init --runtime-only
```

## Route The Work

- If the research question is still not scoped, create a plan with:
  ```bash
  autoresearch workflow-plan --recipe research_brainstorm
  ```
- If the user needs milestone execution, invoke `research-team` and keep the milestone boundary explicit.
- If the task is Markdown formatting, Markdown math escaping, generated TOC LaTeX cleanup, link/citation clickability, or pre-handoff note hygiene, invoke `markdown-hygiene` first, then rerun the relevant project gate.
- If the task is physics or adjacent scientific literature research, evidence, INSPIRE/arXiv/OpenAlex provider lookup, source reading, bibliography, or export support, use `hep-mcp`. Web search may supplement broad discovery, but it does not replace the provider citation graph gate below.
- If the task is lifecycle, verification, approval, pause/resume, final conclusions, or export, keep it on `autoresearch`.

Do not invent compatibility commands or fallback entrypoints. Keep lifecycle work on `autoresearch` and route executor or provider work to the relevant skill/tool layer.

## Literature Research Gate

For physics or adjacent scientific literature research routed through `hep-mcp`, citation graph checks are mandatory workflow steps, not optional keyword triggers.

Web search may be used first or in parallel to discover candidate papers, non-indexed materials, experimental pages, proceedings, code, or broader context. Before making literature-map claims, normalize core candidate papers to stable identifiers such as INSPIRE recid, arXiv id, DOI, or OpenAlex id and use `hep-mcp` provider tools for citation graph authority.

Minimum expectations:

- Treat `50` as a default page/initial-batch size, not a completion threshold. Literature work is complete only after a saturation artifact records provider coverage, candidate-pool rationale, and citation/reference graph checks.
- For each seed or core paper, check both directions when relevant: papers it references and papers citing it.
- For claims about paper relationships, source priority, review status, influence, or literature gaps, inspect the citation/reference graph with `hep-mcp` provider tools; do not rely only on search snippets or web pages.
- For writing-facing work, build or validate bibliography/citation artifacts through `hep-mcp` rather than hand-maintaining citekey authority from web search.

Useful `hep-mcp` routes include:

- Resolve identifiers first through the available provider route: INSPIRE recid, arXiv id, DOI, or OpenAlex id.
- INSPIRE citation/reference graph when covered: `inspire_literature(mode=get_references, recid=...)` and `inspire_literature(mode=get_citations, recid=..., sort=...)`.
- Cross-paper graph inside the provider layer: `inspire_find_connections` or `inspire_network_analysis`.
- arXiv/source checks: use arXiv/provider routes for preprints, versions, and source text when the task depends on the actual paper source.
- OpenAlex/cross-domain checks: use OpenAlex/provider routes when the paper is outside clean INSPIRE coverage or when broader cross-field citations may matter.
- Writing allowlist / citekey mapping: `hep_run_build_citation_mapping`.

If `hep-mcp` or a needed provider is unavailable, state that limitation explicitly and do not present the citation graph as complete.

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

Before invoking `autoresearch approve` for any A1-A5 gate (and before
folding a result into `research_contract.md` or
`research_plan.md#Current Status`), run the `research-integrity` skill's
M1-M7 pre-approval ritual. M1-M7 is the agent-side discipline that
catches hallucinated citations, hallucinated measurements, shortcut
graph claims, bugs-as-insights, methodology fabrication, and frame-lock
before they reach the durable record. The machine gates and the
`HARNESS_INVOCATION_REQUIRED` anchor remain authoritative; the
integrity check is owed to the next agent who reads your work.
