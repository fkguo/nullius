# Research Integration

This skill supports standalone usage by default and ecosystem integration as an optional mode.

## Standalone Mode

Recommended path pattern:

- `.julia-perf/runs/<timestamp>/manifest.json`
- `.julia-perf/runs/<timestamp>/benchmarks.json`
- `.julia-perf/runs/<timestamp>/summary.json`
- `.julia-perf/runs/<timestamp>/diagnostics.md`

No `hepar` dependency is required.

## Ecosystem Mode

Recommended path pattern:

- `artifacts/runs/<tag>/julia-perf/manifest.json`
- `artifacts/runs/<tag>/julia-perf/benchmarks.json`
- `artifacts/runs/<tag>/julia-perf/summary.json`
- `artifacts/runs/<tag>/julia-perf/diagnostics.md`

## Ownership Boundaries

- `artifacts/runs/<tag>/manifest.json` is owned by `hepar` and must not be modified by this skill.
- `julia-perf` writes only inside its own subdirectory.

## Auto-Mode Resolution Rule

- If both `--artifact-root` and `--tag` are provided, resolve to ecosystem mode.
- Otherwise resolve to standalone mode.

## Parallel Writers

For concurrent runs, write to:

- `artifacts/runs/<tag>/julia-perf/<agent-id>/...`

Then merge at summary stage into:

- `artifacts/runs/<tag>/julia-perf/summary.json`

## Registry Hook (optional)

If a component registry is used, append or update:

- `artifacts/runs/<tag>/components.json`

with a component entry pointing to `julia-perf/summary.json`.

