# prompts/README.md

This folder contains prompt files used by the `research-team` workflow.

Note:
- Files prefixed with `_` are scaffolded defaults used by scripts.
- Customize them per project (they are meant to be edited).

Team cycle (theory+computation cross-check):
- `_team_packet.txt`: optional packet template (if you build packets manually)
- `_system_member_a.txt`: Member A system prompt (default host-native subagent; provider CLI override supported)
- `_system_member_b.txt`: Member B system prompt (default host-native subagent; provider CLI override supported)
- `_system_member_c_numerics.txt`: optional numerics sidecar (non-blocking)

Scientific notebook closeout:
- Member packets may contain short excerpts or deltas for selected-claim review;
  their verdicts do not establish whole-notebook acceptance.
- In file and engine mode, execute `nullius notebook review --model claude/opus` with
  required supporting files declared by repeated `--dependency`, then run
  unscoped `nullius notebook check --json`. It requires structural navigation and an accepted
  full-text review bound to SHA-256 of the current complete UTF-8 notebook
  (automatic block and uncommitted edits included) and necessary dependencies.
- The report needs every section covered with source-anchored reasoning on
  derivations, logic, notation, definitions, assumptions and conventions. Missing,
  partial, failed, unavailable, invalid or stale review does not pass; changed
  bytes require a new review while old reports remain readable.
- `--result` narrows only links; `--structure-only` establishes navigation alone.
  Links, formula counts, tables, checklists and writer self-assessment cannot
  supply a content verdict. Semantic acceptance is not scientific proof or
  decisive computation validation; retain the applicable claim-specific checks.
- Scaffolding preserves existing prompt copies. Merge updated guidance explicitly
  into project customizations; updating a skill does not update those files.

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

Draft cycle (LaTeX-source-first):
- `_system_draft_member_a.txt`: correctness audit (derivations/methods/results consistency)
- `_system_draft_member_b.txt`: literature positioning + substance-first writing audit
- `_system_draft_member_c_leader.txt`: team-leader style audit (equation-by-equation physics/math recomputation; strict correctness-blocking)
  - Evidence gate (anti-hallucination): any concrete claim about data provenance/sampling/uncertainties/weighting must be backed by an explicit packet anchor; otherwise treat as a blocking evidence gap and request the minimal missing excerpt.
