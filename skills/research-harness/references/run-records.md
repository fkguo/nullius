# Run Records: Freeze Identity Once, Append Results, Never Hash Lifecycle State

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

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
