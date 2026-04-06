# Beginner tutorial (legacy package walkthrough)

This quickstart assumes you are using the current CLI surfaces in an **external research project directory**. The package repo itself is a development repo, not the default place to run your day-to-day project, and real-project intermediate outputs should not be routed back into the repo either.

For the current generic front door, start with the repo-root `../../docs/QUICKSTART.md` and `../../docs/TESTING_GUIDE.md`. This package tutorial is a legacy-surface / maintainer-oriented compatibility walkthrough for readers who intentionally need the narrowed Pipeline A shell around an external research project.

Lifecycle note: the canonical generic lifecycle entrypoint is now `autoresearch` for `init/status/approve/pause/resume/export`. `hep-autoresearch`, `hepar`, and `hep-autopilot` remain the transitional **Pipeline A** Python surface for residual non-computation workflow/support commands. The installable public shell no longer exposes public computation, `doctor`, `bridge`, or `literature-gap`. This tutorial therefore uses `autoresearch` for lifecycle verbs, while any legacy-shell examples stay on the residual compatibility surface only.

## 0) Core ideas

1) **Agent is not model**: reliability comes from artifacts, approval gates, replayable commands, and independent review.
2) **Workflow is the entry point**: choose `ingest`, `reproduce`, `computation`, `draft`, `revision`, or another semantic workflow; the orchestrator handles routing and safety policy.
3) **Artifacts are evidence**: important outputs land in `manifest.json`, `summary.json`, and `analysis.json`. Human-readable reports are derived views.
4) **Context pack is the guardrail**: every run can emit `context.md` and `context.json`, keeping the run anchored to project-local charter, plan, notebook, and gate contracts.

## 1) Install

```bash
python3 -m venv ~/.venvs/hep-autoresearch
source ~/.venvs/hep-autoresearch/bin/activate
python -m pip install -U pip

# from the package repo root (dev install)
python -m pip install -e .
autoresearch --help
hep-autoresearch --help
hepar --help
```

Optional:
- `claude` CLI and `gemini` CLI if you later use dual-review or skill-based workflows.

## 2) Create a real project root

```bash
mkdir my-research-project
cd my-research-project
autoresearch init
autoresearch status
```

This creates a minimal project root with:
- `project_charter.md`
- `project_index.md`
- `research_plan.md`
- `research_notebook.md`
- `research_contract.md`
- `.mcp.json.example`
- `.autoresearch/`
- `docs/`, `specs/`

After initialization, you can run `autoresearch ...` for lifecycle verbs from any subdirectory; the CLI searches upward for `.autoresearch/`.
Workflow commands shown below remain on the transitional Pipeline A surface in this batch.
If you pass an explicit `HEP_DATA_DIR`, keep that directory outside the dev repo as well; public real-project flows now fail closed on repo-internal overrides.

## 3) Legacy compatibility smoke test without external LLM calls

This is an optional compatibility smoke path, not the recommended first-touch path.

Write a context pack in the new project:

```bash
hep-autoresearch context \
  --run-id M0-context-r1 \
  --workflow-id custom \
  --note "bootstrap smoke test"
```

Check the outputs:
- `artifacts/runs/M0-context-r1/context/context.md`
- `artifacts/runs/M0-context-r1/context/context.json`

This confirms the project-local charter / plan / notebook / gate contracts are visible to the runtime.

## 4) Run a minimal legacy workflow example

Example: deterministic ingest run with no external LLM dependency.

```bash
hep-autoresearch run \
  --run-id M1-ingest-r1 \
  --workflow-id ingest \
  --arxiv-id 2310.06770 \
  --refkey arxiv-2310.06770-swe-bench \
  --download none

autoresearch status
hep-autoresearch logs --tail 20
```

If a gate is raised:

```bash
autoresearch status
autoresearch approve <approval_id>
hep-autoresearch run --run-id M1-ingest-r1 --workflow-id ingest --arxiv-id 2310.06770 --refkey arxiv-2310.06770-swe-bench --download none
```

## 5) Other workflows

- `computation`: `docs/COMPUTATION.md` via `autoresearch run --workflow-id computation` (native TS front door, not `hep-autoresearch run`)
- `reproduce`: `workflows/reproduce.md`
- `draft`: `workflows/draft.md`
- `revision`: `workflows/revision.md`
- `derivation_check`: `workflows/derivation_check.md`

For `revision`, the default expectation is a project-local LaTeX tree such as `paper/`, or a user-specified LaTeX repo.

## 6) Optional skills and team workflows

If you intentionally use `research-team`, `research-writer`, or other higher-level skills:
- create those prompts/assets in **your project root**;
- treat them as project-local workflow inputs;
- do not assume this package repo ships package-root member prompts or a package-root manuscript tree.

## 7) Maintainer note

If you are working on the package repo itself, run evals from the package repo root:

```bash
python3 scripts/run_evals.py --tag M0-eval-r1
python3 scripts/run_orchestrator_regression.py --tag M0-reg-r1
```

The regression harness uses `init --runtime-only` on purpose, so maintainer checks do not recreate package-root project files.

That is a maintainer regression workflow, not the default end-user quickstart.
