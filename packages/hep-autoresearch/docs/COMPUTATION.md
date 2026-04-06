# computation user guide (run_card v2)

Chinese version: [docs/COMPUTATION.zh.md](COMPUTATION.zh.md).

computation is a **domain-agnostic**, **declarative**, **auditable** compute DAG runner. All domain logic must live in a project plugin (typically under [examples/](../examples/)).

This doc focuses on:
- what a `run_card v2` is
- how computation resolves paths/parameters
- what artifacts you should expect
- how to validate and execute safely

For the workflow-level overview, see: [workflows/computation.md](../workflows/computation.md).

Front-door status:

- `autoresearch run --workflow-id computation` is now the canonical bounded TS computation entrypoint for initialized external project roots with a prepared `computation/manifest.json`.
- The `run-card validate/render` and `python3 scripts/orchestrator.py run --run-card ...` commands below remain legacy Pipeline A authoring/execution surfaces pending retirement; they are documented here so existing run-card-oriented examples stay interpretable.

## Quickstart

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

Current TS front-door execution:

```bash
autoresearch run \
  --project-root /abs/path/to/external-project \
  --run-id M0-computation-demo-r1 \
  --workflow-id computation \
  --manifest /abs/path/to/external-project/M0-computation-demo-r1/computation/manifest.json
```

Legacy helper utilities that still exist on the transitional Pipeline A surface:

```bash
python3 scripts/orchestrator.py run-card validate \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json

python3 scripts/orchestrator.py run-card render \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --format mermaid \
  --out artifacts/runs/M0-computation-demo-r1/computation/dag.mmd
```

If your approval policy triggers A3 on the current mainline TS surface, you will see `awaiting_approval`:

```bash
autoresearch status --project-root /abs/path/to/project
autoresearch approve <approval_id> --project-root /abs/path/to/project
```

Then rerun the same `autoresearch run --workflow-id computation ...` command.

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

## Re-run after approval

The current TS front door does not expose a separate `--resume` flag. After A3 approval, rerun the same `autoresearch run --workflow-id computation ...` command against the same initialized external project root and manifest path.

If a later execution attempt leaves the run in `paused`, `blocked`, or `needs_recovery`, do not assume the same command will auto-resume it. Check `autoresearch status` first and either follow the explicit recovery path for that run state or reset to a clean rerun. Recovery remains fail-closed: if state or artifacts do not match the expected computation inputs, execution should refuse to proceed.

## Acceptance checks and headline numbers

run_card v2 can optionally declare:
- **acceptance checks** (JSON Pointer + numeric tolerances)
- **headline numbers** extraction (machine-readable summary values)

These are written into `analysis.json` for downstream gates (evals, reports, writing).
