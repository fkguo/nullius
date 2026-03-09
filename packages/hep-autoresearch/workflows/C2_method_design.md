# C2_method_design (Phase C2)

Goal: turn a (human-provided) method intent into a **runnable, auditable computation plugin project**:
- generate a self-contained project scaffold (scripts + run_card v2 + project.json)
- (optional) snapshot external constants (e.g. PDG properties) at design time for reproducibility
- keep the generator deterministic and regression-testable (offline stub MCP)

This is the "bridge" between *planning/method selection* and *executable compute DAGs*.

## Inputs

Required:
- `--tag`: run tag used for artifact output paths (e.g. `M75-c2-r1`)
- `--template`: `minimal_ok` / `pdg_snapshot` / `pdg_runtime` / `spec_v1`

Optional:
- `--title`, `--description`: metadata overrides
- `--out-project-dir`: where to write the generated project (default: `artifacts/runs/<TAG>/method_design/project`)
- `--overwrite`: allow overwriting generated files (dangerous; prefer new tags)

Template requirements:

- `minimal_ok` / `pdg_snapshot` / `pdg_runtime`:
  - `--project-id`: plugin id for `project.json` (^[a-z][a-z0-9_]{0,63}$)
- `spec_v1`:
  - `--spec`: path to a `method_spec` v1 JSON bundle (required)
  - `--project-id`: optional override (defaults to `method_spec.project.project_id`)

PDG snapshot template (`--template pdg_snapshot`) additionally requires:
- `.mcp.json` (ignored by git) with a server entry (default name: `hep-research`)
  - or pass `--mcp-config`, `--mcp-server`
- `--pdg-particle-name` (e.g. `pi0`)
- `--pdg-property` in `{mass,width,lifetime}` (default: `mass`)
- optional: `--pdg-no-derived` (disallow derived values)

Required MCP tools on the server (pdg_snapshot):
- `pdg_get_property`

PDG runtime template (`--template pdg_runtime`) notes:
- Generation is deterministic and does **not** require a live MCP server.
- The generated project includes a runtime phase that calls `pdg_get_property`, so running the project requires a `.mcp.json` in the project directory (or a parameter override to `mcp_config`).
  - Required MCP tool at runtime: `pdg_get_property`

## Outputs (artifacts)

Writes to:
- `artifacts/runs/<TAG>/method_design/`

Files:
- `manifest.json` / `summary.json` / `analysis.json` (artifact triple)
- `report.md` (human-readable derived report; JSON is SSOT)
- `project/` (generated plugin project, by default)
  - `project.json`
  - `run_cards/main.json` (run_card v2)
  - `scripts/*.py`
  - `inputs/*.json` (template-dependent, e.g. `pdg_snapshot.json`, `method_spec.json`)

## Gates / acceptance

- Exit codes:
  - `0`: generated scaffold without recorded errors
  - `2`: generated scaffold but recorded errors (artifacts still written; inspect `analysis.json#/results/errors`)
  - nonzero (other): hard failure (e.g. invalid args or unsafe output path)
- Offline regression:
  - `tests/mcp_stub_server.py` implements deterministic `pdg_get_property`
  - `tests/test_method_design_cli.py` validates:
    - scaffold generation
    - run-card strict validation
    - computation execution for all templates (with stub MCP for pdg_snapshot)

## MVP scope (v0)

- Deterministic templates (no LLM calls).
- Templates:
  - `minimal_ok`: one phase writes a small JSON output
  - `pdg_snapshot`: snapshot a PDG property at design time via MCP, then run a self-contained computation card that copies the snapshot into results
  - `pdg_runtime`: query a PDG property at runtime via MCP, writing `results/pdg_property.json` (useful when you want the compute run to depend on the PDG DB version/locator)
  - `spec_v1`: materialize a runnable project from a structured `method_spec` v1 bundle (project metadata + files + run_card v2)
- Run-card output is validated strictly (`run_card v2` + DAG cycle check) before writing.

## Extension roadmap

- `method_spec` v1 JSON Schema lives under `specs/method_spec_v1.schema.json` (optional pre-validation; generator still enforces strict validation + path safety at runtime).
- Add an optional prompt-packet emitter for LLM-assisted translation (kept out of MVP for determinism; see Phase C4).
- Integrate `hep-calc` as a first-class design-time step (symbolic derivation → script/run-card generation).
- Add eval cases under `evals/` that run selected generated projects as regression.

## Example commands

Minimal scaffold:

```bash
PYTHONPATH=src python3 -m hep_autoresearch.orchestrator_cli --project-root . \
  method-design \
  --tag M75-c2-minimal-r1 \
  --template minimal_ok \
  --project-id demo_minimal
```

PDG snapshot scaffold (requires `.mcp.json`):

```bash
PYTHONPATH=src python3 -m hep_autoresearch.orchestrator_cli --project-root . \
  method-design \
  --tag M75-c2-pdg-r1 \
  --template pdg_snapshot \
  --project-id demo_pdg \
  --pdg-particle-name pi0 \
  --pdg-property mass
```

method_spec scaffold (materialize from a bundle):

```bash
PYTHONPATH=src python3 -m hep_autoresearch.orchestrator_cli --project-root . \
  method-design \
  --tag M77-c2-spec-v1 \
  --template spec_v1 \
  --spec templates/method_spec_v1.minimal_ok.json
```
