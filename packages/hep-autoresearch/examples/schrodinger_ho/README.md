# schrodinger_ho (Example Project)

This is a small, self-contained **declarative W_compute** example that solves a simple Schrodinger ODE
and validates against a known analytical solution. It is intended to stress-test `run_card v2` without
relying on the baryon/SU(6) domain code.

## Run

Validate the run-card:

```bash
python3 -m hep_autoresearch run-card validate \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json
```

Run the full pipeline:

```bash
python3 -m hep_autoresearch run \
  --run-id M65-a5-schrodinger-ho-r2 \
  --workflow-id W_compute \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --trust-project
```

Outputs are copied into:

- `artifacts/runs/<RUN_ID>/w_compute/phases/<PHASE_ID>/...`

Human-readable summary (deterministically derived from the JSON SSOT):

- `artifacts/runs/<RUN_ID>/w_compute/report.md`

Checked-in example output (clickable):

- [artifacts/runs/M65-a5-schrodinger-ho-r2/w_compute/report.md](../../artifacts/runs/M65-a5-schrodinger-ho-r2/w_compute/report.md)
