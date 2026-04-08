---
name: deep-learning-lab
description: Scaffold an auditable, reproducible deep-learning research project (configs, dataset provenance, artifacts/runs/<tag>/) designed to interoperate with research-team + research-writer paper drafting.
---

# Deep Learning Lab

This skill bootstraps a deep-learning research project with **reproducibility-first** defaults:
- deterministic run metadata (seed/config/env),
- an `artifacts/runs/<tag>/` layout compatible with `research-writer`,
- and a lightweight “knowledge base” folder for audit trails (data, decisions, literature).

It is intentionally framework-agnostic: you can implement training in PyTorch/JAX/TF later, but the *research hygiene* scaffolding stays the same.

## One-shot scaffold

```bash
python3 scripts/bin/dl_lab_scaffold.py --out /path/to/new-project --name my-dl-project
```

Then generate a demo artifacts run (to validate wiring):

```bash
python3 /path/to/new-project/scripts/make_artifacts.py --tag M0-demo
```

## Artifact contract (interoperability)

To interoperate with `research-writer`, prefer:

- `artifacts/runs/<TAG>/manifest.json` with:
  - code version (git commit), environment, dataset provenance, hyperparameters, seed
  - `outputs`: list of produced files (`path` relative to project root)
- `artifacts/runs/<TAG>/summary.json` with:
  - `metrics` (stable flat dict): parseable numbers for eval/regression
  - `metric_definitions`: definitions/units/higher-is-better
  - `best_checkpoint`: pointer to the selected checkpoint artifact
- `artifacts/runs/<TAG>/analysis.json` with:
  - `results` (flat dict): headline numbers (metrics) that can be quoted in the paper

All quoted numbers in the paper must point to `analysis.json:results.<key>`.

## CPU smoke test (no GPU)

```bash
python3 scripts/bin/dl_lab_demo_run.py --out-dir /tmp/dl_run --seed 0
test -f /tmp/dl_run/manifest.json
test -f /tmp/dl_run/summary.json
test -f /tmp/dl_run/analysis.json
```

## Auditability defaults

- Track dataset provenance under `knowledge_base/data/` (source URLs, checksums, split logic).
- Track methodology decisions under `knowledge_base/decisions/` (what was tried, what failed, why).
- Track evaluation protocols under `knowledge_base/methodology_traces/` (metrics, baselines, ablations).

## Next step (paper drafting)

Once you have a real run tag with artifacts, scaffold a paper with `research-writer`:

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
bash "${CODEX_HOME}/skills/research-writer/scripts/bin/research_writer_scaffold.sh" \
  --project-root /path/to/new-project \
  --tag M0-demo \
  --out paper/
```
