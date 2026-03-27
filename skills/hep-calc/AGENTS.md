# AGENTS.md (repo-wide guidance)

This repository is a Codex Skill: `hep-calc` (auditable HEP calc runner).

This file is for **developers and LLM agents working inside this repo**. It supplements `SKILL.md`
with development rules and **contract invariants** that must not regress.

## What this repo is

`hep-calc` orchestrates:
- Mathematica (`wolframscript`) with FeynCalc / FeynArts / FormCalc / LoopTools / (optional) FeynRules
- Julia with LoopTools.jl (optional numeric stage)
- Python utilities for job resolution, LaTeX extraction/comparison, and report generation

Primary entry point: `scripts/run_hep_calc.sh`

## Contract invariants (do not break)

### Out-dir / audit contract

For every run, `scripts/run_hep_calc.sh` MUST:
- Require an explicit `--out` for public runs, and fail closed when it is omitted or points inside the hep-calc repo
- Treat repo-local outputs as maintainer-only fixtures behind `HEP_CALC_ALLOW_REPO_LOCAL_OUT=1`, not as public default behavior
- Create an auditable `out_dir`
- Write `out_dir/job.resolved.json`
- Write per-stage `status.json` (PASS/FAIL/SKIPPED/ERROR/NOT_RUN) + logs under `out_dir/logs/`
- Write the only machine-readable SSOT artifacts at out_dir root:
  - `out_dir/manifest.json`
  - `out_dir/summary.json`
  - `out_dir/analysis.json`
- Write the human-facing report:
  - `out_dir/report/audit_report.md`

No silent failures: if a stage is skipped, it must be visible in report + status files.

Reference: `references/output_contract.md`

### Stage names (stable identifiers)

Keep these stage identifiers stable, because downstream tooling may rely on them:
- `feynarts_formcalc`
- `tex_model_preprocess`
- `auto_qft_model_build`
- `auto_qft_one_loop`
- `mathematica_symbolic`
- `julia_numeric`
- `tex_compare`

### research-team integration (if enabled)

If `integrations: [research-team]` and `tag: <TAG>` are present, the runner must sync core artifacts to:
`artifacts/runs/<TAG>/hep-calc/`

The sync root must be an explicit or auto-detected external project root. If none can be found, fail closed instead of falling back to the hep-calc repo or current working directory. Repo-local sync fixtures remain maintainer-only behind `HEP_CALC_ALLOW_REPO_LOCAL_OUT=1`.
Repo-local `process/` and `artifacts/` directories under the skill checkout are cleanup-able maintainer residue, not a second public output contract and not acceptable default sync targets.

If you add new “core” artifacts, update the sync list in `scripts/run_hep_calc.sh`
and the doc list in `references/research_team_integration.md`.

## Design boundary: skill vs agent (model_build)

For `auto_qft.model_build`:
- The skill must remain deterministic/auditable (extract/normalize/TeXForm-parse only).
- Physics mapping is **explicitly agent-provided** via `auto_qft.model_build.rewrite_wls`.
- Do not add “smart guesses” about physics conventions in the skill; add knobs + audit trails instead.

Reference: `references/model_build_latex.md`

## Security boundary (no sandbox)

These features execute user/agent code and must be treated as untrusted unless the job is trusted:
- `latex.extractor_plugin` (Python import)
- `julia_expr` (Julia eval)
- `auto_qft.model_build.rewrite_wls` (Mathematica `Get[...]`)

Do not attempt to “silently sandbox” them in code; instead, keep the safety disclosures prominent and auditable.

## Development workflow

### Pre-flight

Run environment check:

```bash
bash scripts/check_env.sh --json /tmp/hep_calc_env.json
```

### Smoke tests (must pass locally before committing)

From repo root:

```bash
# LoopTools + TeX audit demo
bash scripts/run_hep_calc.sh --job assets/demo_job.yml --out /tmp/hep_calc_demo_job

# auto_qft (FeynArts-only QED)
bash scripts/run_hep_calc.sh --job assets/demo_auto_qft_qed_bhabha.yml --out /tmp/hep_calc_demo_qed_bhabha

# auto_qft (FeynRules SM)
bash scripts/run_hep_calc.sh --job assets/demo_auto_qft_ee_mumu.yml --out /tmp/hep_calc_demo_ee_mumu

# model_build plumbing demo
bash scripts/run_hep_calc.sh --job assets/demo_auto_qft_model_build_sm_identity.yml --out /tmp/hep_calc_demo_model_build
```

If a demo is too slow/heavy on a machine, adjust the demo job (not the core contract) and document why.

### Code quality checks

```bash
python3 -m py_compile scripts/compare_tex.py scripts/generate_report.py scripts/tex/prepare_model_build_tex.py
```

## Change checklist (when adding features)

When you add or change job keys / outputs, update **all** of:
- `scripts/run_hep_calc.sh` defaults + job path resolution
- `assets/job_schema.json`
- `references/job_schema.md`
- `references/output_contract.md`
- `scripts/generate_report.py` step table + manifest fields (if new stage)
- `references/troubleshooting.md` (new reasons / fixes)
- Add or update a small `assets/demo_*.yml` if needed

Keep `SKILL.md` agent-facing and concise (≤500 lines). Put details in `references/`.

## Repo hygiene

- Do not commit run outputs: `process/` and `artifacts/` are intentionally gitignored maintainer-local fixture areas, not the public runtime target.
- If repo-local `process/` or `artifacts/` directories become stale during skill development, delete or recreate them locally instead of documenting them as current public workflow outputs.
- Prefer small, deterministic demo inputs.
- Avoid introducing new heavy dependencies (keep Python stdlib where possible).
