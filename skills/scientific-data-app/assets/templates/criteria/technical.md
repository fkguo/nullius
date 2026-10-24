# Technical review criteria — <PROJECT>

Written before the candidate design was visible. Applies to the data layer, architecture
and release plan.

## Options

For each serious stack option: what it buys, what it costs, and what evidence would be
needed before committing. Do not rank by micro-benchmark claims.

| Option | Buys | Costs | Evidence required |
| --- | --- | --- | --- |
| TODO | TODO | TODO | TODO |

## Data gates

- The source is read, never written; integrity verified before use.
- `NULL`, empty string and zero are distinct end to end.
- Every displayed quantity keeps its source record; display text is never parsed back
  into a value.
- Units are not converted silently; precision is not changed for display convenience.
- Updates are verified (version, hash, schema) and installed atomically; failure keeps the
  old dataset.

## Identity

- Normalisation rules are explicit and tested with real ambiguous inputs.
- Charge/isomer/state distinctions survive resolution.
- Family names return candidates.
- Identifier collisions are reported, not resolved by first match.

## Contract

- Statuses distinguish empty from missing.
- Errors have stable codes.
- Pagination is complete under a stable sort.
- The UI cannot bypass the data layer.

## Performance

Targets are product-level and measured on release builds of old hardware: cold start,
first query, typing latency, long-list scroll, first query after a dataset update. Record
p50/p95, memory, package size, device and dataset version. No claim without a measurement.

## Release

Every claimed platform has a real build and smoke test. Signing keys live outside the
repository with documented custody. Data licences are recorded per dataset.

## Non-goals

TODO: what this project deliberately does not optimise or support.
