# Run Records: Freeze Identity Once, Append Results, Never Hash Lifecycle State

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

## When to create a run

Create one run for a coherent unit of scientific evidence, such as a production
calculation with its own inputs and results or a formal verification execution.
Group tests, retries and useful diagnostics for one unfinished candidate with
that work. Keep evidence that explains a failure or supports a claim. Give a
new production result that corrects or replaces a frozen result its own run.

For revisions to legends, axes, captions, layout or export format using the
same numerical evidence, reuse a local working output directory outside
`artifacts/runs/`, such as the project's ignored `tmp/`. Render and inspect the
revision there. Keep the selected figure or table in the project's figure or
manuscript directory. Link to existing data, the producing run when applicable,
and still-valid quantity verdicts by path and hash. Record the rendering code
revision, settings and final display checks alongside the retained output.
Keep the files required to reproduce or verify that display once. Leave
redundant exports, intermediate renderings and temporary QA crops in scratch.

Check the final display even when its numerical evidence is unchanged. A new
view or series drawn from verified values can reuse the verdicts that cover
those values. Changes to the underlying inputs, model or derived quantities
require checks at the affected level. Keep already cited or hash-bound figures
at their original paths and cite a separate figure revision when their bytes
must change. Figure revisions using the same result need no new run ID, origin
stamp or run supersession event.

## Run Records: Freeze Identity Once, Append Results, Never Hash Lifecycle State

A run record keeps three artifact classes separate, and only the first two ever carry hashes:

1. **Frozen identity** — the inputs, code, and contract the run was launched from. Hash these once, before execution; they never change afterwards by definition.
2. **Execution results** — outputs the run produced. Append their identities after execution (an append-only result record); a completed output is frozen at completion and may be hashed then.
3. **Lifecycle state** — status fields, summaries-in-progress, project registries, adjudication indexes: anything the workflow itself rewrites as the run advances toward acceptance. These are **never** part of any hash closure. Hashing a status-bearing file binds the record to a value that must change, so every lifecycle advance cascades into re-hashing and re-verifying files whose changes verify nothing — the record ends up maintaining itself instead of the research.

When a hash-bound artifact genuinely needs to change, the model is supersession, not in-place re-hash: freeze a new version, register it, and point the current pointer at it (exactly the main-report registry discipline). If a mutable file must appear in a review packet, embed an immutable content snapshot of it, so review freshness tracks the reviewed claim rather than unrelated bookkeeping writes.
## Runaway Protection Is Not a Performance Gate

Two different controls, deliberately kept apart:

- **Runaway protection** — a generous time/memory ceiling on any execution, existing solely to terminate a hung or memory-exploding process. It never demands single-thread execution, never blocks work for being unoptimized, and its trip is an incident to diagnose, not evidence to review.
- **Performance evidence** — benchmarks, allocation profiles, scaling measurements. These are demanded only when a speedup or regression **claim** is made (route it through the language's benchmark gate, e.g. `julia-perf`), or when entering production-scale batch computation whose cost matters. Recording and re-reviewing wall-clock, RSS, and swap figures on small bounded test executions is measurement theater: the numbers gate nothing, yet they get copied into receipts, summaries, and adjudications and re-read every round.

Corollary: performance work never blocks correctness work. A correct, stable computational kernel is the precondition for meaningful optimization — a performance target contracted before the kernel exists inverts that order and stalls the science behind a gate that cannot yet be evaluated.
