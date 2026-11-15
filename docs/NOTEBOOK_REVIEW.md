# Notebook content review

The whole current notebook is always reviewed, including code, comments and automatic blocks. Content acceptance is supporting semantic evidence about definitions, assumptions, notation, derivations and consistency. It does not replace numerical, literature or derivation validation.

## Declared evidence

Use `nullius notebook review --model <spec> --evidence-manifest <project-relative-path>` when the scientific evidence should be reviewed without recursively importing every historical log and array. The manifest is strict JSON:

```json
{"schema_version":1,"sources":["notes/assumptions.md","implementation/model.py"]}
```

The notebook is mandatory even when absent from this list. Repeated `--dependency` arguments add primary sources. Freeze the manifest and every declared original by its actual bytes and hash. Paths must stay inside the project and cannot traverse symlinks. A missing declared file prevents intake; binary originals remain unread opaque sources. Renaming text does not make it binary.

Outgoing Markdown references from the notebook and primary text are inventoried with original source spans, resolution status and safe file identities. They are not recursively promoted to evidence. Other text remains explicitly **unread provenance**, never read evidence. Directory and remote references do not supply their contents. Nothing fetches outside the project or invents a file for notation that resembles a link.

Every byte of every primary text must receive a complete source review. Several exact intervals can share a request when its measured byte and token budgets permit. Their original bodies, coverage and canonical execution receipts remain distinct. Partial packs, stale inputs, tampering, missing receipts, unsupported runtime evidence and compaction cannot be credited.

The final integration receives the **complete original notebook**, verified canonical source-review evidence and byte-checked original excerpts selected for cross-section reasoning. It must cover every notebook section with its hash, substantive body anchors and reasons, integrate every primary interval, and independently re-adjudicate every reference, including earlier exclusions. It must request additional originals or context whenever this evidence is insufficient. Dependency anchors must occur in the excerpts actually transmitted to this final reviewer.

Reference assessments may explicitly group IDs that share one necessity judgment and substantive reason. Every ID must still occur exactly once; omitted, duplicate, unknown, wildcard or implicit-default membership is rejected.

A source identified as necessary at either stage must be a completely read declared original. Necessary unread, missing, opaque or out-of-scope material prevents acceptance. Nonempty additional-context requests also prevent acceptance. The manifest author cannot supply a PASS or decide necessity on behalf of the reviewers. Hashes, catalogues and summaries alone do not establish that original text was read.

Both profiles freeze the ledger validity states of runs supplying their actual primary material. A relevant state change makes prior acceptance stale and prevents receipt reuse; unrelated ledger events do not. Reviews without this binding remain readable history and require a fresh review.

Changing the notebook, a declared primary original, the manifest or the references written in those originals makes the review stale. Unread locator descriptors are immutable as-of-review observations, not assertions that their targets still have those contents. Later unread target changes do not claim new reading or change the accepted primary-material scope; any target needed for reasoning must instead be declared and fully read. A complete frozen declared scope can resume with valid fresh source receipts and its original reference observations; the final integration is executed again. Interrupted declared intake without a complete scope requires a fresh review. Historical recursive records retain their original requirements.

This method does not prove that every implicit or unlinked source was discovered. Preserve the reviewers' necessity judgments, source limits and model/method/input independence. It does not assert that all historical computations, source code, figures or literature were revalidated.

## Recursive evidence

Without `--evidence-manifest`, existing recursive intake and complete-original joint audit remain unchanged. Every linked UTF-8 source is frozen recursively, and the final request contains all those original texts together. Unmarked directory links leave that closure pending. An explicit `"nullius-navigation"` link title marks navigation: its local destination must exist but is neither frozen nor recursively followed unless also supplied as evidence. More earlier batches or larger storage limits cannot make this final request fit a smaller backend window.

## Execution and acceptance

Storage limits (`--snapshot-bytes`, `--max-files`), request limits (`--context-bytes`, `--context-tokens`) and execution limits (`--timeout-secs`, `--max-batches`) are separate. A configured token budget is not proof of backend capacity. Retain actual runtime and token-use evidence; an oversized or incomplete request stays unavailable. Do not truncate originals or silently omit evidence to fit.

Both profiles use real `review-swarm` execution in tool mode `none`; native/manual reports cannot be imported as completed CLI seats. Missing, partial, rejected, unavailable or stale review never becomes accepted by changing its label. `nullius notebook check --json` remains the final unscoped structure/content check. A content review's recorded scope must distinguish the two profiles.
