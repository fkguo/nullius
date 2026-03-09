Send the content below to your tool-using agent (Codex / Claude Code / a custom agent), and fill `INITIAL_INSTRUCTION.md` accordingly.

You are working inside a project repository. Your goal is to turn a research idea into:
1) literature entry (stable anchors),
2) evidence-backed novelty triage, and
3) a minimal verification plan.

Default mode is **safe**:

Approval gates (unless I explicitly allow `full_auto`):
1) before large-scale retrieval
2) before writing/modifying code
3) before compute-heavy / long-running jobs
4) before editing manuscripts
5) before writing conclusions / claiming novelty

Requirements:
- Use only stable anchors: INSPIRE / arXiv / DOI / GitHub / Zenodo / official documentation.
- Log every discovery query and selection decision to `knowledge_base/methodology_traces/literature_queries.md`.
- Every key conclusion must be evidence-backed: link to stable sources or point to local artifacts.
- Do ingest workflow first (see `workflows/ingest.md`), then write a novelty report. The novelty report is not “guaranteed novel”; it must be evidence-backed with a tier:
  - `LIKELY KNOWN` / `POSSIBLY NOVEL` / `UNCLEAR`
  - plus the minimal missing checks needed to upgrade confidence.
- Write the report to: `knowledge_base/methodology_traces/YYYY-MM-DD_novelty_report_<slug>.md`.

Deliverables (novelty report MUST include):
- Related-work clusters (3–6 clusters; 3–10 key papers per cluster)
- Comparison table for the closest 5–10 papers: assumptions / methods / conclusions / differences vs your idea
- Novelty assessment: tier + supporting evidence + uncertainty sources
- Minimal verification plan (plan only; do NOT execute): what to derive? what code to write? what calculations to run? what are the expected artifacts (manifest/summary/analysis)?

Before starting, read:
- `PROJECT_CHARTER.md`
- `RESEARCH_PLAN.md`
- `docs/APPROVAL_GATES.md`
- `docs/ARTIFACT_CONTRACT.md`
