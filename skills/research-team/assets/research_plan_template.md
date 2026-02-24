# RESEARCH_PLAN.md (Template)

Project: <PROJECT_NAME>
Owner: <YOUR_NAME>
Created: <YYYY-MM-DD>
Last updated: <YYYY-MM-DD>

## Execution Trigger (Prework -> Team Cycle)

Agent-first note: in normal usage you ask your tool-using LLM agent to run the commands below; they are kept explicit for reproducibility and debugging.

Prework checklist (must complete before any team cycle):
- Populate [knowledge_base/literature/](knowledge_base/literature/) with at least 1 note
- Populate [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/) with at least 1 trace
- Update [knowledge_base/priors/](knowledge_base/priors/)
- Update Capsule I) in [Draft_Derivation.md](Draft_Derivation.md) with all paths

Run preflight (what the agent runs; no external LLM calls):

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

Run full team cycle (what the agent runs; Claude + Gemini):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

## 0. Goal (What / Why)

- One-sentence objective:
- Why it matters:
- Primary deliverables (paper / note / code / data):

## 1. Scope (SCOPE)

- In scope:
- Out of scope:
- Explicit limitations (physics/model/assumptions):

## 2. Claims & Falsification

List the claims you want to be able to defend, and what would falsify them.

- Claim C1:
  - Evidence needed:
  - Falsified if:
- Claim C2:
  - Evidence needed:
  - Falsified if:

## 2.5 Innovation Maximization (Idea Portfolio)

To avoid “only minimum deliverables”, maintain an explicit idea portfolio:
- Create/maintain [INNOVATION_LOG.md](INNOVATION_LOG.md) (template provided by this skill).
- Each idea must be falsifiable and include a discriminant diagnostic, a minimal test, and a kill criterion.
- At each milestone, run 1–2 quick “innovation sprints” (low-res is fine) to advance/kill ideas fast.

## 3. Definition-Hardened Quantities (Contract)

For each quantity, lock:
1) exact operational definition,
2) code symbol + file path,
3) how uncertainty is estimated.

| Quantity | Operational definition | Code pointer | Uncertainty |
|---|---|---|---|
| Q1 |  |  |  |
| Q2 |  |  |  |

## 4. Reproducibility Artifact Contract

Best practice (recommended) artifact contract (especially for computational/dataset milestones):
- Run manifest JSON: command + params + versions + outputs
- Summary JSON/CSV: computed statistics used for plots/tables
- Analysis JSON/CSV: headline quantities recomputed from raw artifacts
- Main figures: generated and embedded in [Draft_Derivation.md](Draft_Derivation.md) (not just saved to disk)

Preferred numerics language:
- Default: Julia (aim for type-stable, preallocated hot loops; use mature packages first)
- Optional: Python (when ecosystem/tools make it clearly simpler); consider PyCall only when it improves workflow

Minimum gate enforced by this skill (hard fail-fast):
- [Draft_Derivation.md](Draft_Derivation.md) Capsule is complete, outputs exist on disk, headline pointers are machine-extractable,
- and (by default) at least one data artifact + at least one main figure embedded in the notebook (unless `Milestone kind: theory` or `dataset` rules apply).

Minimum fields (edit per project):
- manifest: `created_at`, `command`, `cwd`, `git`, `params`, `versions`, `outputs`
- summary: `definitions`, `windowing`, `stats`, `outputs`
- analysis: `inputs`, `definitions`, `results`, `uncertainty`, `outputs`

## 5. Milestones

Each milestone must have:
- **deliverables** (paths)
- **acceptance tests** (how to verify; must be concrete, not “looks good”)
- **team gate** (two-member independent cross-check + convergence)
- **innovation delta** (what new falsifiable insight/diagnostic was added)
- **methodology traces** (what validated method/evidence was preserved for reuse)
- **toolkit delta** (ONLY when `profile=toolkit_extraction`: enforce reusable API + code index + KB linkage)

### Definition of Done (DoD) rubric (anti-superficial)

Acceptance MUST be evidence-backed and quickly checkable:
- Prefer **file/field pointers** (e.g. `artifacts/analysis.json:results.foo`) over prose.
- Prefer **thresholds** (e.g. `<= 1e-6`) over “reasonable”.
- Prefer **explicit gate names/commands** (e.g. `run_team_cycle.sh --preflight-only`) over “passed checks”.
- If full recomputation is impractical, define **audit proxy headlines** (fast-to-check quantities) and record them in:
  - [Draft_Derivation.md](Draft_Derivation.md) → Audit slices block
  - Team packet → “Audit slices / quick checks”

## Task Board (autopilot uses this)

