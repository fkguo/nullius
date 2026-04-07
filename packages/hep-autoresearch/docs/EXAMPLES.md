# Examples / project plugins

Chinese version: [docs/EXAMPLES.zh.md](EXAMPLES.zh.md).

This repo intentionally keeps the platform **domain-agnostic**. Any physics/domain logic should live in a **project plugin** (a self-contained directory), usually under [examples/](../examples/).

computation runs a project plugin by executing its declared `run_card v2` phases.

## Recommended layout

Minimal structure:

```
examples/<project_id>/
  project.json
  run_cards/
    <card>.json
  scripts/
    <phase_script>.py   # or .sh
```

Optional structure (common in real projects):

```
examples/<project_id>/
  project.json
  run_cards/
  scripts/
  data/                 # optional: small public fixtures
  results/              # optional: checked-in goldens (keep small)
  notes/                # optional: project-specific notes
```

## project.json

`project.json` is a lightweight descriptor used for discovery and guardrails (project id, title, run-card registry, etc.).

Reference example:
- [examples/schrodinger_ho/project.json](../examples/schrodinger_ho/project.json)

## Writing a run_card v2

Use `run_card v2` to declare:
- typed parameters
- phases (DAG via `depends_on`)
- backend (usually shell commands calling your scripts)
- inputs/outputs, plus optional acceptance/headline extraction

Start from:
- schema: [specs/run_card_v2.schema.json](../specs/run_card_v2.schema.json)
- workflow overview: [workflows/computation.md](../workflows/computation.md)

Current front-door note:

- Mainline computation execution now goes through `autoresearch run --workflow-id computation` on an initialized external project root with a prepared `computation/manifest.json`.
- Python `hep-autoresearch` / `hepar run` remains legacy-only for unrepointed non-computation/support workflows.
- `run-card validate` below is an internal maintainer-only authoring helper for checked-in example fixtures, not the generic/public front door.

Optional internal authoring check for checked-in example fixtures:

```bash
python3 scripts/orchestrator.py run-card validate \
  --run-card examples/<project_id>/run_cards/<card>.json
```

## Running a plugin with computation

```bash
autoresearch run \
  --project-root /abs/path/to/external-project \
  --run-id M0-my-plugin-r1 \
  --workflow-id computation \
  --manifest /abs/path/to/external-project/M0-my-plugin-r1/computation/manifest.json
```

Artifacts land under:
- `artifacts/runs/<RUN_ID>/computation/` (see [docs/ARTIFACT_CONTRACT.md](ARTIFACT_CONTRACT.md))

## Best practices

- Deterministic scripts: prefer fixed seeds, explicit tolerances, and stable output formats (JSON).
- Strict I/O: write outputs only to declared output paths; avoid hidden side effects.
- Keep domain code out of `src/`: platform core should not depend on project plugins.
- Evidence-first: write machine-readable `analysis.json` headline numbers to support downstream evals/writing.
