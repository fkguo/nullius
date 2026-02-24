# Problem Framing / Problem Framing-R (Sequential review + P/D separation template)

Project: <PROJECT_NAME>  
Owner: <YOUR_NAME>  
Date: <YYYY-MM-DD>  
Profile: `<PROFILE>` (options: `theory_only | numerics_only | mixed | exploratory | literature_review | methodology_dev | custom`)

Goal: turn “review / cross-check” into an executable protocol: no skipped steps, no convergence by oral compromise.

Core: Problem Interpretation Gate + P/D separation (Principle/Derivation) + Atomic standard + Sequential Review + an External Consistency / Paradox channel.

---

## How to use (bind into the main workflow; one content, multiple pointers)

- Sync “0) Problem Interpretation Gate” into [PREWORK.md](../PREWORK.md) → `## Problem Framing Snapshot` (avoid definition drift).
- Sync P/D separation and the sequential checklist into [RESEARCH_PLAN.md](../RESEARCH_PLAN.md) milestone DoD (acceptance must cite files/commands/thresholds).
- If there is unresolved disagreement, write the outcome into `team/runs/<tag>/<tag>_adjudication.md` and include it in the next packet (otherwise disputes never close).

Hard recommendations (avoid superficial acceptance):
- Failure / kill criteria: write at least one explicit threshold/condition (e.g. include `if` or `<`, `>`, `!=`).
- Complex numerics: do method/algorithm search + selection first (log under `knowledge_base/methodology_traces/`), then write code (avoid brute force by default).

## 0) Problem Interpretation Gate

You must first state “what problem are we solving?” as a testable object:

- Question (one sentence):
- Inputs:
- Outputs / observables:
- Scope / constraints:
- Anti-scope:
- Falsification / kill / scope-narrow triggers:

If the team disagrees on any of the above: immediately fork (do NOT continue derivations/plots).

## 1) P/D separation (Principle / Derivation)

### 1.1 Principles (reusable, cross-task)

List the principles/theorems/conservation laws/invariants/symmetries/reference results you rely on (each must be citable):

| ID | Principle | Why applicable | Source (paper/book/derivation pointer) |
|---|---|---|---|
| P1 |  |  |  |

### 1.2 Derivations (task-specific, step-auditable)

For each key conclusion, write atomic steps:

- D1: `<statement>`
  - inputs:
  - assumptions:
  - steps (>=3):
  - result:
  - checks (limits/sign/dimension):

## 2) Atomic standard (must satisfy)

An “atomic item” (claim/evidence/derivation step) must satisfy:

- Single assertion (no bundling of multiple conclusions)
- Explicit dependencies (requires/supports)
- Explicit evidence pointers (artifact path / derivation section / literature anchor)
- Falsifiable (at least one kill criterion or a counterexample path)

## 3) Sequential Review checklist

Tick in order; do not skip:

1. [ ] Problem Interpretation is complete and consistent
2. [ ] Principles are complete and each has a source
3. [ ] Derivation chain has no skipped steps (key steps have >=3 sub-steps)
4. [ ] Key definitions are consistent (same name, same object)
5. [ ] At least one external consistency check (known limit / reference / baseline)
6. [ ] If disagreement remains: switch to Correction or Fork (write the discriminating test)

## 4) External Consistency / Paradox Channel

If any of the following happens, open this channel and record it into evidence/trajectory:

- Conflict with a known limit / conservation law / reference result
- Two derivation paths produce different coefficients/signs
- Numerical results disagree beyond a reasonable tolerance

Record:
- Conflict description:
- Candidate causes (>=2):
- Minimal discriminating test (>=1):
- Outcome: Correction / Fork / Scope-narrow

