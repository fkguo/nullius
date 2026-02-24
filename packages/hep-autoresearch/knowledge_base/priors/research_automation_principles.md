# Research automation priors (assumptions and principles)

RefKey: priors-research-automation-principles
Last updated: 2026-02-03

## 1) Default engineering assumptions

- A research workflow can be decomposed into “executable steps + verifiable artifacts”, with gates enforcing quality.
- LLMs are strong at language and strategy search; trust comes from tool calls, artifact contracts, and independent review — not model confidence.
- Any automation must allow human intervention and rollback; default to avoiding irreversible actions.

## 2) Evidence-first (core principle)

Any claim that can affect conclusions must satisfy at least one:
- Pointer to reproducible computation artifacts (artifact path + field/key)
- Checkable derivation steps (no skipped steps in the notebook)
- Explicitly marked `UNVERIFIED`, with a verification plan and a kill criterion

## 3) Reproducibility contract (minimal artifact set)

Each run writes at least:
- `manifest.json` (command/params/versions/outputs)
- `summary.json` (well-defined statistical summary)
- `analysis.json` (headline numbers + error/uncertainty notes)
- `logs/` (relevant logs)

## 4) Multi-role review (minimum bar)

For key milestones, default require:
- Two independent perspectives (dual-model or human+model)
- If not converged, roll back: fix steps/inputs/assumptions/implementation, not “explain it away”

## 5) Automated manuscript revision boundaries

- Automated revisions must output a diff and keep compilation passing.
- Any new key conclusion/number must point to evidence; otherwise reject insertion into the main text (or mark as pending verification).
