# Data atlas — <DATASET>

Version: TODO · Date: TODO · Owner: TODO
Source: TODO (URL, release date, byte size, hash algorithm and value, licence)

## Scope

What the dataset contains, what it is used for, and which parts this app reads.
TODO: one paragraph plus a boundary list (in scope / out of scope).

## Tables

One row per table or record type. Counts must be reproducible.

| Table | Rows | Primary key | Purpose | Shown where |
| --- | --- | --- | --- | --- |
| TODO | TODO | TODO | TODO | TODO |

## Identity

- What makes each object unique:
  TODO.
- What does **not** make it unique (list with real counterexamples):
  TODO: rows that share an identifier, generic names, isomers, listing vs entity rows.
- Key stability across dataset versions:
  TODO.

## Semantics

For every quantity the app displays: definition, unit, uncertainty convention, limit
convention, source column(s), and what the display rule must preserve.

| Quantity | Source columns | Unit | Uncertainty | Limit / sentinel | Display rule |
| --- | --- | --- | --- | --- | --- |
| TODO | TODO | TODO | TODO | TODO | TODO |

## Encodings

Flags, sentinels, empty string vs NULL vs zero, enums, text patterns.
TODO: table of encoding → meaning → handling. Include encodings that must stay opaque.

## Cross-source

Fill only when the dataset has more than one source.

| Quantity | Sources | Overlap | Known conflicts | Display policy |
| --- | --- | --- | --- | --- |
| TODO | TODO | TODO | TODO | TODO |

## What the data cannot provide

Specific, testable negatives. This section prevents invented features and invented values.

TODO: bullet list. Example form: "No absolute gamma intensity without an external
normalization; the app must not compute one." Replace with the real list.

## Verification

| Check | Command | Expected |
| --- | --- | --- |
| table row counts | TODO | TODO |
| null/empty counts | TODO | TODO |
| hash before/after read | TODO | unchanged |

Re-derived independently by: TODO (name, date, method).

## Version and update policy

How a new dataset version is detected, verified, installed and recorded; which gates
re-open when it changes.
TODO.
