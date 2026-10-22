# @nullius/literature-workflows

Checked-in literature-workflow recipes plus the provider/capability resolver consumed by `nullius workflow-plan`. Library-only — no CLI or MCP entrypoint of its own.

## Layer

Workflow authority. Holds the high-level workflow meaning that sits **above** provider packs. The `nullius` CLI resolves recipes here, persists `.nullius/state.json#/plan`, and derives `.nullius/plan.md` from the result. See root [README.md](../../README.md) §3 Layer Model.

## What lives here

- Recipe definitions for `literature_landscape`, `literature_gap_analysis`, `research_brainstorm`, etc.
- Provider profiles (which capabilities each provider — inspire, openalex, arxiv, zotero, crossref, datacite, github, doi — fulfills)
- A recipe loader and capability resolver that the orchestrator uses to plan and dispatch steps

## How it is consumed

```bash
nullius workflow-plan \
  --recipe literature_landscape \
  --project-root /absolute/path/to/external-project \
  --run-id 20260502T023000Z-m1-landscape-r1
```

The orchestrator imports `@nullius/literature-workflows` directly; users do not call this package.

Literature recipes carry a fail-closed saturation handoff. In addition to
provider pagination/cursor/continuation accounting that covers every declared query
and bounded citation expansion, the handoff
requires a disposition record for every candidate, direct-bibliography
reconciliation for every selected core source, canonical identity resolution bound
to exact-pinned provider metadata where possible with unresolved entries retained
as coverage debt, and a method-family audit grounded in source-local descriptions
plus one source-text screening disposition for every reconciled candidate. A workflow cannot
report `saturated` while any of those ledgers remains open; bounded stops remain
explicit `coverage_incomplete` debt.

## Build & test

```bash
pnpm -C packages/literature-workflows build
pnpm -C packages/literature-workflows test
```

## See also

- Root [README.md](../../README.md) §1 Surface Policy — stateful literature planning surface
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority

## Workflow evidence acceptance

At the end of the selected workflow, `nullius run` executes a bound evidence check.
`status: completed` describes execution; `workflow_acceptance.status` describes
evidence. Required nonpasses return `ok: false` and a nonzero exit code. Missing
files are incomplete, invalid evidence fails, unavailable checker dependencies
are unavailable, and changed bound materials make an earlier receipt stale.
The known recipe's protected contracts cannot be removed to bypass acceptance.

The check reuses the research-team literature saturation and note validators,
without config-disabled or exploration-stage skips. It requires a nonempty
query trace at `knowledge_base/methodology_traces/literature_queries.md`, the
recipe's saturation artifact, actual candidate-pool contents, expected provider
entries and pinned full-text reading coverage for every selected core paper.
The saturation JSON retains its existing saturation fields and adds:

```json
{
  "run_id": "<current run id>",
  "workflow_binding": {
    "workflow_id": "<current workflow id>",
    "plan_sha256": "<workflow_acceptance.identity.plan_sha256>",
    "outputs_sha256": "<workflow_acceptance.identity.outputs_sha256>"
  },
  "source_first_reading": {
    "notes": [{
      "paper_id": "<selected_core_ids entry>",
      "note_path": "knowledge_base/literature/paper.md",
      "source_path": "sources/paper.tex",
      "source_sha256": "<sha256 of the actual full-text file>"
    }]
  }
}
```

Paths are canonical project-relative regular files without symbolic links.
The candidate-pool artifact must be a JSON array or JSONL records matching the
inline candidate disposition ledger. Every selected paper needs a distinct note
with a `Paper ID: <stable canonical locator>` header matching its validated
canonical identity or alias, the existing strict reading fields and
a source form of `latex_source`, `full_text_pdf` or `available_full_text`; an
abstract or unavailable source cannot pass. Pinned nested provenance and
bibliography records are included among the exact files observed by the gate.

The first nonpassing run exposes the plan/output identity even when evidence
is missing. Prepare the evidence against those digests and repeat `nullius run`
for that completed plan: acceptance is rechecked without provider calls, and a
new immutable receipt preserves the earlier attempt. `nullius status --json`
checks current receipt/input/checker freshness without executing a checker.
Historical evidence remains readable; create current-run bindings separately
rather than rewriting old evidence or replacing custom project instructions.

A pass establishes mechanical evidence structure and source availability. It
does not establish that a source was understood, that its claims support a
conclusion, or that independent scientific review or A5 approval has passed.
