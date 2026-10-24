# AGENTS.md — <PROJECT>

## Read order

1. `AGENTS.md` (this file)
2. `docs/00-data-atlas.md`
3. `docs/02-interface-contract.md`
4. `docs/03-frozen-rules.md`
5. `docs/04-acceptance-matrix.md`
6. `docs/06-handoff.md`

TODO: add any additional authoritative file and its purpose.

## Authority

- `docs/00` … `docs/04` are normative. Every other document that discusses them carries
  an inline `non-normative — see <doc>` marker at the top.
- The dataset is the final authority. When this repository and the dataset disagree, stop
  and fix the repository before continuing.
- `docs/reviews/` holds evidence, not instructions. A review record never overrides a
  normative document.
- `docs/reviews/` and internal operations stay in the private repository; the public
  repository carries user-facing docs only.

TODO: name the owner(s) of each normative document.

## Rules

- No application code before G0 (atlas) and G2 (interface contract) are recorded.
  Throwaway probes and data tooling are allowed and must not be merged into `lib/`.
- Never infer a physical value, identity, limit, unit or relation from display text. Read
  the source columns.
- Every query returns provenance: source table/record type, record key, dataset version.
- `empty` and `missing` are different statuses and must render differently.
- No platform is "supported" without a real build and a smoke test on that platform.
- Never delete or regenerate signing keys. Custody is documented in `docs/07-release.md`.
- A dependency change records the verified version and the reason in `docs/07` in the same
  change.
- A change to a frozen rule updates `docs/03` and its fixture **before** the
  implementation.
- User-facing copy carries no defensive engineering phrasing and no invented explanations.

TODO: add project-specific rules (naming, branches, review cadence, data update cadence).

## Where things live

| What | Path |
| --- | --- |
| Normative design | `docs/00-data-atlas.md` … `docs/04-acceptance-matrix.md` |
| Frozen rules and fixtures | `docs/03-frozen-rules.md`, `tool/` |
| Review records | `docs/reviews/` |
| Release and licensing | `docs/07-release.md` |
| Current state | `docs/06-handoff.md` |

TODO: fill in the real paths and any repositories outside this one.
