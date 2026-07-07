# literature-to-package tests

`test_phase_gates.py` exercises `scripts/gates/check_phase.py` as a subprocess
(stdout = `literature_to_package_gate_result_v1` verdict, stderr = diagnostics),
covering, per phase, at least one pass case and one case per load-bearing
falsification label — plus executor plumbing (input errors, `--out-json`,
template validity).

Run offline:

```bash
python3 -m pytest skills/literature-to-package/tests/test_phase_gates.py -q
# or
bash skills/literature-to-package/scripts/dev/run_smoke.sh
```

Fixtures are built programmatically in `tmp_path`; machine-specific path
literals used to exercise the absolute-path detector are constructed at
runtime so none ship in a committed file.
