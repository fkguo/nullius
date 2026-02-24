# Beginner tutorial (English)

This is a short English quickstart for first-time users. A more detailed Chinese tutorial is available at `docs/BEGINNER_TUTORIAL.zh.md`.

## 0) What you need to know

1) **An agent is not a model**: reliability comes from tools + artifacts + gates + independent review, not from “good prompts”.
2) **Workflows are the entry point**: you run W1/W2/W3/W4; the orchestrator routes work and enforces gates.
3) **Artifacts are evidence**: key outputs must land as `manifest.json / summary.json / analysis.json` (SSOT). `report.md` is derived.
4) **Approval gates are default**: large-scale retrieval, code edits, compute-heavy runs, manuscript edits, and “claims/new conclusions” should require human approval unless explicitly set to full-auto.

## 1) Minimal install

```bash
# (recommended) create a dedicated venv once
python3 -m venv ~/.venvs/hep-autoresearch
source ~/.venvs/hep-autoresearch/bin/activate
python -m pip install -U pip

# from repo root (dev install)
python -m pip install -e .
hep-autoresearch --help
hepar --help
```

Alternative (if you use [uv](https://github.com/astral-sh/uv)):

```bash
uv venv ~/.venvs/hep-autoresearch
source ~/.venvs/hep-autoresearch/bin/activate
uv pip install -e .
hep-autoresearch --help
```

To exit the venv:

```bash
deactivate
```

Optional (only needed when running dual-model reviews):
- `claude` CLI
- `gemini` CLI (commonly used alias: `gemini-3-pro-preview`)

## 1.5) Create a real research project (recommended)

Run the Orchestrator in your **research project directory** (not in the `hep-autoresearch` dev repo):

```bash
mkdir my-research-project
cd my-research-project
hep-autoresearch init   # scaffolds docs/ + knowledge_base/ + specs/ + .autoresearch/
hep-autoresearch status
```

After initialization, you can run `hep-autoresearch ...` from any subdirectory; the CLI searches upward for `.autoresearch/`.

## 2) Preflight-only (no external LLM calls)

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag \
  --preflight-only
```

This produces:
- planning artifacts under `artifacts/runs/M0-r1/`
- a team packet under `team/runs/M0-r1/` (for reviewers)

## 3) Quick check: run evals

```bash
python3 scripts/run_evals.py --tag M0-eval-r1
```

## 4) Next: pick a workflow

- W1 ingestion: `workflows/W1_ingest.md`
- W_compute (run_card v2 DAG): `workflows/W_compute.md`
- W2 reproduce: `workflows/W2_reproduce.md`
- W3 writing/revision: `workflows/W3_draft.md` / `workflows/W3_revision.md`
- W4 derivation checks: `workflows/W4_derivation_check.md`

W_compute docs:
- W_compute user guide: [docs/W_COMPUTE.md](W_COMPUTE.md)
- Examples / project plugins: [docs/EXAMPLES.md](EXAMPLES.md)
