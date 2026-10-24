# Frozen rules — <LEVEL>

Version: TODO · Dataset hash: TODO · Owner: TODO
Related: `docs/02-interface-contract.md`, `docs/04-acceptance-matrix.md`

> Rules precede implementation. A parser/display branch may only implement a rule written
> here; anything not covered resolves to the opaque fallback.

## Layers

| Layer | Scope | Status | Fallback |
| --- | --- | --- | --- |
| L0 | lossless read of the source fields | TODO | must always work |
| L1 | rules frozen in this document | TODO | — |
| L2 | deferred class A | TODO | opaque text, counted |
| L3 | deferred class B | TODO | opaque text, counted |

## Rules

One subsection per rule. Every rule needs a real positive example and a real
counterexample.

### R1 — TODO: rule name

- **Input:** TODO
- **Output:** TODO
- **Example (real key):** TODO
- **Counterexample (real key):** TODO
- **Notes:** TODO

### R2 — TODO: rule name

- **Input:** TODO
- **Output:** TODO
- **Example:** TODO
- **Counterexample:** TODO

TODO: add rules until every L1 class is covered.

## Partition

Counts over the **whole** dataset, produced by explicit queries. The sum must equal the
number of records in scope.

| Class | Count | Command / query |
| --- | --- | --- |
| TODO | TODO | TODO |
| **Total** | **TODO** | — |

Sum check: TODO (the arithmetic and the command that verifies it).

## Fixture

- Path: TODO (`tool/...` or `test/fixtures/...`).
- Generator: TODO (must not import application code).
- Regeneration: TODO (exact command).
- Determinism: two consecutive runs are byte-identical; the committed fixture equals a
  fresh run.
- Schema pin: TODO (what the generator refuses to process).
- Coverage: TODO (what the fixture contains — partition, members, examples).

## Change control

1. A rule change edits this document.
2. Then the generator/fixture is regenerated and reviewed.
3. Then the implementation changes.
4. A rule change that produces no fixture change is investigated before merge.
5. An erratum ("the document was wrong, the data won") is recorded, not silently edited.

TODO: name the approver and the review record location.

## Fallback

Uncovered input is shown as opaque original text with a defined label, counted in the
partition, and never guessed. TODO: the exact label and where it appears.
