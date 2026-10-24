# Product and UX — <APP>

Version: TODO · Date: TODO
Related: `docs/00-data-atlas.md` (what exists), `docs/04-acceptance-matrix.md` (how it is
checked).

## Users

Who they are, what job they bring, what they already use, what would make them abandon
this app.
TODO.

## Primary flows

Five flows, each with a **real record key** from the dataset.

| # | Flow | Real example (record key) | End state |
| --- | --- | --- | --- |
| 1 | arrive → find an entity | TODO | TODO |
| 2 | entity → its properties | TODO | TODO |
| 3 | property → values → source | TODO | TODO |
| 4 | compare entities or sources | TODO | TODO |
| 5 | record / copy / return | TODO | TODO |

## Navigation

- Names and symbols are the primary axis; opaque identifiers are one query mode, never the
  main way to find something.
- Back/forward restores selection, expansion and scroll position.
- TODO: the full navigation model, including the top-level destinations and the map view
  (if any).

## Notation and search

Accepted input forms, normalisation rules, alias policy, family-name candidate lists, and
what is never silently replaced.
TODO: table of input form → behaviour.

## States

| State | Rendering | Recovery |
| --- | --- | --- |
| loading | TODO | — |
| empty result | TODO | TODO |
| not recorded | TODO | TODO |
| error | TODO | TODO |
| offline / partial dataset | TODO | TODO |
| stale dataset version | TODO | TODO |

## Layout and platforms

| Class | Shortest side | Navigation | Inspector |
| --- | --- | --- | --- |
| compact | TODO | TODO | TODO |
| medium | TODO | TODO | TODO |
| expanded | TODO | TODO | TODO |

Platform matrix: TODO (platform, layout checked, build, smoke).

## Accessibility and copy

- Text selection and copy on every value; copy keeps value, unit, uncertainty and source.
- Read-aloud labels for symbols and equations.
- Contrast and target sizes.
- Defined terminology (one term per concept), bilingual policy, and no defensive filler.
  TODO.

## Non-goals

TODO: list what this release deliberately does not do.
