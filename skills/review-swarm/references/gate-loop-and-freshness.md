Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### Re-review after every fix (gate-loop discipline)

Convergence is a property of the **reviewers' agreement on the current artifact**, never a
self-pronouncement after applying a fix. The gate loop is review → fix → **re-run the independent
reviewers on the fixed artifact** → repeat, and it converges only when the reviewers themselves return
clean. Re-review after **every** correction round, including ones that look trivial or single-line: a fix
can introduce a **new** defect — a corrected transcription line that silently drops a magnitude factor, or
a refactor that re-breaks an invariant — that exists only after the fix and is caught only by the next
independent round. Skipping the confirmation round because the change "obviously" closed the finding is the
failure mode this rule exists to stop. The leader integrates and decides, but does **not** declare
convergence in place of the reviewers.

**"Clean" is defined by severity, and the loop has a stop condition.** Reviewers grade every finding
on a shared three-level scale:

- **BLOCKING** — changes a result, claim, or contract; violates input identity, target-value
  isolation, or origin traceability; turns a silent failure into an apparent success; or is a
  quantitative discrepancy of the reference-reproduction kind (the [reference-reproduction order-of-magnitude/sign-reversal
  rule](result-and-artifact-roles.md) is the exemplar). BLOCKING findings must be fixed and re-reviewed.
- **HIGH** — a correctness risk inside the declared scope that does not change current results
  (e.g. a declared failure mode with no regression test). Fix before the artifact's acceptance
  point; a batch of HIGH fixes takes one confirmation round together, and does not restart the
  full independent panel unless production logic changed.
- **LOW** — hardening beyond the declared scope, mutation-style test strengthening, style. Never
  blocks by itself; each LOW finding gets an explicit disposition (fix now / attach to a named
  acceptance point / discard with a stated reason) — dispositioned, not silently dropped.

Convergence = zero BLOCKING findings on the current artifact, every HIGH fixed or scheduled at its
named acceptance point, and every LOW dispositioned. When another workflow's severity scheme also
applies to the same artifact (e.g. a member-cycle blocking/non-blocking grading), the stricter
classification governs: an in-scope correctness risk that is HIGH here never demotes to a
deferrable non-blocking finding there — it blocks the artifact's acceptance point either way. A round that produces only LOW findings is a
converging round, not grounds for another full cycle. Once an artifact has passed a full review pair,
later findings re-open it only if they meet the BLOCKING bar — "keep reviewing until no reviewer can
imagine a stronger test" is an unbounded loop, not a standard. A later non-BLOCKING finding still
receives the standard disposition (fix now / attach to a named acceptance point / discard with a
stated reason): not re-opening the artifact is not discarding the finding.

The loop is also **bounded**: cap review rounds per artifact (default 5, counting every round that
reviewed a candidate of this artifact). Hitting the cap is not a license for one more round — it
forces the narrowing rule: narrow the artifact's scope, reduce the claim's strength, or take the
blocking question to the project owner. The mandatory confirmation round after an applied fix batch
is unaffected — the cap bounds how many candidate revisions the loop may consume, not whether a
revision gets its confirmation. Batch fixes: one confirmation round
covers the whole accumulated fix batch, scoped to the exact delta by default (see [packet composition](review-one-flags.md)). Review verdicts are judged on content: a source-grounded READY whose verdict string or label
spelling deviates from the requested format is a normalization task, never a new blocking round —
a same-model rerun re-emits it in contract shape (the [delivery disposition rule](delivery-and-runtime-evidence.md)).
Leader transcription is NOT a convergence path: an output the reviewer did not re-deliver in
contract shape stays out of the count no matter how unambiguous its verdict reads — archive the
original for diagnosis and rerun the seat. An ambiguous verdict is never normalized into a pass;
it fails closed as usual.

The verdict is scoped to the exact hashes in `inputs/review_input_manifest.json`.
Before counting an older run toward a later convergence or closeout, rerun the
freshness check:

```bash
python3 <nullius-root>/skills/review-swarm/scripts/bin/verify_review_freshness.py \
  --review-dir /path/to/review-out
```

Require `status: FRESH`. A target, source, correction record, context, system prompt,
packet, or diff mismatch is `STALE`, even if the edit is one character and the prior
model output says READY. Re-review the full current artifact or the complete exact delta
from the reviewed hash. Running the checker once does not authorize later edits; any
post-check mutation invalidates the acceptance state.

The standalone checker returns `0` for `FRESH`, `3` for `STALE`, and `2` for an invalid
or unreadable manifest. The `review_one.py` entry instead returns `86` when its model run
succeeded but acceptance is `STALE` or `UNVERIFIABLE`, so it remains distinguishable from
the delegated model result. Automation should treat the JSON `status` as authoritative
rather than assuming both entry points share one numeric convention.

The manifest is a trusted launch record, not a cryptographic signature over itself.
This gate catches accidental or uncoordinated post-review drift. If deliberate co-editing
of both an input and its manifest is in scope, commit the review directory or persist the
reported manifest SHA-256 in an external closeout record before accepting the verdict.
