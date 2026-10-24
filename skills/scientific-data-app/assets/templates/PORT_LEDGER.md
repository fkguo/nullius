# Port ledger

Every module, document or asset carried from another project gets one row. The ledger is
written **before** code is copied and is updated when a decision changes.

## Scope

- Source project(s) and commit:
  TODO: repository, commit hash, date.
- Target project and commit:
  TODO.
- Licences: source code, source data, third-party notices.
  TODO: name them; record compatibility and obligations.
- What is explicitly **not** carried and why:
  TODO.

## Inventory

| ID | Item (path) | Layer | Decision | Licence | New home | Tests carried | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | `TODO` | shell / core / data / domain / feature / tooling / asset | REUSE / ADAPT / REWRITE / DROP | TODO | TODO | TODO | TODO |

Decision rules: REUSE = no domain nouns and the tests carry over; ADAPT = structure is
right, nouns/schema change; REWRITE = data semantics differ; DROP = not needed.
Classify by the most domain-coupled line in the item.

## Domain leaks

| Search | Expected result | Status |
| --- | --- | --- |
| old dataset names, identifier prefixes, file names | only deliberate historical notes | TODO |
| old entity nouns in types, strings, errors, help | none | TODO |
| old URLs, DOIs, citations, store copy, bundle IDs | none | TODO |
| old CI variables, fixture paths, expected values | none | TODO |
| old screenshots, brand assets | none | TODO |

TODO: record the grep commands used, so the check is repeatable.

## Old claims

Every "done" from the source project is re-opened. Nothing is carried as accepted.

| Claim | Source evidence | Status in this project |
| --- | --- | --- |
| TODO | TODO | re-opened / re-verified / dropped |

## Open questions

TODO: list decisions still owed, with the owner and the gate that needs them.
