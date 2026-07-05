---
name: paper-reviser
description: Content-first revision for academic papers written in LaTeX (read-through -> line edit -> clean + diff + tracked delivery contract -> audit + verification requests).
metadata:
  short-description: Content-first paper revision for LaTeX drafts (clean + diff + tracked)
---

# Paper Reviser (LaTeX)

Use this skill when you want an “advisor-like” pass over a LaTeX draft:
- prioritize **correctness/precision of statements** (content first),
- improve structure/flow and English while **preserving the author’s voice**,
- output both a **clean draft** and **auditable revision artifacts** (diff plus tracked-delivery contract),
- and generate **verification requests** for simple, high-impact statements.

This skill is intentionally **not** part of `research-writer`:
- `research-writer` is for producing an arXiv-ready RevTeX paper scaffold and provenance wiring.
- `paper-reviser` is for content-first revision of a paper draft (any class/template), usually earlier in the writing loop.

## What It Produces

Given `draft.tex`, the tool writes a run directory containing:
- `original.tex` (normalized baseline copy)
- `clean.tex` (edited clean draft; preserves preamble for full documents)
- `changes.diff` (unified diff: original → clean)
- `tracked.tex` (full-document only, and only when a real `latexdiff` run succeeds)
- `tracked_fragment_audit.tex` (fragment-only audit view; never a valid tracked delivery)
- `changes.md` (detailed list of changes + rationale)
- `open_questions.md` (items needing author confirmation / external verification)
- `readthrough.md` (global understanding: what the draft claims + structure/notation inventory)
- `risk_flags.md` (high-risk statements: overclaims/ambiguity/missing citations)
- `global_style_notes.md` (style/notation consistency notes)
- `audit.md` (independent auditor verdict + actionable feedback)
- `response_revision_audit.md` (brief audit artifact: response-localization mapping, tracked-delivery status, clean/latexdiff PDF verification status, correction-convergence note)
- `verification_requests.md` (concrete “please verify” items + suggested search queries)
- `verification_requests.json` (machine-readable form for orchestration; schema_version=1)
- `deep_verification.md` (step-by-step derivation/maths verification driven by `verification_requests.md`; uses local `codex` CLI)
- `deep_verification_secondary.md` (optional: second independent derivation/maths verifier via `--secondary-deep-verify-*`)
- `run.json` + `trace.jsonl` (auditable run metadata + command trace)

## Workflow (Human-Like)

1) **Read-through (no rewriting)**: understand the draft globally and identify risk points.
2) **Writer line edit**: produce an evidence-calibrated rewrite with global coherence.
3) **Auditor pass** (independent): critique correctness/evidence/LaTeX safety; run claim-strength audit, literature/novelty gate, and response-localization checks; emit verification requests.
4) **Deep verification (Codex CLI by default; pluggable backend)**: step-by-step derivation/maths checks based on `verification_requests.md`. The `codex` CLI is the default backend; switch it with `--secondary-deep-verify-backend gemini` (or the `claude` fallback).
   - Optional: run a **secondary** deep verifier (Gemini/Claude) for redundancy via `--secondary-deep-verify-*`.
5) **Optional repair loop**: apply reviewer feedback (audit + deep verification), re-audit and re-verify (bounded by `--max-rounds`).

## Input Modes: Full Document vs Fragment

The tool auto-detects whether the input is a full LaTeX document:
- **Full document**: first uncommented `\\begin{document}` exists.
  - The tool treats the preamble as **read-only** and only edits the body.
  - `clean.tex = (original preamble) + (edited body)`.
  - `tracked.tex` is valid only if `latexdiff` succeeds. Missing/failed/empty `latexdiff` is **fail-closed / NOT_READY**; comment-only fallback is forbidden.
- **Fragment**: no `\\begin{document}`.
  - The tool edits the entire fragment as-is.
  - The tool may emit `tracked_fragment_audit.tex`, but that artifact is audit-only and must not be treated as `tracked.tex` or as a real latexdiff delivery.

## Quick Start

Set paths once:

```bash
SKILLS_DIR="${SKILLS_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills" ] && echo "$r/skills" && break; done || true)}"
PAPER_REVISER="$SKILLS_DIR/paper-reviser"
RESEARCH_TEAM="$SKILLS_DIR/research-team"
```

### 1) Smoke test (no model calls)

```bash
python3 "$PAPER_REVISER/scripts/bin/paper_reviser_edit.py" \
  --in /path/to/draft.tex \
  --out-dir /tmp/paper_reviser_out \
  --stub-models
```

