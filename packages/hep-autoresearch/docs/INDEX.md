# Documentation index (English)

This repository is **bilingual-in-progress**. English is the default for international release; Chinese versions are preserved for bilingual publishing.

If a document has both languages, we use:
- `*.md` for English
- `*.zh.md` for Chinese

## Entry points

- Beginner tutorial: `docs/BEGINNER_TUTORIAL.md` (EN) / `docs/BEGINNER_TUTORIAL.zh.md` (Chinese)
- Vision & scope: `docs/VISION.md` (EN stub) / `docs/VISION.zh.md` (Chinese)
- Architecture: `docs/ARCHITECTURE.md` (EN stub) / `docs/ARCHITECTURE.zh.md` (Chinese)
- Roadmap: `docs/ROADMAP.md` (EN stub) / `docs/ROADMAP.zh.md` (Chinese)

## External project scaffold

Use `autoresearch init` in your **research project directory**. `autoresearch` is now the canonical generic lifecycle entrypoint for `init/status/approve/pause/resume/export`, while `hep-autoresearch` / `hepar` / `hep-autopilot` remain the transitional Pipeline A legacy surface for unrepointed commands such as `run`, `doctor`, and `bridge`. `autoresearch init` stays a thin composition shell over the existing scaffold authority and scaffolds the project-local files below:

- Project charter: `project_charter.md`
- Project index: `project_index.md`
- Research plan: `research_plan.md`
- Research notebook: `research_notebook.md`
- Research contract: `research_contract.md`
- Provider-neutral MCP example: `.mcp.json.example`
- Runtime state / policy: `.autoresearch/`
- Project-local docs / schemas: `docs/`, `specs/`

These are **external project assets**. They are not maintained at this package repo root.

## Package docs

- Toolkit API boundary: `TOOLKIT_API.md` (EN) / `TOOLKIT_API.zh.md` (Chinese)
- Knowledge base overview: `knowledge_base/README.md` (EN) / `knowledge_base/README.zh.md` (Chinese)
- Evals overview: `evals/README.md` (EN) / `evals/README.zh.md` (Chinese)

## Reliability & contracts

- Artifact contract (SSOT): `docs/ARTIFACT_CONTRACT.md` (EN) / `docs/ARTIFACT_CONTRACT.zh.md` (Chinese)
- Approval gates (safe defaults): `docs/APPROVAL_GATES.md` (EN) / `docs/APPROVAL_GATES.zh.md` (Chinese)
- Eval suite: `docs/EVALS.md` (EN stub) / `docs/EVALS.zh.md` (Chinese) and `docs/EVAL_GATE_CONTRACT.md` (EN) / `docs/EVAL_GATE_CONTRACT.zh.md` (Chinese)

## computation / run_card v2

- computation user guide: `docs/COMPUTATION.md` (EN) / `docs/COMPUTATION.zh.md` (Chinese)
- Examples / project plugins: `docs/EXAMPLES.md` (EN) / `docs/EXAMPLES.zh.md` (Chinese)

## Orchestrator UX

- Interaction model: `docs/ORCHESTRATOR_INTERACTION.md` (EN) / `docs/ORCHESTRATOR_INTERACTION.zh.md` (Chinese)
- State model: `docs/ORCHESTRATOR_STATE.md` (EN) / `docs/ORCHESTRATOR_STATE.zh.md` (Chinese)

## Decisions (ADR)

- ADR index: `docs/decisions/` (EN + Chinese per file)
- ADR-001: `docs/decisions/ADR-001-beads.md` (EN) / `docs/decisions/ADR-001-beads.zh.md` (Chinese)

## Ecosystem integration

- Integration contract (this repo ↔ skills ↔ MCP): `docs/ECOSYSTEM_INTEGRATION.md` (EN stub) / `docs/ECOSYSTEM_INTEGRATION.zh.md` (Chinese)
- Improvement backlog (no cross-repo edits here): `docs/ECOSYSTEM_TOOL_IMPROVEMENTS.md` (EN stub) / `docs/ECOSYSTEM_TOOL_IMPROVEMENTS.zh.md` (Chinese)
- Ecosystem bundle (release artifact): `docs/ECOSYSTEM_BUNDLE.md` (EN) / `docs/ECOSYSTEM_BUNDLE.zh.md` (Chinese)

## Workflows

Start from `docs/WORKFLOWS.md` (EN stub) / `docs/WORKFLOWS.zh.md` (Chinese), then see `workflows/`.
