# idea-generator (design repo) — Agent Notes

This repository is a **design / architecture workspace** for an `idea-generator` agent (HEP-first, extensible to broader theoretical physics). It is **not** a research-run project directory.

## Repo hygiene (important)

- **Do not leave `research-team` scaffolds** (projects/runs/artifacts trees) in this repo. If you must use `research-team`, create it in a temporary location (e.g. `/tmp/...`) and only copy back **summaries/design docs**.
- Prefer **evidence-first**: capture claims as actionable design rules + link to primary sources (arXiv/ACL/etc.) in `docs/`.
- Keep outputs **architecture-first** (interfaces/contracts/plugins) rather than model-specific prompt hacks.
- Checked-in `docs/plans/examples/**` must stay **generic, minimal, and reusable**. Do not copy examples verbatim from `idea-runs`, prior campaigns, or local pilot artifacts.

## Where to write things

- Design iterations and durable checked-in summaries: `docs/plans/` (date-stamped Markdown)
- Local multi-agent consultation outputs and review workflow files must stay outside the repo; distill durable conclusions back into `docs/plans/`.

## Progress tracking (rules)

- **Single Source of Truth (SSOT)**: track implementation progress only in `docs/plans/2026-02-12-implementation-plan-tracker.md`.
- The tracker records **package-level design / contract / implementation progress only**. Do not turn it into a run diary, board-sync log, or scientific campaign notebook.
- **No new trackers**: do not create parallel TODO lists in other docs; instead, link to the SSOT tracker and update it.
- **Update discipline**: any non-trivial design change that affects scope, interfaces, or gates must include:
  - a status update in the tracker (checkboxes / task table), and
  - an append-only entry in the tracker’s **Update Log** (date-stamped).
- **Research-quality bar**: mark tasks DONE only with auditable evidence (schemas/tests/sample artifacts/review outputs), not “it seems to work”.

## Skills index (available in this Codex session)

| Skill | What it’s for | Path |
|---|---|---|
| `review-swarm` | Dual-agent loop (Claude + Gemini), strict output contract + convergence gate | `$CODEX_HOME/skills/review-swarm/SKILL.md` |
| `claude-cli-runner` | Run local `claude` CLI one-shot; write output to file | `$CODEX_HOME/skills/claude-cli-runner/SKILL.md` |
| `gemini-cli-runner` | Run local `gemini` CLI one-shot; write output to file | `$CODEX_HOME/skills/gemini-cli-runner/SKILL.md` |
| `research-team` | Milestone-based parallel research workflow (Claude+Gemini), reproducible artifacts | `$CODEX_HOME/skills/research-team/SKILL.md` |
| `research-writer` | RevTeX4-2 paper scaffold/validation; provenance wiring + BibTeX hygiene | `$CODEX_HOME/skills/research-writer/SKILL.md` |
| `hepar` | Control plane for evidence-first research runs (init/status/run/export/…) | `$CODEX_HOME/skills/hepar/SKILL.md` |
| `hep-calc` | HEP calculation audit runner (Mathematica/Julia; diagrams/amplitudes) | `$CODEX_HOME/skills/hep-calc/SKILL.md` |
| `pdg-lookup` | PDG local DB lookups (properties/decays/measurements/refs) | `$CODEX_HOME/skills/pdg-lookup/SKILL.md` |
| `referee-review` | Offline referee-style review report (Markdown + strict JSON) | `$CODEX_HOME/skills/referee-review/SKILL.md` |
| `zotero-import` | Two-step Zotero import pipeline (`zotero_add` → `zotero_confirm`) | `$CODEX_HOME/skills/zotero-import/SKILL.md` |
| `sci-hub` | Download papers not on arXiv (DOI/URL/PMID/query); Zotero integration | `$CODEX_HOME/skills/sci-hub/SKILL.md` |
| `md-toc-latex-unescape` | Fix LaTeX escaping inside Markdown TOC blocks | `$CODEX_HOME/skills/md-toc-latex-unescape/SKILL.md` |
| `deep-learning-lab` | Reproducible DL research scaffold (configs, provenance, artifacts/runs) | `$CODEX_HOME/skills/deep-learning-lab/SKILL.md` |
| `paper-reviser` | Content-first LaTeX paper revision (diff + tracked changes) | `$CODEX_HOME/skills/paper-reviser/SKILL.md` |
| `skill-installer` | Install additional Codex skills from curated list or GitHub repo | `$CODEX_HOME/skills/.system/skill-installer/SKILL.md` |
| `skill-creator` | Create/update a Codex skill (specialized workflows/tool integrations) | `$CODEX_HOME/skills/.system/skill-creator/SKILL.md` |

## Practical notes (for this repo)

- **Paper intake policy (SSOT, source-first):** for arXiv papers, prefer **LaTeX source** over PDF whenever available (arXiv source submissions are compile-able and typically include figures). Use the **`hep-research` MCP** tool `inspire_paper_source` with `prefer=latex` (PDF only as fallback when the submission is **PDF-only** or source retrieval is blocked). Ensure downloaded sources stay outside this repo (HEP data area or `/tmp`).
- When adding “discovery theory” (philosophy/history) content, translate it into **executable operators** (seed generators, mutation operators, validators, scoring/ranking rules) and place into the architecture docs.
- **Markdown math (KaTeX discipline):**
  - Put LaTeX math in math environments: inline `$...$` or display `$$...$$` (not in backticks/code fences).
  - Use backticks for **code identifiers/fields** (e.g., `max_tokens`, `cost_usd`, `BudgetEnvelope.extensions`), not for math.
  - Avoid raw `$` for currency in prose/code; write `USD`/`cost_usd` instead to prevent KaTeX parse errors.
  - If you must show a literal dollar sign outside math, escape it as `\$`.

## “Don’t reinvent” checklist (deep reading / evidence)

- **HEP literature (LaTeX-first):** `hep-research` MCP `inspire_paper_source(prefer=latex, extract=true)` → `inspire_parse_latex(components=[...])` → (optional) `inspire_deep_research(mode=analyze|synthesize)` for structured extraction.
- **Batch fetch (offline-friendly):** `research-team` `scripts/bin/literature_fetch.py arxiv-source` downloads arXiv LaTeX sources to `references/arxiv_src/<id>/` (use `/tmp/...`, do not scaffold inside this repo).
- **Paper-style tooling:** `research-writer` has deterministic hygiene + optional reading-pack/distill helpers; use it for *presentation/consistency*, not as a substitute for evidence extraction.
- **Network/proxy (this machine):** if web fetch is flaky, set `https_proxy/http_proxy/all_proxy` (e.g. `127.0.0.1:7890`) before calling networked tools/CLIs.
- **Mandatory before `git push`:** always export `https_proxy`, `http_proxy`, and `all_proxy` in the current shell before any `git push` on this machine. Current default:
  - `https_proxy=http://127.0.0.1:7890`
  - `http_proxy=http://127.0.0.1:7890`
  - `all_proxy=socks5://127.0.0.1:7890`
