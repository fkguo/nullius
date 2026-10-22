Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Human-notebook closeout

In both file and engine mode, structural notebook links and current full-text
content review are separate requirements. After rewriting the scientific account
and refreshing its automatic block, execute `nullius notebook review --model claude/opus`
with repeated `--dependency <project-relative-path>` for required supporting files.
It runs a real reviewer through the existing review-swarm launcher in bounded calls, with a
default hard 1200-second timeout and no automatic reviewer retry. `--timeout-secs <N>`
sets a different hard limit. Freeze the complete UTF-8 notebook, including the
automatic block, and declared dependency SHA-256 from actual bytes, including
uncommitted edits; commit and section stamps do not bind those edits.

Before notebook closeout, require source-anchored reasons on derivation
completeness, logical consistency, symbols, definitions, assumptions and
conventions, and recorded full-text coverage of every section. The reviewer gets
the materials and question without an expected verdict or the author's initial
judgment. Links, automatic tables, formula counts, checked boxes and writing
self-assessment are not content acceptance. `nullius notebook check` reports
`structure` and `content_review` separately and requires both structural success
and an accepted current review. `--result` narrows links only; `--structure-only`
success establishes navigation alone. Missing, partial, failed, unavailable,
invalid or stale review does not pass. Changed bytes require a new review;
historical reports remain readable, and status/current only read them.

This is supporting semantic evidence using existing verification
subject/check-run/verdict/coverage and `ArtifactRef`, never decisive computation
validation. Semantic acceptance does not prove scientific truth. Record a single
reviewer's limits on model, method and input independence and retain the applicable
claim-specific checks. The M1–M7 self-check remains a separate discipline and
cannot author its own notebook content-review verdict.

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