### 2) Real run (opus writer + independent Gemini auditor)

```bash
python3 "$PAPER_REVISER/scripts/bin/paper_reviser_edit.py" \
  --in /path/to/draft.tex \
  --out-dir /tmp/paper_reviser_out \
  --run-models \
  --writer-backend claude --writer-model opus \
  --auditor-backend gemini --auditor-model <GEMINI_MODEL>
```

Writer/auditor backends: `--writer-backend` / `--auditor-backend` accept any of `{claude, gemini, codex, opencode, kimi}` (defaults writer=`claude`, auditor=`gemini`). The auditor pass is independent — prefer a family OTHER than the writer's for genuine cross-family review. `--fallback-auditor` and `--secondary-deep-verify-backend` accept the same set. Each backend auto-resolves its `<family>-cli-runner`; `--auditor-model <GEMINI_MODEL>` is a placeholder — omit it to track the backend CLI's configured default.

Common optional flags:
- `--max-rounds 2` (allow one repair cycle after the first audit)
- `--context-file evidence.md` (append extra notes/citations for the writer to use; see Verification Loop)
- `--context-dir evidence/` (append multiple evidence files (*.md/*.txt), name-sorted; good for orchestration)
- `--mode fast` (quick revision mode: skip deep derivation/maths verification; still runs writer + auditor; also disables secondary deep verification)
- `--no-codex-verify` (skip deep derivation verification; not recommended if you care about physics/maths correctness)
- `--fallback-auditor claude --fallback-auditor-model <MODEL>` (fallback when Gemini auditor output is empty/malformed)
- `--secondary-deep-verify-backend gemini --secondary-deep-verify-model <MODEL>` (optional redundancy: a second step-by-step checker)
- `--codex-timeout-seconds 900` (hard timeout for `codex exec` deep verification)
- `--codex-timeout-policy stub|allow-secondary|fail` (timeout handling policy)
- `--force` (overwrite an existing `--out-dir`)

Robustness notes:
- Auditor END-only marker recovery: if `AUDIT_MD` has END but misses BEGIN, the tool can recover it as an implicit BEGIN case.
- Gemini auditor malformed/empty output: the tool retries once with a stricter marker reminder; if still bad and `--fallback-auditor=claude` is enabled, it falls back automatically.
- Clean-size guard is adaptive: `--min-clean-size-ratio` now considers both raw bytes and non-comment bytes (best-effort comment stripping), reducing false positives on comment-heavy drafts.
- Deep verifier timeout is auditable: on timeout (policy `stub` / `allow-secondary`), `deep_verification.md` is written as `VERDICT: NOT_READY` with timeout cause.
- Latexdiff delivery is fail-closed for full documents: if `latexdiff` is missing, fails, or returns empty output, the run records `tracked_delivery.status = not_ready`, forces `audit.md` to `NOT_READY`, and does not write a fake `tracked.tex`.
- Latexdiff repair/verification contract: this repo tool only records `tracked_delivery`, `repair_loop`, and compile-verification audit state in `run.json`; it does not provide a generic TeX compile/fix runtime. Clean/latexdiff PDF compilation, real log reading, and bounded repair attempts belong to the use-time agent inside the concrete paper project.
- If the use-time agent did not run clean/latexdiff PDF verification, `run.json` must stay explicitly unverified (`not_run` / `not_ready`) rather than pretending success.

## Verification Loop (Optional, Recommended)

After a run:
1) Read `verification_requests.md`.
   - For orchestration, prefer `verification_requests.json` (machine-readable).
2) Do quick literature checks (or ask another tool/skill/MCP workflow to search).
3) Write the results into a context file (e.g. `evidence.md`) with:
   - the verified reference(s),
   - a 1-2 sentence justification,
   - and any exact wording constraints you want enforced.
4) Re-run with `--context-file evidence.md` (and optionally `--max-rounds 1`):

```bash
python3 "$PAPER_REVISER/scripts/bin/paper_reviser_edit.py" \
  --in /path/to/draft.tex \
  --out-dir /tmp/paper_reviser_out_r2 \
  --run-models \
  --writer-backend claude --writer-model opus \
  --auditor-backend gemini --auditor-model <GEMINI_MODEL> \
  --context-file /path/to/evidence.md \
  --max-rounds 1
```

### Build a research-team verification plan (JSON)

To help a research workflow orchestrate literature verification, you can convert
`verification_requests.json` into a deterministic plan of `research-team` `literature_fetch.py` commands:

```bash
python3 "$PAPER_REVISER/scripts/bin/build_verification_plan.py" \
  --in /tmp/paper_reviser_out/verification_requests.json \
  --out /tmp/paper_reviser_out/verification_plan.json \
  --kb-dir verification/knowledge_base/literature \
  --trace-path verification/knowledge_base/methodology_traces/literature_queries.md \
  --arxiv-src-dir verification/references/arxiv_src
```

Then execute the plan tasks (typically under an approval gate) and write per-item evidence notes.
Finally re-run `paper-reviser` with either `--context-file evidence.md` or `--context-dir evidence/`.

## Contract Highlights

- Evidence-calibrated revision contract: do not default to hedging. Keep strong supported statements, strengthen underclaimed text when evidence warrants it, and weaken only for genuine evidence/logic/literature gaps.
- Referee-response mode contract: detected from context/structure rather than file naming; referee comments are read-only, only author responses/manuscript revisions may change, and every `we revised/clarified/added/corrected` declaration must be localized to the shortest sufficient manuscript location.
- Claim-strength audit + literature/novelty gate: novelty claims require full-text support, not title/abstract/metadata-only checks.
- Author color versus latexdiff color contract: author color remains an independent semantic layer; diff colors must stay distinct so colored insertions/deletions remain visible.
- Correction-convergence contract: bounded repair rounds must resolve blockers with the smallest sufficient edit and no silent fallback success.

### HEP literature checks (INSPIRE/arXiv)

For high-energy physics (and nearby fields), a practical workflow is:

1) Use `research-team`’s `literature_fetch.py` to search INSPIRE / arXiv and download arXiv LaTeX sources:

```bash
# INSPIRE search (returns candidate records)
python3 "$RESEARCH_TEAM/scripts/bin/literature_fetch.py" \
  inspire-search --query "t:your topic AND date:2020->2026" -n 5

# Fetch one INSPIRE record (optional: write a KB note under knowledge_base/)
python3 "$RESEARCH_TEAM/scripts/bin/literature_fetch.py" \
  inspire-get --recid 1234567 --write-note

# Download arXiv LaTeX sources (stored under references/arxiv_src/<arxiv_id>/)
python3 "$RESEARCH_TEAM/scripts/bin/literature_fetch.py" \
  arxiv-source --arxiv-id 2101.01234 --out-dir references/arxiv_src
```

2) Skim the downloaded source (TeX/PDF) and write a short `evidence.md` explaining what is supported/unsupported.
3) Re-run `paper-reviser` with `--context-file evidence.md` so the writer can tighten or correct the statements.

If you are already running inside an agent environment with `hep-mcp` / `@nullius/hep-mcp`, you can also use its INSPIRE/arXiv retrieval tools (search + source download) and then feed the results into `--context-file`. (Keep the editing step separate from the retrieval step for auditability.)

## Safety/Scope Notes

- The tool **may strengthen/add claims** when evidence supports them; this is an evidence-calibrated workflow, not a default-conservative or default-hedging workflow.
- Complex computation verification is **out of scope**; the tool instead produces `open_questions.md` / `verification_requests.md`.
- LaTeX safety is best-effort. The tool attempts to prevent edits inside verbatim-like environments (verbatim/lstlisting/minted/comment), but you should still compile-check after edits.
- This repo is **not** a general TeX compile/repair engine. When using the skill in a real paper project, the agent should run LaTeX compilation there, read the actual log, and apply the smallest auditable repair needed (latexdiff options, preamble/macros, or minimal post-processing).
- If you need preamble changes (packages/macros), the tool will usually propose them in `changes.md`; apply them manually (preamble is preserved in full-document mode).
- The tool operates on a **single `.tex` file** at a time. For multi-file projects using `\\input{}`/`\\include{}`, run it per file (or on a pre-concatenated version). Orphan-ref warnings may be false positives when labels live in other files.
- Defaults (override as needed): `--encoding utf-8`, `--min-clean-size-ratio 0.85`, `--max-rounds 1`, `--codex-timeout-seconds 900`, `--codex-timeout-policy stub`.
- For full documents, `tracked.tex` is valid only when produced by real `latexdiff`. If that delivery is unavailable, the run must stay `NOT_READY` instead of substituting a comment-only fallback.
- For full documents, if `clean.tex` compiles, the use-time agent should make a real attempt to compile the latexdiff PDF as well. If that diff build fails, read the log and try the smallest auditable fix; do **not** substitute the clean PDF for the diff PDF.

## Dev Smoke Tests (Local)

```bash
bash "$PAPER_REVISER/scripts/dev/run_smoke_tests.sh"
```
