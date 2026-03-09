# Beginner tutorial (English)

This quickstart assumes you are using `hep-autoresearch` in an **external research project directory**. The package repo itself is a development repo, not the default place to run your day-to-day project.

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
hep-autoresearch --help
hepar --help
```

Optional:
- `claude` CLI and `gemini` CLI if you later use dual-review or skill-based workflows.

## 2) Create a real project root

```bash
mkdir my-research-project
cd my-research-project
hep-autoresearch init
hep-autoresearch status
```

This creates a minimal project root with:
- `PROJECT_CHARTER.md`
- `PROJECT_MAP.md`
- `RESEARCH_PLAN.md`
- `PREWORK.md`
- `Draft_Derivation.md`
- `.autoresearch/`
- `docs/`, `knowledge_base/`, `specs/`

After initialization, you can run `hep-autoresearch ...` from any subdirectory; the CLI searches upward for `.autoresearch/`.

## 3) Smoke test without external LLM calls

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

## 4) Run a minimal workflow

Example: deterministic ingest run with no external LLM dependency.

```bash
hep-autoresearch run \
  --run-id M1-ingest-r1 \
  --workflow-id ingest \
  --arxiv-id 2310.06770 \
  --refkey arxiv-2310.06770-swe-bench \
  --download none

hep-autoresearch status
hep-autoresearch logs --tail 20
```

If a gate is raised:

```bash
hep-autoresearch status
hep-autoresearch approve <approval_id>
hep-autoresearch run --run-id M1-ingest-r1 --workflow-id ingest --arxiv-id 2310.06770 --refkey arxiv-2310.06770-swe-bench --download none
```

## 5) Other workflows

- `computation`: `workflows/computation.md`
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
