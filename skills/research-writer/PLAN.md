# research-writer — Forward plan (Skill vs Agent separation)

This document is the **single progress tracker** for future milestones beyond M7.

Principle: **Skills** implement deterministic, testable tooling and auditable pipelines. **Agents** perform judgment-heavy research/writing decisions (including manual merging of distilled patterns into the playbook).

## Scope boundary (what goes where)

### A) Skill responsibilities (deterministic + auditable)
- I/O plumbing, file contracts, artifact discovery, provenance tables.
- Corpus fetching, format normalization (tar/gz), retry/backoff, batching/resume/repair.
- Deterministic distillation/aggregation utilities (consensus statistics, disagreement reports).
- Quality gates (compile checks, warning extraction, bib hygiene, escape checks).
- **Offline smoke coverage** (fixtures, `--stub-models`, reproducible logs).

### B) Agent responsibilities (judgment + physics writing)
- Deciding which corpora/queries/authors to learn from; interpreting style signals.
- Converting distilled patterns into **physics discussion logic** in your voice (manual edits).
- “Scientific skepticism” enforcement:
  - independently re-derive/validate any external claim used in core reasoning, OR
  - mark `UNVERIFIED` with validation plan + kill criterion.
- Adjudicating dual-model disagreements and selecting the final narrative/structure.

### C) Hard rule
- No model run may automatically mutate `assets/style/physics_discussion_logic_playbook.md`.
  - The skill may generate **external** `distill/` reports; the agent/human merges selectively.

## How we track progress

- Each milestone has:
  - **Status**: `planned` → `in progress` → `done`
  - A local maintainer review folder: `team/reviews/<Milestone>-r1/` (not checked in)
  - Dual-review gate: both reviewers must output `VERDICT: READY`.
- As work proceeds, update:
  - this file (checkboxes + Status),
  - `ROADMAP.md` (milestone status),
  - and create/refresh local review packets under `team/reviews/`.

## Milestones

### M8 — Distill “consensus vs disagreement” across dual-model outputs

**Status:** done

**Why (agent pain point):**
- After N≈10^2–10^3 papers, “what’s common” and “where models disagree” must be visible and auditable.

**Skill deliverables**
- `scripts/bin/distill_discussion_logic.py` (deterministic; no embeddings; no network required)
  - Input: a discussion-logic run directory (`--out-dir` containing `packs/*/{claude,gemini}.md`)
  - Output (written under that run directory):
    - `distill/CONSENSUS.md` (patterns supported by both models; with counts)
    - `distill/DISAGREEMENTS.md` (systematic model divergences; with paper IDs)
    - `distill/STATS.json` (counts + summary)
- Deterministic text normalization rules for counting patterns (documented).

**Agent deliverables**
- Manual merge of selected high-confidence patterns into `assets/style/physics_discussion_logic_playbook.md`
  - with explicit note if a pattern is “hep-ph-heavy” vs cross-subfield.

**Tests / gates**
- Add offline fixture with 2 papers + stub outputs and validate deterministic `distill/` outputs.
- Dual-review gate: reviewers see (a) outputs, (b) acceptance criteria met.

**Progress checklist**
- [x] Implement `distill_discussion_logic.py`
- [x] Add fixture + smoke coverage
- [x] Create local review packet + dual-review

---

### M9 — Paper skeleton upgrade (sections + provenance + UNVERIFIED registry)

**Status:** planned

**Skill deliverables**
- `paper/sections/*.tex` scaffold (intro/formalism/results/discussion/appendix)
- `paper/provenance_table.tex` generated from `artifacts/` manifests/summaries
- `paper/UNVERIFIED.md` generated as a registry placeholder (agent fills/curates)

**Agent deliverables**
- Convert derivation notebook into narrative structure:
  - select “core argument loop” mapping (Question→Mechanism→Approach→Results→Diagnostics→Comparison→Limitations→Outlook)
- Populate `UNVERIFIED` entries when needed (plan + kill criterion).

**Tests / gates**
- Extend minimal fixture project with:
  - one “headline result” in artifacts,
  - one UNVERIFIED placeholder in knowledge base,
  - verify scaffolding wires to correct paths.

**Progress checklist**
- [ ] Update scaffold templates + generator logic
- [ ] Update fixture and smoke tests
- [ ] Dual-review gate

