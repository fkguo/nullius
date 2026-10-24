# Interface contract — <APP>

Revision: TODO · Dataset: TODO (version + hash) · Owner: TODO

## Principles

- The UI never issues SQL and never reads raw rows. It consumes typed results only.
- The dataset is opened read-only; the app's own data lives in a separate store.
- Every user value is a bound parameter; no string-built SQL.
- Status is explicit: `success` / `notFound` / `error`. An existing object with no
  children is `success`; only a missing parent is `notFound`.
- Every returned object carries provenance.
- Pagination is keyset-based and its union equals the full set.

## Interfaces

| Interface | Input | Output | Statuses | Errors | Pagination | Provenance |
| --- | --- | --- | --- | --- | --- | --- |
| `findEntity` | TODO | TODO | success / notFound | TODO | — | TODO |
| `listChildren` | TODO | TODO | success / notFound | TODO | — | TODO |
| `getValues` | TODO | TODO | success / notFound | TODO | cursor | TODO |
| `listSources` | TODO | TODO | success / notFound | TODO | — | TODO |
| `search` | TODO | TODO | success (empty allowed) | TODO | cursor | TODO |
| `getReference` | TODO | TODO | success / notFound | TODO | — | TODO |

For each interface, state the exact meaning of an empty result versus a missing parent,
and the exact cursor contents (dataset hash, scope key, last sort key and id).

## Error codes

| Code | Meaning | UI behaviour |
| --- | --- | --- |
| `invalidInput` | malformed or out-of-range input | inline validation, no query |
| `notFound` | requested parent does not exist | "not recorded" state |
| `unsupportedVersion` | dataset schema/version mismatch | blocking state with recovery |
| `corruptDataset` | integrity check failed | blocking state, no partial data |
| `queryFailed` | engine failure | error state, retry |
| TODO | TODO | TODO |

No raw exception or driver message escapes the boundary.

## Provenance

Every object returns: dataset id/version/hash, source table or record type, record key,
and the columns the display layer used. Define the shape once and reuse it.
TODO: the provenance shape.

## Invariants

- Dataset hash verified before the first query; verified unchanged after close.
- Read-only: no write statement can reach the dataset connection.
- List parameters chunked below the engine's parameter limit.
- Cancellation is explicit; a cancelled query never renders as an empty result.
- Pagination: `page(n) ∪ page(n+1)` has no gaps or duplicates under a stable sort.
TODO: add invariants specific to this dataset.

## The UI may not

- convert units, round for storage, or derive one quantity from another;
- merge values from different sources into one;
- treat `NULL`, empty string and zero as interchangeable;
- choose a "best" value when the dataset offers several;
- hide a missing field behind a dash without a `not recorded` label.

## Versioning

Contract revision, dataset version compatibility, and what the app does on mismatch.
TODO.
