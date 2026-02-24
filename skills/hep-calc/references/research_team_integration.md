# hep-calc integration with research-team / research-writer

> Language: English. 中文版: `references/research_team_integration.zh.md`

When the job enables:

```yaml
integrations: [research-team]
tag: <TAG>
```

`scripts/run_hep_calc.sh` syncs core artifacts to:

```
artifacts/runs/<TAG>/hep-calc/
  manifest.json
  summary.json
  analysis.json
  audit_report.md
  feynarts_formcalc.status.json
  auto_qft.status.json
  auto_qft.summary.json
  auto_qft.model_build.status.json
  auto_qft.model_build.summary.json
  auto_qft.model_build.generated_lagrangian.fr  # if generated
  auto_qft.model_build.parsed_blocks.m          # if generated
  auto_qft.model_build.tex_preprocess.status.json
  auto_qft.model_build.tex_preprocess.summary.json
  auto_qft.model_build.tex_preprocess.blocks_selected.json
  auto_qft.model_build.tex_preprocess.blocks_all.json
  auto_qft.model_build.tex_preprocess.macros.json
  auto_qft.model_build.tex_preprocess.tex_files.json
  auto_qft.model_build.tex_preprocess.trace.json
  auto_qft.diagrams.pdf                 # if generated
  auto_qft.diagrams.index.md            # if generated
  auto_qft.amplitude_summed.m           # if generated
  auto_qft.amplitude_summed.tex         # if generated
  auto_qft.amplitude_summed.md          # if generated
  job.resolved.json
  env.json
  FULL_OUT_DIR.txt
```

Notes:
- `FULL_OUT_DIR.txt` points to the full audit directory (with logs and full symbolic/numeric/tex JSON outputs).
- research-writer / hep-autoresearch can use `manifest.json` / `summary.json` / `analysis.json` as the provenance/evidence entrypoint (machine-readable; identical to the out_dir-root SSOT triplet).

How the sync project root is chosen:
- You may explicitly set `research_team_root: /path/to/project` at the job top level (highest priority).
- Or set the environment variable `RESEARCH_TEAM_ROOT`.
- Otherwise, the runner searches upward from the runtime `cwd` and the job directory to find the nearest directory containing `artifacts/` (or `artifacts/runs/`) and uses it as the project root; if none is found, it falls back to the current working directory.

Minimal recommendations:
- Keep `<TAG>` aligned with your paper/milestone (e.g. `M0-demo`, `M1-benchmark`).
- In the paper or Capsule, cite `artifacts/runs/<TAG>/hep-calc/audit_report.md`.
