# Artifact contract

Every meaningful workflow step writes auditable artifacts to disk.
The canonical project-local root is `artifacts/runs/<run_id>/`.

## Run identity

`run_id` is the stable research run identifier. It must be safe to use as one
path segment, stable across reconnects, sortable, readable, and meaningful
enough to resume or compare later.

Recommended shape:

```text
<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN
```

Example: `20260502T023000Z-m3-branch-scan-r1`.

Rules:

- Use only letters, digits, `.`, `_`, and `-`.
- Do not include path separators, `..`, whitespace, or shell-sensitive punctuation.
- Do not use opaque generated names such as bare UUIDs, `run_<uuid>`, `latest`,
  `test`, or unqualified timestamp-only names for human-facing research runs.
- Provider or machine IDs may be recorded inside manifests, but they are not the
  project-local `run_id` unless wrapped by a meaningful research identifier.

## Minimal outputs

- `manifest.json` records command, parameters, versions, and produced files.
- `summary.json` records derived statistics, definitions, or aggregation rules.
- `analysis.json` records headline results and the pointers needed to justify them.

## Working rule

- Reported numbers should be traceable to on-disk files, not only to prose.
- Human-readable notes may summarize results, but JSON or equivalent machine-readable artifacts remain the source of truth.
- Literature access traces, metadata checks, download attempts, and API/tool call logs belong in run artifacts or `research_plan.md`, not in literature notes.
- If a workflow cannot yet produce the full trio, record the gap explicitly in `research_plan.md` and `research_contract.md`.
