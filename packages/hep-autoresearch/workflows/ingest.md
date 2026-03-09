# ingest — Paper ingestion

Chinese version: `workflows/ingest.zh.md`.

## Goal

Turn “find paper / fetch sources / write a reading note / record suspicious points” into a stable, batchable, regression-testable workflow.

## Inputs

At least one of:
- `inspire_recid`
- `arxiv_id`
- `doi`
- `query` (discovery only; final selection must land on a stable anchor)

Optional:
- `refkey` (if omitted, auto-generated, but must be stable/reproducible)

## Outputs (artifacts)

Required:
- `knowledge_base/literature/<refkey>.md` (reading note)
- `knowledge_base/methodology_traces/literature_queries.md` (append-only log)

Recommended:
- `references/<anchor>/` (source snapshot: LaTeX/PDF/metadata)
- `artifacts/runs/<TAG>/ingest/manifest.json` (auditable fetch+write provenance)

## Steps (MVP)

1) Normalize inputs into a stable anchor (prefer INSPIRE recid → arXiv → DOI).
2) Fetch metadata (title/authors/date/links).
3) Download sources (prefer LaTeX; fall back to PDF).
4) Generate a reading note:
   - RefKey / recid / citekey (if available) / links
   - `Verification status: metadata-only | skimmed | spot-checked | replicated | contradicted`
   - 3–7 key takeaways
   - 2–5 executable “suspicious points / to-verify items”
   - if `metadata-only`, explicitly list what must be read/checked next (“reading debt”)
5) Append one query-log entry (selection rationale + local note link).

## Gates (acceptance)

- Reading note contains `RefKey:` and `Links:` with clickable links.
- Reading note contains `Verification status:` (the ingest phase allows `metadata-only`, but downstream workflows must upgrade when they depend on the paper).
- If INSPIRE exists: must include `INSPIRE recid:` and `Citekey:` (if available).
- Any discovery (keywords/general search) must be logged (query → shortlist → rationale), and must end on a stable anchor.

## Extension roadmap

- v1: batch ingestion (N papers per request), generate an index page and a “to-verify queue”.
- v2: structured LaTeX extraction (symbol table, key equation/result locators) as inputs for reproduce / derivation-check workflows.

