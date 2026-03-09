# computation user guide (run_card v2)

Chinese version: [docs/COMPUTATION.zh.md](COMPUTATION.zh.md).

computation is a **domain-agnostic**, **declarative**, **auditable** compute DAG runner. All domain logic must live in a project plugin (typically under [examples/](../examples/)).

This doc focuses on:
- what a `run_card v2` is
- how computation resolves paths/parameters
- what artifacts you should expect
- how to validate/run/resume safely

For the workflow-level overview, see: [workflows/computation.md](../workflows/computation.md).

## Quickstart (schrodinger_ho)

Validate the run-card:

```bash
python3 scripts/orchestrator.py run-card validate \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json
```

Render the phase DAG (optional):

```bash
python3 scripts/orchestrator.py run-card render \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --format mermaid \
  --out artifacts/runs/M0-computation-demo-r1/computation/dag.mmd
```

Run (non-interactive; shell phases require explicit trust):

```bash
python3 scripts/orchestrator.py run \
  --run-id M0-computation-demo-r1 \
  --workflow-id computation \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --trust-project
```

If your approval policy triggers A3, you will see `awaiting_approval`:

```bash
python3 scripts/orchestrator.py status
python3 scripts/orchestrator.py approve <approval_id>
```

Then rerun the same `run` command.

## What is a run_card v2?

A `run_card v2` is a strict JSON contract that declares:
- **parameters** (typed; CLI overrides allowed)
- **phases** (a serial DAG: `depends_on` + `inputs`/`outputs`)
- **backend** (usually `shell`: a project-provided script to execute)
- optional **acceptance checks** and **headline numbers** extraction

Schema SSOT:
- JSON Schema: [specs/run_card_v2.schema.json](../specs/run_card_v2.schema.json)
- Validator implementation: [src/hep_autoresearch/toolkit/run_card_schema.py](../src/hep_autoresearch/toolkit/run_card_schema.py)

Strictness policy:
- `schema_version` is an integer
- unknown fields are **ERROR**
- only the current schema version is supported

## Path semantics

computation uses three base directories:

- `${REPO_ROOT}`: the `hep-autoresearch` repository root.
- `${PROJECT_DIR}`: the project plugin root (must contain `project.json`).
- `${WORKSPACE}`: the per-run workspace under `artifacts/runs/<RUN_ID>/computation/`.

Within a phase:
- `backend.cwd` is resolved relative to `${PROJECT_DIR}` unless explicitly absolute.
- phase `inputs[]` use a simple convention:
  - paths starting with `phases/` resolve under `${WORKSPACE}` (e.g. upstream phase outputs)
  - other relative paths resolve under `${PROJECT_DIR}` (project files)
  - the validator enforces containment (no `../` escapes)

If you are unsure, run `run-card validate` first (it enforces the containment rules).

## Trust model (shell execution)

If any phase uses a shell backend, computation requires explicit trust:
- interactive: may prompt for confirmation
- non-interactive: requires `--trust-project` (fail-closed)

See: [docs/SECURITY.md](SECURITY.md) and [docs/APPROVAL_GATES.md](APPROVAL_GATES.md).

## Artifacts (what you get)

computation always writes SSOT artifacts under:

`artifacts/runs/<RUN_ID>/computation/`

Required artifacts are defined in: [docs/ARTIFACT_CONTRACT.md](ARTIFACT_CONTRACT.md).

Typical outputs include:
- `manifest.json` / `summary.json` / `analysis.json` / `report.md`
- `run_card.json` (normalized snapshot)
- `phase_state.json` (per-phase status + provenance pointers)
- `logs/<phase_id>/{stdout,stderr}.txt`

## Resume and crash recovery

If supported by the run-card and the workspace state, you can resume:

```bash
python3 scripts/orchestrator.py run \
  --run-id M0-computation-demo-r1 \
  --workflow-id computation \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --trust-project \
  --resume
```

Resume is fail-closed: if the run-card snapshot or phase outputs do not match the expected state, computation should refuse to resume and ask you to rerun cleanly.

## Acceptance checks and headline numbers

run_card v2 can optionally declare:
- **acceptance checks** (JSON Pointer + numeric tolerances)
- **headline numbers** extraction (machine-readable summary values)

These are written into `analysis.json` for downstream gates (evals, reports, writing).
