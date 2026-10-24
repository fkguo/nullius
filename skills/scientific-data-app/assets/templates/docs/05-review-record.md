# Review record — <ARTIFACT> @ <HASH>

Reviewer: TODO · Date: TODO · Seat: spec-fidelity / implementation-quality
Inputs frozen at: TODO (commit, document hash, fixture hash)

## Scope

What was reviewed, what was deliberately excluded, and which documents were authoritative.
TODO.

## Criteria

The criteria the reviewer applied, written **before** the candidate was visible (for
design reviews). TODO: link to `criteria/*.md` or restate.

## Executed

Commands run, environment, and results. Mark each as `reproduced` or `source-read`.

| Check | Command | Result | Grade |
| --- | --- | --- | --- |
| TODO | TODO | TODO | reproduced / source-read |

## Findings

| ID | Severity | Location | Claim | Evidence | Suggested fix |
| --- | --- | --- | --- | --- | --- |
| F1 | BLOCKING / HIGH / MEDIUM / LOW | TODO | TODO | TODO | TODO |

## Dispositions

| ID | Disposition | Reason | Landed in |
| --- | --- | --- | --- |
| F1 | ACCEPT / PARTIAL / REJECT / DEFERRED | TODO | TODO |

A `DEFERRED` item names the acceptance point where it closes. A `REJECT` carries a
data-grounded reason.

## Fix-diff re-review

The diff that closes each finding was reviewed; regressions get new IDs.

| Finding | Fix commit | Re-review result | New findings |
| --- | --- | --- | --- |
| TODO | TODO | resolved / regressed | TODO |

## Unverified

Items nobody executed or independently checked, each with runnable steps.

| Item | Why unverified | How to verify |
| --- | --- | --- |
| TODO | TODO | TODO |

## Convergence

- BLOCKING: TODO (count)
- HIGH open: TODO
- LOW dispositioned: TODO
- Stop reason and what was **not** reviewed across all seats:
  TODO.

## Grades

| Grade | Count |
| --- | --- |
| reproduced | TODO |
| source-read | TODO |
| audit-line | TODO |
