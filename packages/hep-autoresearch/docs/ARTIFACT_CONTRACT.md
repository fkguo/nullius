# Artifact contract (evidence-first outputs)

The core reliability mechanism of this project is: **every step must write auditable artifacts to disk**. “We did it” is not evidence.

Chinese version (legacy / detailed notes): `docs/ARTIFACT_CONTRACT.zh.md`.

## 1) Directory convention

Recommended default layout:

- `artifacts/runs/<TAG>/`
  - `manifest.json`
  - `summary.json`
  - `analysis.json`
  - `logs/`
  - `figures/`
  - `tables/`

`<TAG>` should align with the `research-team` run tag (e.g. `M2-r1`) so “reproduction / computation / revision” can be linked to independent review runs.

## 2) The 3 core files (minimal set)

### A) `manifest.json` (how it was produced)

Must answer:
- what command was run, in what working directory, with what parameters?
- which key versions/dependencies were used?
- what output files were produced?

Minimum recommended fields (see `specs/artifact_manifest.schema.json`):
- `schema_version` (integer)
- `created_at` (ISO 8601)
- `command` / `cwd`
- `params` (object)
- `versions` (key software versions)
- `outputs` (recommended as a mapping; lists are acceptable but weaker for indexing)

To record absolute paths in manifests, set `HEPAR_RECORD_ABS_PATHS=1`.

Recommended `outputs` form:

```json
{
  "main_plot": "figures/main.pdf",
  "raw_data": "data/raw.csv",
  "analysis": "analysis.json"
}
```

### B) `summary.json` (statistics/definitions used in plots/tables)

Must answer:
- how are plotted/tabulated quantities defined (binning/windowing/selection)?
- how are statistics computed (mean/variance/CI/fit procedure)?

Minimum fields: `schema_version`, `created_at`, `definitions`, `stats`, `outputs`  
(see `specs/artifact_summary.schema.json`)

### C) `analysis.json` (headline numbers + uncertainty/differences)

Must answer:
- which final “headline numbers/curves” are reported, with exact operational definitions?
- where do uncertainties come from (numerical/truncation/statistical/systematic)?
- if reproducing a paper: how far are we from the paper, and why?

Minimum fields: `schema_version`, `created_at`, `inputs`, `results`  
(see `specs/artifact_analysis.schema.json`)

## 2.5) Human-readable report (recommended: `report.md`, JSON is SSOT)

Problem: JSON is excellent for machines/LLMs, but not pleasant for humans.

Project default recommendation:
- Keep `manifest.json` / `summary.json` / `analysis.json` as the **single source of truth (SSOT)**.
- Also generate a deterministic, human-readable view: `report.md` (derived from JSON).

`report.md` should include at least:
- run summary: workflow/tag/created_at/command
- key parameters and versions (from `manifest.json`)
- a table of headline numbers (with JSON pointers like `analysis.json#/results/headlines/<key>`)
- errors/warnings (if any)
- key output paths (plots/tables/diffs/logs)

Important: `report.md` must be regenerable from JSON (it is allowed to be deleted and rebuilt) to avoid “human doc drift”.

Regeneration:

```bash
python3 scripts/render_artifact_report.py --artifact-dir artifacts/runs/<TAG>/<workflow_dir>
python3 scripts/render_artifact_report.py --tag <TAG>
```

## 3) Citable pointers (notebook/paper rules)

Whenever a headline number appears in text, it must be traceable via a **machine-extractable pointer**, e.g.:
- `artifacts/runs/M2-r1/analysis.json#/results/sigma_tot_pb`

Include minimal semantics nearby (definition, units, scheme/scale where applicable).

## 4) Compatibility with existing tools

- `hep-calc` already outputs a compatible `manifest/summary/analysis` pattern; prefer aligning field names and avoid re-inventing.
- If a pipeline must output extra files (chains/fit weights/random seeds), add fields, but do not remove the minimal set.
