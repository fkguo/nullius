# Notebook content review: material, storage and budget

In the default recursive profile: Valid UTF-8 text remains text regardless of size; ordinary Markdown evidence links are discovered
recursively; explicit `"nullius-navigation"` link titles declare navigation only. Binary or invalid UTF-8 linked files are immutable `opaque_links`
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

In that recursive profile, larger materials use original UTF-8 intervals with adjacent original context,
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

With `--evidence-manifest <project-relative JSON>`, declared evidence uses a different material organization: the complete notebook and every declared primary text original are read, reference candidates remain explicit unread provenance until adjudicated, and the final integration receives the complete notebook plus canonical source-review evidence and byte-checked original excerpts. Every notebook section and primary interval must be covered. Every discovered reference is re-adjudicated; a necessary unread source or additional-context request prevents acceptance. This profile never claims the entire recursive history was read. Real tool-mode-none execution, capacity evidence, freshness and immutable history requirements still apply.

In declared evidence, unread locator descriptors are frozen observations, not current-content validation. Later unread target changes do not alter what the reviewer read. Currentness remains bound to the manifest, every declared original (including opaque inputs), and the exact references written in primary text. Necessary sources must be declared and completely read; optional observations can never satisfy that condition. Resume retains the verified as-of inventory, rather than claiming new locator contents were read.
