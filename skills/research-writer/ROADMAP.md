# research-writer — Roadmap

## M0: Learn (FK writing voice)

Acceptance criteria:
- `assets/style/style_profile.md` captures recurring voice/structure conventions and explicitly includes skepticism + auditability requirements.
- `assets/style/writing_voice_system_prompt.txt` provides a compact drafting prompt consistent with the profile.
- `assets/style/physics_discussion_logic_playbook.md` captures general discussion logic distilled from exemplar papers (argument flow, diagnostics, uncertainty narration).
- No changes are made to the source Overleaf projects.

Status: done.

## M1: Design + scaffold

Acceptance criteria:
- Skill repo skeleton exists with required docs:
  - `SKILL.md`, `README.md`, `RUNBOOK.md`, `ROADMAP.md`
- Templates exist under `assets/`:
  - RevTeX4-2 `12pt,onecolumn` skeleton
  - BibTeX template
  - Reviewer prompt templates
- Smoke harness skeleton exists under `scripts/dev/` with a single entry `scripts/dev/run_all_smoke_tests.sh`.
- Reviewer system prompts exist and enforce the strict output contract.

## M2: End-to-end minimal working research-writer

Acceptance criteria:
- `bash scripts/bin/research_writer_scaffold.sh ...` generates a compilable RevTeX paper from a minimal fixture project.
- BibTeX hygiene is implemented (RevTeX4-2 `journal` workaround).
- Deterministic double-backslash math check exists and optional deterministic auto-fix works.
- `bash scripts/dev/run_all_smoke_tests.sh` passes locally:
  - CLI help works
  - fixture → `paper/` generation works
  - if `latexmk` exists: compilation succeeds; else: clear skip
  - runs the double-backslash-in-math check on generated outputs/templates

## M3: Discussion-logic learning pipeline (N=10)

Acceptance criteria:
- `scripts/bin/research_writer_learn_discussion_logic.py` prepares per-paper reading packs from an INSPIRE/arXiv LaTeX corpus (N=10 default).
- Packs include excerpt sections (Abstract/Intro/Conclusions) plus semantically curated diagnostics paragraphs, with deterministic fallback candidates and evidence pointers into the derived `flattened_main.tex`.
- Optional clean-room dual-model pass can be run (`--run-models`) without changing skill assets automatically.
- `bash scripts/dev/run_all_smoke_tests.sh` exercises the pack generator offline using deterministic fixtures (no network).

## M4: Apply N=10 patterns to the playbook

Acceptance criteria:
- `assets/style/physics_discussion_logic_playbook.md` includes additional high-yield, journal-agnostic discussion patterns observed in an N=10 exemplar set.
- `assets/style/style_sources_used.md` records the N=10 arXiv IDs used (audit trail; no corpus dump committed).
- No automatic mutation of playbook based on model outputs; merging remains an agent/human step for stability and anti-plagiarism hygiene.

## M5: Apply N=50 patterns to the playbook

Acceptance criteria:
- `assets/style/physics_discussion_logic_playbook.md` includes additional cross-subfield patterns observed in an N=50 exemplar set (e.g., error-budget narration, sensitivity-driven prioritization, triangulation).
- `assets/style/style_sources_used.md` records the N=50 arXiv IDs used (audit trail; no corpus dump committed).
- The corpus/packs pipeline supports batching/resume and optional model subset reruns (repair workflow).

Status: done.

## M6: Release readiness (N=96 corpus support)

Acceptance criteria:
- Core scaffold pipeline is usable (fixture smoke tests + latexmk compile where available).
- Discussion-logic pipeline supports batching/resume/repair and writes `PROGRESS.md`/`PROGRESS.json`.
- Corpus fetcher supports both tar/tar.gz and gzip single-file arXiv sources.
- Dual reviewer convergence indicates READY for real workflows.

Status: done.

## M7: Release polish (UX + robustness)

Acceptance criteria:
- `scripts/bin/research_writer_learn_discussion_logic.py` prints a short stdout summary at end-of-run (counts + missing outputs).
- `PROGRESS.md` includes a “last run” summary (processed/errors/skips) and a short error digest if any `paper_error` occurred.
- `scripts/bin/fetch_prl_style_corpus.py` retries on HTTP 429 with deterministic backoff (no jitter).
- `scripts/dev/run_all_smoke_tests.sh`:
  - offline-tests `--resume` selection,
  - offline-tests `--mode repair` without calling external LLM CLIs (`--stub-models`),
  - offline-tests gzip single-file arXiv sources (not tar),
  - if `latexmk` exists: confirms `main.pdf` and prints warning count (non-failing).
- Dual reviewer convergence indicates READY.

Status: done.

## M8+ (forward)

See `PLAN.md` for the forward plan with explicit **Skill vs Agent** responsibilities and a progress checklist.

M8 status: done.

M9G status: done.

## M9D: Draft sections (writer → auditor; opt-in)

Acceptance criteria:
- New CLI exists and `--help` works:
  - `bash scripts/bin/research_writer_draft_sections.sh --help`
- Safe default: no model calls unless `--run-models` is used (or `--stub-models` for offline).
- Human-friendly outputs: writer draft + auditor-revised final + diff + trace logs:
  - `paper/drafts/<run-id>/draft_*_writer.tex`
  - `paper/drafts/<run-id>/draft_*_final.tex`
  - `paper/drafts/<run-id>/draft_*.diff`
  - `paper/drafts/<run-id>/trace.jsonl` + `run.json`
- Evidence gate is enforced on final drafts:
  - On failure, final is renamed to `*_unsafe.tex` and `evidence_gate_report_*.md` is written.
- Smoke harness covers a safe stub run and an unsafe (expected-fail) stub run.

Status: done.
