# Notebook content acceptance

Command, script and asset paths in this reference are relative to the `research-team` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

- **Notebook split**: `research_notebook.md` is the human entry; `research_contract.md` is the machine-stable gate surface.
- **Memo discipline (mandatory)**: `research_notebook.md` is a self-contained research memo organized like a paper — connected prose with complete derivations, computations, and analysis — not a change log. Its quality bar: a colleague in the field could read it alone (no runs, no plan) and come away with the project's full current understanding, able to re-derive every load-bearing result. It updates by **rewriting the affected sections into a self-consistent whole**, never by appending stage fragments ("this milestone changed X"); dated progress belongs to `research_plan.md` and `artifacts/runs/<run_id>/`, revision history to git. A milestone does not converge while the memo still describes the pre-milestone understanding: rewriting the affected memo sections is part of the milestone's deliverable, checked in the convergence review like any other artifact.
- **Result-to-memo structure**: a declared headline result must link its registered artifact from a declared rewritten human `##` section. The fold gate reads `notebook.result_links` from `nullius current --json`; `Rewritten sections: none`, an automatic results table, comments, or code examples cannot satisfy this. Direct inline and explicit reference links are supported; use a direct artifact link even when a topic note gives extended detail. This is navigation only; retired historical records remain readable, and every current result participates in the final unscoped structural check.
- **Whole-notebook content review**: finish the notebook and refresh its automatic block, then execute `nullius notebook review --model claude/opus` with repeated `--dependency <project-relative-path>` for required supporting files. The existing review-swarm launcher executes bounded calls with a default hard 1200-second timeout (`--timeout-secs <N>` overrides it) and no automatic reviewer retry. Freeze SHA-256 of the complete UTF-8 notebook, automatic block included, and declared dependency bytes, including uncommitted edits. Commit and section stamps cannot replace byte identity. Require source-anchored reasons on derivation completeness, logic, notation, definitions, assumptions and conventions plus coverage of every section; neither an author assessment nor links, tables, formula counts or checklists supply a verdict. The reviewer receives the material and question without an expected verdict or the writer's initial judgment. A delta-only review cannot satisfy whole-notebook coverage.
- **Current content acceptance at fold**: require `notebook.content_review` to be accepted for the current full notebook and dependencies, identically in file and engine mode. `nullius notebook check --json` reports `structure` and `content_review` separately; `--result` scopes links alone, while `--structure-only` success cannot grant closeout. Missing, partial, failed, unavailable, invalid or stale review is not acceptance. Any changed input bytes require a new full-text review; old reports remain readable. This supporting semantic evidence reuses verification subject/check-run/verdict/coverage and `ArtifactRef`, not decisive computation validation. It does not prove scientific truth; record single-reviewer limits on model, method and input independence and retain all claim-specific checks.

Valid UTF-8 text remains text regardless of size; Markdown links are discovered
recursively. Binary or invalid UTF-8 linked files are immutable `opaque_links`
snapshots and hash locators, not read evidence. Every opaque path/hash needs a
specific `opaque_sources` assessment; a required unread source prevents acceptance.
Notebook and explicit dependencies require strict UTF-8 and LF or CRLF endings.

The complete material is frozen before review. Storage (`--snapshot-bytes`,
default 512 MiB; `--max-files`, default 256) is separate from each request's
`--context-bytes` and configured backend `--context-tokens` window (default
200,000 tokens, with instruction/output reserves). Default request bytes use a
conservative token upper bound. A larger explicit byte packet requires captured
backend token usage when that bound exceeds the window; missing capacity evidence,
observed backend compaction or delivery failure supplies no acceptance.

Larger materials use original UTF-8 intervals with adjacent original context,
followed by a joint audit receiving the COMPLETE original notebook and text
dependencies. All intervals and the joint audit must be complete and fresh;
selected quotations or summaries cannot replace this original input. The default
execution budget is 1200 seconds and 64 calls (`--timeout-secs`, `--max-batches`),
with one attempt per call and no automatic retry. Shortfalls expose total frozen
material, pending intervals and joint scope, the reason and a resumable command.
An unfinished intake reports discovered material and incomplete dependency
enumeration. `--resume <run-id>` creates a new run, revalidates original receipts
and material identity, retains explicit dependencies and storage budgets, and
never rewrites old evidence. If the full joint input does not fit the backend,
raise an available backend's request budget or leave the review incomplete.
Only tool mode `none` is accepted. Multiple batches are one semantic review;
they do not establish independent confirmations or a cross-family quorum.

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.
