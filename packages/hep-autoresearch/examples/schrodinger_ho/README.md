# schrodinger_ho (Example Project)

This is a small, self-contained **declarative computation** example that solves a simple Schrodinger ODE
and validates against a known analytical solution. It is intended to stress-test `run_card v2` without
relying on any prior narrow domain-specific legacy code.

Front-door note:

- The current mainline computation entrypoint is `autoresearch run --workflow-id computation` on an initialized external project root with a prepared `computation/manifest.json`.
- The commands below remain the legacy Pipeline A run-card example path for this checked-in fixture.

## Legacy run-card example

Validate the run-card:

```bash
python3 -m hep_autoresearch run-card validate \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json
```

Run the full pipeline:

```bash
python3 -m hep_autoresearch run \
  --run-id M65-a5-schrodinger-ho-r2 \
  --workflow-id computation \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --trust-project
```

Outputs are copied into:

- `artifacts/runs/<RUN_ID>/computation/phases/<PHASE_ID>/...`

Human-readable summary (deterministically derived from the JSON SSOT):

- `artifacts/runs/<RUN_ID>/computation/report.md`

Checked-in example output (clickable):

- [artifacts/runs/M65-a5-schrodinger-ho-r2/computation/report.md](../../artifacts/runs/M65-a5-schrodinger-ho-r2/computation/report.md)
