# Pre-task Clarifier (Task clarification & decomposition template)

Project: <PROJECT_NAME>  
Owner: <YOUR_NAME>  
Date: <YYYY-MM-DD>  

Goal: before starting, turn the task into a verifiable DAG (milestones + DoD) and make anti-scope and profile-aware constraints explicit to avoid drifting goals/standards.

---

## How to use (bind into the main workflow; avoid “written but unused”)

Sync key information from this file into the main workflow docs (otherwise mechanisms become ceremony):

- Sync to [research_preflight.md](../research_preflight.md): fill `## Problem Framing Snapshot` (Problem Interpretation + P/D separation + kill criteria).
- Sync to [research_plan.md](../research_plan.md): turn milestones into `## Task Board` checkbox tasks (recommended: explicitly mark `(auto)` / `(manual)` for autopilot).
- Sync to [research_contract.md](../research_contract.md): keep the Capsule as a reproducibility contract; put derivations/algorithm details in the body (do NOT cram derivations into the Capsule).

Hard recommendations (avoid superficial acceptance):
- Kill / Narrow criteria: write at least one explicit threshold/condition (e.g. include `if` or comparison operators `<`, `>`, `!=`).
- Complex numerics/algorithms: first record candidate methods + decision rationale under `knowledge_base/methodology_traces/`, then implement (avoid brute force by default).

## 0) Profile (pick exactly one)

Choose one (write it here and keep consistent across gates/config):

- `theory_only`: derivation/logic closure first
- `numerics_only`: simulation/results first
- `mixed`: theory + numerics (stricter default)
- `exploratory`: exploration/divergence (warn-only allowed, but must have TTL)
- `literature_review`: evidence curation / competing viewpoints
- `methodology_dev`: method/tooling development (interfaces + tests)
- `custom`: custom profile (must declare gates + thresholds)

Chosen profile: `<PROFILE>`

## 1) Minimal Q&A (keep answers short)

1. What is the one-sentence question?
2. What are the observable outputs / comparable quantities (max 3)? (define + units + notation conventions)
3. What evidence types do we expect? (derivation / computation / experiment / literature / mixed)
4. What is the minimal falsification criterion? (what result would make us scope-narrow or fork immediately)
5. Biggest uncertainty / key risks? (1–2 items)
6. External inputs / matching targets? (list and mark as MATCHING)

## 2) Task DAG (milestones + DoD)

Write node-like tasks (each must be verifiable). 3–6 milestones recommended.

### M0 — Preflight / Skeleton
- Deliverables (paths):
- DoD (Definition of Done):
- Kill / Narrow criteria:

### M1 — Core Evidence (P/D separation)
- Deliverables (paths):
- DoD:
- Kill / Narrow criteria:

### M2 — Cross-check / External consistency
- Deliverables (paths):
- DoD:
- Kill / Narrow criteria:

## 3) Anti-scope (required)

State what we explicitly will NOT do and why (avoid scope creep):
- Out-of-scope 1:
- Out-of-scope 2:

## 4) Evidence chain & logging map (where things must be written)

- Claim DAG: `knowledge_graph/claims.jsonl` (which conclusions must be claims?)
- Evidence: `knowledge_graph/evidence_manifest.jsonl` (what outputs count as evidence?)
- Trajectory: `team/trajectory_index.json` (per-tag outputs / disagreements)
- Knowledge base: `knowledge_base/{literature,methodology_traces,priors}/`

## 5) Fail-fast rules (recommended)

If any of the following happens, stop “adding more content” and switch to Correction / Fork / Scope-narrow:

- Key definitions disagree (same name, different object)
- The derivation chain is broken and cannot be repaired
- Numerics are unstable vs inputs/implementation and cannot be explained
- A strong counterexample or direct refutation is found in the literature

