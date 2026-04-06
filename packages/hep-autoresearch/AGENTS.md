# AGENTS.md (Package scope)

This file governs development inside `packages/hep-autoresearch/`.

## What this directory is

- This directory is the **package/development repo** for the `hep-autoresearch` CLI, toolkit, docs, evals, examples, and maintainer regressions.
- It is **not** a live research project root.
- Real research-project roots should be created outside this package repo via `autoresearch init`.

## Package-root boundaries

- Do not treat package root as if it were a user project with a live charter, plan, notebook, manuscript, or team state.
- Project-shaped assets belong in one of these places only:
  - user-created external project roots (`autoresearch init`);
  - minimal generic examples under `examples/`;
  - deterministic regression fixtures under `evals/fixtures/`;
  - generated scaffold projects under `artifacts/runs/*/orchestrator_regression/project_init_project/`.
- Do not re-introduce package-root residue such as `PROJECT_CHARTER.md`, `PROJECT_MAP.md`, `RESEARCH_PLAN.md`, `PREWORK.md`, `Draft_Derivation.md`, package-root `paper/`, member prompt files, or ad-hoc self-hosted project state.
- Keep examples and fixtures generic, minimal, and reusable. Narrow historical project residue should stay out of this repo.

## Safe cleanup protocol (hard requirement)

- Do not run broad deletions (`rm -rf`, `git rm -r`) directly on top-level paths.
- Use `python3 scripts/safe_cleanup.py` in two phases:
  1) dry run to generate a deletion manifest, 2) explicit `--apply` with that manifest.
- Protected-by-default paths (non-deletable unless explicitly allowed): `knowledge_base/`, `references/`, `src/`, `scripts/`, `tests/`, `docs/`, `.git/`.
- If deleting a protected path is truly necessary, declare it explicitly with `--allow-protected <path>` during dry run and record a one-line rationale in the milestone note/adjudication.
- Before `--apply`, review the manifest summary (candidate count, tracked count, and top-level distribution).

## Validation expectations

- Before changing toolkit, orchestrator, evals, or docs, map the affected scripts, eval anchors, and tests.
- If a change alters a generated artifact anchor, regenerate that artifact and rerun the relevant eval case(s).
- Prefer the smallest relevant validation set first (targeted evals / targeted pytest), then widen only if needed.

## Review expectations

- After each cleanup batch, run a targeted repo search for stale references before declaring the batch done.
- If a maintainer-facing doc still implies “package root = research project root”, treat that as a bug and fix it in the same batch when low-risk.