- [ ] T1: (auto) Define scope + claims; run team cycle (notes-only)
- [ ] T2: (manual) Prework coverage matrix/methodology/priors + method selection; update Capsule I)
- [ ] T3: (auto) First computation/derivation milestone + team cycle

## Progress Log

- <YYYY-MM-DD> tag=<TAG> status=<converged|not_converged> task=<Tn> note=<short>

### M0 — Baseline Reproduction

- Deliverables:
  - [Draft_Derivation.md](Draft_Derivation.md) skeleton
  - minimal reproducible run + plots + manifest/summary
- Acceptance:
  - `run_team_cycle.sh --preflight-only` passes (capsule + pointers + refs + KB layers)
  - At least 1 headline number is machine-extractable (e.g. `artifacts/analysis.json:results.H1`) and matches the reported value within tolerance
- Toolkit delta:
  - API spec: (fill; link to a concrete API doc/path, e.g. [TOOLKIT_API.md](TOOLKIT_API.md))
  - Code snippet index: (fill; at least 1 concrete code pointer/path, ideally under `src/` or `toolkit/`)
  - KB evidence links: (fill; include at least 1 link like [trace](knowledge_base/methodology_traces/recid-XXXX.md); do not put the link in backticks)
- Review gate:
  - team member reports saved in `team/`
- Innovation delta:
  - seed [INNOVATION_LOG.md](INNOVATION_LOG.md) with 3–5 candidate ideas + kill criteria
- Methodology traces:
  - create at least 1 item under [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/) and cite it in the notebook (capsule section I)

### M1 — Core Theory Derivation

- Deliverables:
  - complete derivation section(s) with no skipped steps
  - explicit assumptions + limiting-case checks
- Acceptance:
  - Both reviewers’ reports exist (e.g. `team/runs/<TAG>/<TAG>_member_a.md`, `team/runs/<TAG>/<TAG>_member_b.md`) and Derivation replication is `pass`
  - Each reviewer shows >=3 nontrivial intermediate steps and flags no skipped-step gaps
- Toolkit delta:
  - API spec: (fill; link to an API doc/path you updated)
  - Code snippet index: (fill; list any reusable derivation/check utilities you extracted)
  - KB evidence links: (fill; include at least 1 link like [trace](knowledge_base/methodology_traces/recid-XXXX.md); do not put the link in backticks)
- Review gate:
  - team member reports saved in `team/`
- Innovation delta:
  - at least 1 discriminant diagnostic/prediction written in falsifiable form (what would refute it)
- Methodology traces:
  - preserve at least 1 validated derivation trace or check under [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/)

### M2 — Core Computation Validation

- Deliverables:
  - scripts that reproduce all headline numbers and plots from raw artifacts
- Acceptance:
  - Headline numbers are traceable to artifacts (e.g. `artifacts/analysis.json#/results/...`) and match the capsule values
  - Audit slices contain at least 1 nontrivial proxy headline + key algorithm steps with code pointers
- Toolkit delta:
  - API spec: (fill; link to an API doc/path you updated)
  - Code snippet index: (fill; list any reusable numerics modules you extracted)
  - KB evidence links: (fill; include at least 1 link like [trace](knowledge_base/methodology_traces/recid-XXXX.md); do not put the link in backticks)
- Innovation delta:
  - at least 1 idea prototype result (advance/revise/kill) recorded in [INNOVATION_LOG.md](INNOVATION_LOG.md)
- Methodology traces:
  - preserve at least 1 validated computation trace (command + outputs + sanity checks) under [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/)

### M3 — Paper-Ready Package

- Deliverables:
  - final plots/tables, minimal SI checks, and a consolidated conclusion section
- Acceptance:
  - All primary figures are embedded in [Draft_Derivation.md](Draft_Derivation.md) and listed in Capsule D) outputs
  - References are complete and linked (external link if exists + local KB note link)
- Toolkit delta:
  - API spec: (fill; link to final API spec + versioning notes)
  - Code snippet index: (fill; list final reusable modules + entrypoints)
  - KB evidence links: (fill; include at least 1 link like [trace](knowledge_base/methodology_traces/recid-XXXX.md); do not put the link in backticks)
- Innovation delta:
  - final “what is new / what was learned” summary consistent with evidence

## 6. Team Loop (How we work like a team)

At the end of each milestone:
1) Update [INNOVATION_LOG.md](INNOVATION_LOG.md) (advance/revise/kill ideas; write the milestone’s innovation delta)
2) Build a team packet (`prompts/team_packet_<TAG>.txt`)
3) Run a team cycle (Claude + Gemini; both do both)
4) Convert findings into a fix list
5) Apply fixes and re-run checks
6) **Convergence gate**: if either report says mismatch/fail/needs revision, re-run (new tag, e.g. `M2-r1`) until both pass
7) Mark milestone complete only after convergence
