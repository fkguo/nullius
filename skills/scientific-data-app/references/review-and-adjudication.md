# Review and adjudication

The review protocol exists because dataset apps fail in ways that ordinary code review
does not catch: a rule that is internally consistent but jointly wrong with its fixture,
a display path that silently changes magnitude, a "done" claim that was never executed.
The protocol below was used on the reference build across design, implementation,
security and platform reviews.

Execution is delegated: use `review-swarm` for seats, identity and freshness, and
`research-integrity` before folding a claim into a durable document. This reference
defines what the *app-specific* artifacts and dispositions must contain.

## Two seats, different questions

| Seat | Question | Typical findings |
| --- | --- | --- |
| Spec fidelity | Does the implementation match the frozen contract and rules, byte-for-byte where applicable? | wrong status semantics, missing provenance, a rule branch that reads the wrong column |
| Implementation quality | Is the code correct, robust, and adequately tested beyond the happy path? | leaked handles, swallowed errors, quadratic parsing, missing negative tests |

Run both against the same frozen commit. Do not let one seat see the other's report: two
independent failures are more informative than one consensus.

For design reviews (before code), run **criteria first**: the reviewer writes the
acceptance criteria while the candidate is invisible, then applies them. This catches
"the design answers a different question" and prevents the reviewer from inheriting the
author's framing.

## Prompt hygiene

- Give the artifact and a neutral question ("review this against the criteria"), not the
  author's verdict.
- Freeze the inputs: commit hash, document hash, fixture hash. A verdict applies only to
  those bytes.
- Record what the reviewer could execute and what it could only read.
- Never tell a reviewer that another reviewer approved.

## Findings

Every finding has: `ID`, severity, location (file:line or document section), the claim,
the evidence, and a suggested fix.

| Severity | Meaning |
| --- | --- |
| BLOCKING | wrong or lost data, or the artifact cannot ship |
| HIGH | contract/semantic violation, or a user-visible wrong value |
| MEDIUM | robustness, coverage or provenance gap |
| LOW | wording, structure, non-behavioural |

A finding without a location or evidence is a preference, not a finding.

## Dispositions

| Disposition | Requirement |
| --- | --- |
| ACCEPT | fix and re-review the diff |
| PARTIAL | say which part is accepted and which is not |
| REJECT | give a reason grounded in the data or the contract; "I disagree" is not a reason |
| DEFERRED | name the acceptance point where it will be closed; a deferral without a point is a rejection in disguise |

Partial acceptance is normal and healthy. In the reference build the author rejected one
reviewer's "must fit in one iteration" assumption while accepting every substantive
finding — and recorded both.

## Re-review the fix diff

A closed finding is not a fixed finding. Fixes create new failures:

- A guard fix for rejected statements introduced a new escape path for a comment line.
- A display fix for power suppression created a percent-marker regression on ~550 rows.

Re-review the diff that closes the finding, re-run the full matrix (not only the new
test), and give regressions new IDs. The closing comment states what was re-run.

## Convergence

- Bar: zero BLOCKING, every HIGH closed or deferred by name, every LOW dispositioned.
- Default maximum: five candidate rounds. Beyond that, narrow the scope or escalate —
  more rounds usually mean the artifact is under-specified, not that reviewers disagree.
- Record the stop reason and what was **not** reviewed. "No BLOCKING/HIGH" does not mean
  "the whole document was read by everyone".
- Match depth to risk: data semantics > UI behaviour > copy. Twelve review documents for
  one search feature is a warning sign, not a badge.

## Honest degradation

- Same model family, different routes or aliases: one family, not two.
- An unavailable seat is recorded as unavailable; it does not become a pass.
- A malformed or truncated delivery is unfinished delivery, not a weak vote.
- A verdict on stale bytes is void; re-freeze and re-run.
- The lead cannot transcribe a reviewer's silence into agreement.

## Record fields

Use [assets/templates/docs/05-review-record.md](../assets/templates/docs/05-review-record.md).
At minimum: scope, criteria, what was executed (commands and environment), findings with
IDs, dispositions, fix-diff re-review, unverified items with runnable steps, convergence
statement, honesty grades.

## Anti-patterns

| Anti-pattern | Why it fails |
| --- | --- |
| the author's tests presented as independent verification | the test encodes the same misunderstanding as the code |
| static review presented as runtime proof | it cannot see startup, rendering, permissions or performance |
| same-family reviewers counted as a quorum | correlated errors, not independent evidence |
| "all resolved" without re-running the matrix | fixes regress |
| reviewing to agreement | convergence is about evidence, not consensus |
| review records without dispositions | findings disappear silently |
| one giant review of everything | no seat has the context to judge data semantics and UI at once |
