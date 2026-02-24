# Demo methodology trace (fixture)

Goal:
- Provide a minimal, auditable trace for how the fixture artifacts were produced.

Procedure:
1) Run `python3 scripts/make_artifacts.py --tag <TAG>`.
2) Verify the JSON files exist under `artifacts/runs/<TAG>/`.
3) Confirm `analysis.json:results.a/b/c` equal `1/2/3`.