---

### M9G — Research-writer guardrails (anti-hallucination evidence gate)

**Status:** done

**Why (real failure mode):**
- When revising drafts, LLMs may add plausible-sounding but false provenance details (e.g., “data taken from X” or “uniform errors added”) without evidence.

**Skill deliverables**
- Guardrails system prompt asset:
  - `assets/style/research_writer_guardrails_system_prompt.txt`
- Deterministic linter for revision additions:
  - `scripts/bin/check_latex_evidence_gate.py`
  - Scans `\\revadd{...}` blocks and flags risky provenance/uncertainty claims lacking:
    - `Table/Fig/Eq/Sec/...` + `\\cite{...}`, OR
    - a project-local evidence path (e.g., `paper_audit/data/...`, `artifacts/...`).

**Agent deliverables**
- Use the guardrails prompt for revision passes.
- When a needed evidence anchor is missing, keep text unchanged and add a TODO/question rather than guessing.

**Tests / gates**
- Smoke test includes a failing example (unanchored risky `\\revadd{...}`) and a passing anchored example.
- Dual-review gate.

**Progress checklist**
- [x] Add guardrails prompt asset
- [x] Add evidence-gate checker + smoke coverage
- [x] Create review packet + dual-review

---

### M9D — `draft_sections` (writer → auditor; opt-in, human-friendly)

**Status:** done

**Why (human UX + automation):**
- Two unmerged drafts (one per model) are often unusable for humans.
- A writer→auditor pipeline can produce a single coherent draft while still preserving raw outputs and running deterministic gates.

**Skill deliverables**
- `scripts/bin/research_writer_draft_sections.py` (+ `.sh` wrapper)
  - Opt-in: does not call models unless `--run-models` (or `--stub-models` for offline).
  - Output bundle under `paper/drafts/<run-id>/`:
    - `draft_<section>_writer.tex`
    - `draft_<section>_final.tex`
    - `draft_<section>.diff`
    - `trace.jsonl` + `run.json`
    - On evidence-gate failure: `draft_<section>_unsafe.tex` + `evidence_gate_report_<section>.md`
- Evidence gate is enforced on the final draft:
  - Use `check_latex_evidence_gate.py --scan-all --fail` for new drafts by default.

**Agent deliverables**
- Provide judgment-heavy inputs:
  - which sections to draft first, and with what scope;
  - which external claims must be labeled `UNVERIFIED` vs validated.
- Decide whether/when to integrate `*_final.tex` into `paper/main.tex` (manual step).

**Tests / gates**
- Smoke:
  - `--stub-models --stub-variant safe` produces drafts and passes evidence gate.
  - `--stub-models --stub-variant unsafe` fails evidence gate and writes a report, without breaking the overall smoke suite.
- Dual-review gate: reviewers must confirm the UX default is human-friendly and the gate is enforced.

**Progress checklist**
- [x] Implement CLI + outputs + trace logs
- [x] Add smoke coverage
- [x] Dual-review gate

---

### M10 — Quality gate beyond compilation (logs + undefined refs/cites + bib health)

**Status:** planned

**Skill deliverables**
- `scripts/bin/paper_quality_gate.sh` (or `.py`)
  - If `latexmk` exists: parse `main.log` and report counts (non-failing by default)
  - Provide `--fail-on` options for CI-like strictness (optional)

**Agent deliverables**
- Interpret warning summaries and decide whether they matter for the project stage.

**Tests / gates**
- Smoke: in TeX environments, ensure gate reports counts deterministically; otherwise `SKIPPED`.

**Progress checklist**
- [ ] Implement quality gate
- [ ] Integrate into RUNBOOK + optional smoke hook
- [ ] Dual-review gate

---

### M11 — Performance hardening for large corpora (optional, driven by need)

**Status:** planned

**Skill deliverables (examples)**
- Make `trace.jsonl` summaries O(1) or near-O(1) for very large runs:
  - tail-seek or maintain a compact run-state file
- Optional: CLI overrides for `_find_main_tex` ambiguity (`--main-tex-hint` per paper)

**Agent deliverables**
- Decide if/when to enable these knobs based on observed failure modes.

**Progress checklist**
- [ ] Benchmark on a large run directory
- [ ] Implement the smallest needed optimizations
- [ ] Dual-review gate
