# Acceptance matrix — <APP>

Version: TODO · Dataset hash: TODO
Built from `docs/00-data-atlas.md` (traps) and `docs/01-product-ux.md` (flows).

## Real-data examples

Every flow has at least one record that exists in the dataset, an expected rendering and
an expected copy/read text.

| # | Flow | Real key | Expected display | Expected copy | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | TODO | TODO | TODO | TODO | TODO |
| 2 | TODO | TODO | TODO | TODO | TODO |
| 3 | TODO | TODO | TODO | TODO | TODO |

## Traps

Each trap from the atlas, with a real example and what a wrong implementation would show.

| Trap | Example key | Expected | A wrong build would show |
| --- | --- | --- | --- |
| TODO | TODO | TODO | TODO |
| TODO | TODO | TODO | TODO |
| TODO | TODO | TODO | TODO |

## Failure states

| State | How to provoke | Expected rendering | Recovery |
| --- | --- | --- | --- |
| missing record | TODO | TODO | TODO |
| corrupt dataset | TODO | TODO | TODO |
| offline | TODO | TODO | TODO |
| stale version | TODO | TODO | TODO |
| partial dataset | TODO | TODO | TODO |

## Exhaustive sweeps

A sample is not a sweep. Each row runs over the whole dataset and expects zero
mismatches unless stated.

| What is swept | Command | Expected mismatches | Last result |
| --- | --- | --- | --- |
| display formatting | TODO | 0 | TODO |
| identity resolution | TODO | 0 | TODO |
| TODO | TODO | TODO | TODO |

## Synthetic

Items that are not real data are labelled in the UI/test and never counted as coverage.

| Item | Why synthetic | Label |
| --- | --- | --- |
| TODO | TODO | `synthetic_...` |

## Not covered

TODO: list what this matrix does not test (performance, accessibility, platforms, ...).
