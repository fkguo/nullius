# Environment Contract

## Minimum Runtime

- Julia: `>= 1.10`

## Package Contract

Required packages:
- `BenchmarkTools`
- `JSON3`

Recommended packages:
- `JET`

## Bootstrap

From the skill directory:

```bash
julia --project=scripts -e 'using Pkg; Pkg.instantiate()'
```

Optional explicit add:

```bash
julia --project=scripts -e 'using Pkg; Pkg.add(["BenchmarkTools", "JSON3", "JET"])'
```

## Fallback Behavior

- If `JET` is missing, do not crash the run.
- Emit a soft warning and continue with available checks (`@code_warntype`, benchmark evidence).

## Determinism Notes

- For reproducible gate outcomes, pin package versions in `scripts/Project.toml` and retain a `scripts/Manifest.toml`.
- Record environment details in output `manifest.json`.
