# Autoresearch Lab

English | [中文](./docs/README_zh.md)

Autoresearch Lab is the monorepo/workbench for the Autoresearch ecosystem: a domain-neutral, evidence-first research substrate, a runtime/control-plane nucleus, and independently composable provider packages. HEP is the first mature provider family in this repo, not the root identity.

## Root Scope

- Root = ecosystem entrypoint, governance surface, and local development workspace.
- `@autoresearch/orchestrator` = runtime/control-plane nucleus for run/workspace/task state.
- Provider packages such as `hep-mcp`, `openalex-mcp`, `arxiv-mcp`, `pdg-mcp`, and `zotero-mcp` remain leaf capabilities.
- The detailed workflow sections below document the current HEP-first provider surface; they do not redefine the root as a HEP-only product.

## Language Policy (Phase 4.11)

- `README.md` is English-first for canonical feature semantics.
- `docs/README_zh.md` is the synchronized Chinese reference.
- Bridge/alignment references: `docs/SKILL_MCP_BRIDGE.md`, `docs/STYLE_CORPUS_ALIGNMENT.md`.

## Package Overview

| Package | Role | Status |
| --- | --- | --- |
| `@autoresearch/orchestrator` | Runtime/control-plane nucleus for `.autoresearch` state, routing, approvals, and research-loop execution | Active |
| `@autoresearch/hep-mcp` | First mature provider family: INSPIRE-HEP + evidence-first HEP workflows (`hep_*`, `zotero_*`, `pdg_*`) (67 std / 95) | Active |
| `@autoresearch/openalex-mcp` | Standalone OpenAlex scholarly graph provider | Active |
| `@autoresearch/arxiv-mcp` / `@autoresearch/hepdata-mcp` | Literature/data providers composable with the ecosystem runtime | Active |
| `@autoresearch/pdg-mcp` / `@autoresearch/zotero-mcp` | Local offline/reference providers | Active |
| `idea-core` / `idea-engine` / `idea-mcp` | Idea evaluation and future TypeScript migration lane | In progress |
| `@autoresearch/shared` | Cross-package typed seams and utilities | Active |

## Current Local-First + Evidence-First Provider Stack

The most mature provider surface in this repo today is the HEP-first local-first workflow centered on **Project/Run** and `hep://` **MCP Resources**.

**Hard constraints (by design):**
- **Local MCP transport only**: stdio (`StdioServerTransport`) only; no HTTP transport/server.
- **Zotero Local API only**: `http://127.0.0.1:23119` (no Zotero Web API).
- **Evidence-first I/O**: large outputs are written as **run artifacts** and read via `hep://...` resources; tool results return **URIs + small summaries**.

**Recommended vNext workflow (high level):**
1. `hep_project_create` → `hep_run_create`
2. (Optional) Zotero: `hep_import_from_zotero` (mapping) and/or `hep_run_build_pdf_evidence` with `zotero_attachment_key` (loads PDF via Zotero Local API; can use `.zotero-ft-cache`)
3. Build evidence:
   - LaTeX → `hep_project_build_evidence`
   - PDF → `hep_run_build_pdf_evidence` (text/visual; Docling JSON is an optional backend input)
4. Writing with enforcement: `hep_render_latex` (verifier rejects missing/unauthorized citations)
5. Export:
   - Research pack: `hep_export_project` → `master.bib`, `report.(tex|md)`, `research_pack.zip`, `notebooklm_pack_*`
   - Publication scaffold: `hep_export_paper_scaffold` → `paper/` + `paper_scaffold.zip`
   - Publication round-trip (optional): `hep_import_paper_bundle` (imports finalized `paper/` back into run artifacts; `hep_export_project(include_paper_bundle=true)` can embed it into `research_pack.zip`)

## Current Provider Focus: HEP-First Deep Research

`@autoresearch/hep-mcp` is a **local-first, evidence-first** research and writing pipeline for HEP:

### 1. Build citable evidence (Project/Run)

- Download arXiv sources and/or ingest PDFs via Zotero Local API
- Parse LaTeX into structured blocks (sections, equations, figures/tables, citations)
- Persist large outputs as run artifacts and read them via `hep://...` resources (Evidence Catalog, PDF evidence, writing evidence)

### 2. Navigate the literature (INSPIRE)

- Search with safe pagination (`inspire_search` + `inspire_search_next`) or export large result sets (`hep_inspire_search_export`)
- Discover, map, and trace a field: `inspire_research_navigator(mode=discover|field_survey|topic_analysis|network|experts|connections|trace_source|analyze)`
- (Optional) Cross-check particle properties/measurements via offline PDG tools (`pdg_*`)

### 3. Run-based writing and export

- Draft Path: `hep_render_latex` → `hep_export_project`
- Publication scaffold: `hep_export_paper_scaffold` → *(external editing / research-writer)* → `hep_import_paper_bundle`

---

## Current HEP-First Use Cases

### Scenario A: Quickly Understand a New Field

> "I want to understand the development of nucleon structure research"

The AI will automatically:

1. Search related literature → Identify seminal papers
2. Build citation network → Find core papers
3. Generate research timeline → Show development trajectory
4. Identify domain experts → Recommend key authors

### Scenario B: Deep Analysis of Papers

> "Help me analyze the core methods and equations of these 5 papers"

The AI will automatically:

1. Download LaTeX source → Parse document structure
2. Extract all equations → Identify key formulas
3. Extract key sections + citation contexts → Summarize contributions and evidence
4. Identify methodology → Classify research approaches

### Scenario C: Discover Missing Important Literature

> "Based on my reading list, what important papers might I have missed?"

The AI will automatically:

1. Analyze citation network of existing papers
2. Discover highly relevant but not included papers
3. Identify "bridge papers" connecting different subfields
4. Recommend supplementary reading sorted by importance

### Scenario D: Track Emerging Research Directions

> "Which exotic hadron papers might represent paradigm shifts?"

The AI will automatically:

1. Detect papers with unusually high citation momentum
2. Calculate new entrant ratio (sociological signal)
3. Calculate disruption index (distinguish hype vs. real innovation)
4. Provide comprehensive confidence assessment with explanations

### Scenario E: Auto-Generate Structured Reviews

> "Help me generate a literature review on this topic"

The AI will automatically:

1. Deep analyze each paper's content
2. Group by methodology/timeline/impact
3. Extract key equations and core contributions
4. Generate Markdown review + BibTeX references

### Scenario F: Researcher Profile (Author Disambiguation + Portfolio Summary)

> "Help me analyze Zhang Hao's academic achievements"

Recommended tool call chain (prefer **BAI** / ORCID for disambiguation):

1. Resolve author identity (best: BAI; ok: ORCID; fallback: name search)
```json
{ "mode": "get_author", "identifier": "E.Witten.1" }
```
BAI (INSPIRE author identifier) is a stable disambiguation key like `E.Witten.1`.

2. List top papers for that author (BAI is disambiguation-safe)
```json
{ "query": "a:E.Witten.1", "sort": "mostcited", "size": 25, "format": "markdown" }
```
Pick paper `recid` values from the `IDs:` line for downstream calls.

3. Summarize the portfolio (timeline/topics/citations over the selected recids via `inspire_research_navigator(mode=analyze)`)
```json
{ "mode": "analyze", "recids": ["1234567", "2345678"], "analysis_type": ["overview", "timeline", "topics"] }
```

4. Deep-dive a key paper (verify LaTeX was actually fetched via `provenance.retrieval_level`)
```json
{ "mode": "content", "identifier": "1234567", "options": { "prefer": "latex", "extract": true } }
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                Autoresearch Lab (repo root)                │
│     ecosystem docs, governance, package composition        │
└───────────────┬───────────────────────────────┬────────────┘
                │                               │
                ▼                               ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│ @autoresearch/orchestrator   │   │ @autoresearch/shared     │
│ runtime / control-plane      │   │ typed seams / utilities  │
└───────────────┬──────────────┘   └──────────────┬───────────┘
                │                                 │
                ▼                                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Provider / domain packages                                 │
│ hep-mcp | openalex-mcp | arxiv-mcp | pdg-mcp | zotero-mcp  │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Local evidence + external APIs                             │
│ .autoresearch | HEP_DATA_DIR | OpenAlex | INSPIRE | PDG    │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
autoresearch-lab/
├── README.md
├── package.json              # workspace metadata
├── pnpm-workspace.yaml       # pnpm workspace
├── docs/                     # root docs
├── meta/                     # governance SSOT, prompts, redesign plan
├── packages/
│   ├── orchestrator/         # runtime / control-plane nucleus
│   ├── hep-mcp/              # HEP-first provider family
│   ├── openalex-mcp/         # OpenAlex provider
│   ├── arxiv-mcp/            # arXiv provider
│   ├── pdg-mcp/              # PDG provider
│   ├── zotero-mcp/           # Zotero provider
│   ├── idea-core/            # current Python idea engine
│   ├── idea-engine/          # future TypeScript idea engine
│   └── shared/               # cross-package contracts/utilities
```

## Quick Start

### Requirements

- Node.js >= 18.0.0
- pnpm >= 8.0.0

```bash
# Install pnpm if not already installed
npm install -g pnpm
```

### Install Dependencies

```bash
cd /path/to/autoresearch-lab
pnpm install
```

### Build

```bash
# Build all packages
pnpm -r build

# Or build specific package
pnpm --filter @autoresearch/shared build
```

### Verify Installation

```bash
cd packages/shared
pnpm exec tsx test-check.ts
```

### Writing Quick Start (Draft Path, ≤5 tool calls)

See:
- `docs/WRITING_RECIPE_DRAFT_PATH.md`
- `docs/WRITING_RECIPE_CLIENT_PATH.md`
- `docs/TOOL_CATEGORIES.md`

Minimal sequence:

```json
{ "tool": "hep_project_create", "args": { "name": "my-writing", "description": "draft-path" } }
```

```json
{ "tool": "hep_run_create", "args": { "project_id": "<project_id>" } }
```

```json
{
  "tool": "hep_run_build_citation_mapping",
  "args": {
    "run_id": "<run_id>",
    "identifier": "arXiv:XXXX.XXXXX",
    "allowed_citations_primary": ["inspire:<recid1>", "inspire:<recid2>"]
  }
}
```

```json
{ "tool": "hep_render_latex", "args": { "run_id": "<run_id>", "draft": { "...": "ReportDraft JSON here" } } }
```

```json
{ "tool": "hep_export_project", "args": { "run_id": "<run_id>" } }
```

## Tools Overview

This server exposes four tool families:
- **vNext local workflows**: `hep_*` (Project/Run, evidence, verifier-enforced writing, export)
- **Zotero local library tools**: `zotero_*` (Local API only)
- **Offline PDG tools**: `pdg_*` (local sqlite; optional)
- **INSPIRE research tools**: `inspire_*` (consolidated research + writing + safe pagination/export helpers)

Notes:
- `inspire_*` tools can be called directly (no Project/Run required). Projects/Runs and `hep://...` resources are for evidence-first local workflows (`hep_*`).

Tool counts: **67 tools in `standard` mode** (default, compact surface) and **95 tools in `full` mode** (adds advanced tools).

### Tool Exposure Modes

| Mode | Tools | Description |
|------|-------|-------------|
| `standard` | 67 | Default: compact, recommended |
| `full` | 95 | `standard` + advanced tools |

```bash
# Use full mode (optional)
export HEP_TOOL_MODE=full
```

### vNext + Zotero Tools (hep_* / zotero_*) — Evidence-First Local Workflows

These tools implement the **Project/Run + artifacts + `hep://` resources** workflow; Zotero tools (`zotero_*`) are optional local library management and return JSON directly (no `hep://` artifacts).

**vNext (selected)**
- `hep_project_create`: Create a local project → `hep://projects/{project_id}`
- `hep_project_get`: Get project metadata → `hep://projects/{project_id}`
- `hep_project_list`: List projects → `hep://projects`
- `hep_run_create`: Create a run (audited, reproducible) → `hep://runs/{run_id}/manifest`, `args_snapshot.json`
- `hep_project_build_evidence`: Build LaTeX Evidence Catalog v1 (project paper) → `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog`
- `hep_project_query_evidence`: Unified query of Evidence Catalog (`mode=lexical|semantic`, default `lexical`; `mode=semantic` requires `run_id` and supports `include_explanation`) → lexical hits or semantic run artifact (URI + summary)
- `hep_project_query_evidence_semantic`: Semantic query (requires run embeddings via `hep_run_build_writing_evidence`; writes diagnostics artifact) → `evidence_semantic_query_*.json` (URI + summary)
- `hep_project_playback_evidence`: Playback an evidence locator into a stable snippet → snippet text
- `hep_run_build_citation_mapping`: Build cite-mapping + allowlist artifacts for a run → `bibliography_raw.json`, `citekey_to_inspire.json`, `allowed_citations.json`
- `hep_run_build_measurements`: Extract structured measurements from run evidence → `hep_measurements_*.jsonl` + meta/diagnostics artifacts
- `hep_project_compare_measurements`: Compare measurements across multiple runs and flag pairwise tensions (flagging-only) → run artifact URI + summary
- `hep_render_latex`: Render structured draft → LaTeX, insert `\\cite{}`, and enforce verifier → `rendered_latex.tex`, `rendered_latex_verification.json`
- `hep_run_build_pdf_evidence`: PDF → Evidence v1 (text pages + optional visual region snippets) → `*_evidence_catalog.jsonl`, `*_page_*.png`, `*_region_*.png`
- `hep_export_project`: Export “research asset pack” for a run → `master.bib`, `report.(tex|md)`, `research_pack.zip`, `notebooklm_pack_*`
- `hep_export_paper_scaffold`: Export a publication-ready `paper/` scaffold (RevTeX4-2) → `paper_manifest.json`, `paper_scaffold.zip`
- `hep_import_paper_bundle`: Import a finalized `paper/` back into run artifacts → `paper_bundle.zip`, `paper_bundle_manifest.json`, (optional) `paper_final.pdf`
- `hep_import_from_zotero`: Map Zotero items → identifiers → INSPIRE recid → `zotero_map.json`

**Zotero (standard)**
- `zotero_local`: Unified Zotero Local API tool → JSON (collections/items; can resolve attachment/fulltext cache paths)
- `zotero_search_items`: Browse/search items → summarized items + `select_uri`
- `zotero_find_items`: Resolve items by identifiers + filters → `select_uri` + identifier digest
- `zotero_export_items`: Export items to BibTeX/CSL-JSON/RIS/etc → exported content (truncated) + sha256
- `zotero_get_selected_collection`: Resolve Zotero UI-selected collection → Local API `collection_key` + path
- `zotero_add`: Preview add/update → `confirm_token` (+ optional `select_uri`)
- `zotero_confirm`: Execute a previewed write → consumes `confirm_token`

> Note: full-only atomic `zotero_*` tools were removed; `zotero_local` is the single Zotero entrypoint (use `mode` for `list_collection_paths`, `list_tags`, `download_attachment`, `get_attachment_fulltext`, etc.).
> Phase 4.5 bridge note: `zotero_find_items` and `zotero_search_items` share an internal bridge executor while preserving verify-style vs browse-style semantics.

**Note on citation keys:** when multiple BibTeX keys map to the same recid, `hep_render_latex` selects the **lexicographically first** key (stable and deterministic).

### vNext Resources (`hep://...`) — How to Read Artifacts

Most vNext tools return **URIs**. Use MCP “resources” to read the actual files on disk.

| Resource URI | Meaning |
|--------------|---------|
| `hep://projects` | Project index (`hep_projects`) |
| `hep://projects/{project_id}` | Project manifest |
| `hep://projects/{project_id}/papers` | Paper list for a project |
| `hep://projects/{project_id}/papers/{paper_id}` | Paper manifest |
| `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog` | Evidence Catalog JSONL |
| `hep://runs` | Run index (list local runs) |
| `hep://runs/{run_id}/manifest` | Run manifest (steps + artifact refs) |
| `hep://runs/{run_id}/artifact/{name}` | Any run artifact (JSON/JSONL/TEX/PDF/PNG/ZIP/…) |
| `hep://corpora` | Style corpora index (list local corpora) |
| `pdg://info` | PDG resource info (server + artifact root metadata) |
| `pdg://artifacts` | PDG artifacts index (cache file list) |
| `pdg://artifacts/<name>` | Read a PDG artifact (text directly; binaries return metadata JSON) |

**Why the Resources list may look “small” (Iceberg model):** to avoid UI clutter, `resources/list` only exposes a few entrypoints (e.g. `hep://projects`, `hep://runs`, `pdg://artifacts`). Discover concrete artifact URIs by reading the index resources (or via `resources/templates/list` URI templates like `hep://runs/{run_id}/artifact/{artifact_name}`).

### Skill↔MCP Job Envelope (Phase 4.10)

For run-scoped responses (with `run_id`), dispatcher now adds a compact `job` envelope so skills and direct MCP clients share the same long-task polling contract:

```json
{
  "run_id": "run_xxx",
  "manifest_uri": "hep://runs/run_xxx/manifest",
  "job": {
    "version": 1,
    "job_id": "run_xxx",
    "status": "running",
    "status_uri": "hep://runs/run_xxx/manifest",
    "polling": {
      "strategy": "manifest_resource",
      "resource_uri": "hep://runs/run_xxx/manifest",
      "terminal_statuses": ["done", "failed"]
    }
  }
}
```

`job` is a bridge-level contract only; canonical evidence remains artifacts + resources. Failure semantics remain fail-fast (`INVALID_PARAMS + next_actions`).

### Recommended: Consolidated Tools (8)

These polymorphic tools cover most use cases with simple interfaces:

| Tool | Modes | Description |
|------|-------|-------------|
| `inspire_literature` | `get_paper` / `get_references` / `lookup_by_id` / `get_citations` / `search_affiliation` / `get_bibtex` / `get_author` | Unified INSPIRE “atomic” access (standard) |
| `inspire_resolve_citekey` | - | Resolve INSPIRE citekey + BibTeX + canonical links for recid(s) |
| `inspire_parse_latex` | `components=[sections/equations/theorems/citations/figures/tables/bibliography/all]` | Parse LaTeX into a run artifact (`run_id` required; returns URI + summary) |
| `inspire_deep_research` | `analyze` / `synthesize` | **Deep research & report generation** |
| `inspire_research_navigator` | `discover` / `field_survey` / `topic_analysis` / `network` / `experts` / `connections` / `trace_source` / `analyze` | Unified research navigation facade (Phase 3) |
| `inspire_critical_research` | `evidence` / `conflicts` / `analysis` / `reviews` / `theoretical` | Critical research (incl. theoretical debate map; `theoretical` requires `run_id`) |
| `inspire_paper_source` | `urls` / `content` / `metadata` / `auto` | Paper source access |
| `zotero_local` | `list_collections` / `list_collection_paths` / `list_items` / `get_item` / `get_item_attachments` / `download_attachment` / `get_attachment_fulltext` / `list_tags` | Unified Zotero Local API tool (standard; returns JSON) |

**Writing:** use the vNext `hep_*` writing workflows (`docs/WRITING_RECIPE_DRAFT_PATH.md`, `docs/WRITING_RECIPE_CLIENT_PATH.md`).

---

## Consolidated Tool Usage

### `inspire_deep_research` - Deep Research & Report Generation

The most powerful tool, supporting two modes:

#### Mode: `analyze` - Deep Content Analysis
```json
{
  "mode": "analyze",
  "identifiers": ["1833986", "627760"],
  "options": {
    "extract_equations": true,
    "extract_methodology": true,
    "extract_conclusions": true
  }
}
```
Returns: extracted components (e.g., equations, key sections) plus a compact summary.

#### Mode: `synthesize` - Review Synthesis
```json
{
  "mode": "synthesize",
  "identifiers": ["1833986", "627760"],
  "format": "markdown",
  "options": {
    "review_type": "methodology",
    "include_critical_analysis": true
  }
}
```
Returns: structured review grouped by methodology/timeline/comparison.

### `inspire_research_navigator` - Discovery/Survey/Network/Experts/Trace

#### Mode: `discover` - Foundational/Related/Expansion/Survey
```json
{
  "mode": "discover",
  "discover_mode": "seminal",
  "topic": "QCD sum rules",
  "limit": 20
}
```

#### Mode: `field_survey` - Physicist-Style Literature Survey
```json
{
  "mode": "field_survey",
  "topic": "nucleon structure",
  "limit": 30,
  "iterations": 2,
  "focus": ["open_questions", "controversies"]
}
```

#### Mode: `topic_analysis` - Timeline/Evolution/Emerging Trends
```json
{
  "mode": "topic_analysis",
  "topic": "pentaquark",
  "topic_mode": "timeline",
  "topic_options": { "granularity": "year" }
}
```

#### Mode: `network` - Citation/Collaboration Network Analysis
```json
{
  "mode": "network",
  "network_mode": "citation",
  "seed": "1833986",
  "network_options": { "depth": 2 }
}
```

#### Mode: `experts` - Domain Expert Discovery
```json
{
  "mode": "experts",
  "topic": "nucleon structure",
  "limit": 10,
  "format": "markdown"
}
```

#### Mode: `connections` - Cross-Paper Connection Mining
```json
{
  "mode": "connections",
  "seed_recids": ["1833986", "627760"],
  "include_external": true,
  "max_external_depth": 2
}
```

#### Mode: `trace_source` - Original Source Tracing
```json
{
  "mode": "trace_source",
  "seed": "1833986",
  "max_depth": 3,
  "cross_validate": true
}
```

#### Mode: `analyze` - Portfolio Analysis (Compatibility Path)
```json
{
  "mode": "analyze",
  "recids": ["1833986", "627760"],
  "analysis_type": ["overview", "timeline", "topics"]
}
```

### `inspire_critical_research` - Critical Analysis

#### Mode: `evidence` - Evidence Quality Grading
```json
{
  "mode": "evidence",
  "recids": ["1833986"]
}
```
Returns: evidence level (discovery/evidence/hint/indirect/theoretical).

#### Mode: `conflicts` - Conflict Detection
```json
{
  "mode": "conflicts",
  "recids": ["1833986", "627760"],
  "options": { "min_tension_sigma": 2 }
}
```
Returns: measurement conflicts with tension σ values.

#### Mode: `analysis` - Comprehensive Critical Analysis
```json
{
  "mode": "analysis",
  "recids": ["1833986"],
  "options": { "include_assumptions": true }
}
```

#### Mode: `reviews` - Review Classification
```json
{
  "mode": "reviews",
  "recids": ["1833986", "627760"]
}
```
Returns: review type (catalog/critical/consensus).

#### Mode: `theoretical` - Theoretical Debate Map (Run-based, Evidence-First)
```json
{
  "mode": "theoretical",
  "run_id": "<run_id>",
  "recids": ["1833986", "627760"],
  "options": {
    "subject_entity": "m_W",
    "inputs": ["title", "abstract", "evidence_paragraph"],
    "llm_mode": "passthrough",
    "max_papers": 20,
    "stable_sort": true
  }
}
```
Returns: an Evidence-first run artifact (URI + summary). In `passthrough`/`client` modes, you can supply `client_llm_responses` to avoid server-side LLM calls.

### `inspire_paper_source` - Paper Source Access

#### Mode: `urls` - Get Download URLs
```json
{
  "mode": "urls",
  "identifier": "2301.12345"
}
```

#### Mode: `content` - Download Paper Content
Note: if you set `options.output_dir`, it must be within `HEP_DATA_DIR` (path safety). Use a relative path like `"arxiv_sources/<arxiv_id>"` or set `HEP_DATA_DIR` to change the root.

```json
{
  "mode": "content",
  "identifier": "1833986",
  "options": { "prefer": "latex", "extract": true, "output_dir": "arxiv_sources/1833986" }
}
```

#### Mode: `metadata` - Get arXiv Metadata
```json
{
  "mode": "metadata",
  "identifier": "2301.12345"
}
```

### `inspire_parse_latex` - Run-Scoped LaTeX Parsing (Evidence-First)

`inspire_parse_latex` requires `run_id` and writes `parse_latex_<hash>.json` into run artifacts.

```json
{
  "run_id": "<run_id>",
  "identifier": "1833986",
  "components": ["sections", "equations", "citations"],
  "options": { "format": "json", "cross_validate": true }
}
```

Returns: artifact `uri` (`hep://runs/{run_id}/artifact/parse_latex_<hash>.json`) plus a compact `summary`.

---

## Always-Available Tools (2)

Always available in both `standard` and `full`:

| Tool | Function |
|------|----------|
| `inspire_search` | Search literature using INSPIRE syntax (sampled; for large exports use `hep_inspire_search_export`) |
| `inspire_search_next` | Safely follow INSPIRE `next_url` (strict same-origin check) |

## Writing (vNext)

Writing is run-based and Evidence-first. See `docs/WRITING_RECIPE_DRAFT_PATH.md` and `docs/WRITING_RECIPE_CLIENT_PATH.md`.

## Full-Only Tools (Selected)

Available only when `HEP_TOOL_MODE=full`:
Calls are rejected by the server when not in `full` mode.

| Tool | Function |
|------|----------|
| `inspire_find_crossover_topics` | Find cross-disciplinary research |
| `inspire_analyze_citation_stance` | Citation stance analysis |
| `inspire_cleanup_downloads` | Cleanup downloaded files |
| `inspire_validate_bibliography` | Usability-first bibliography audit (manual entries by default; optional INSPIRE cross-check, non-blocking warnings) |

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HEP_DATA_DIR` | Local data root (projects, runs, artifacts, cache, downloads) | `~/.hep-research-mcp` |
| `HEP_TOOL_MODE` | Tool exposure mode (`standard`/`full`) | `standard` |
| `HEP_ENABLE_ZOTERO` | Set to `0` to disable Zotero tools (including `hep_import_from_zotero`) | (enabled) |
| `HEP_ENABLE_TOOL_USAGE_TELEMETRY` | Opt-in tool usage counters for scheduling diagnostics (`1/true/yes/on` to enable; exposed via `hep_health.telemetry`) | (disabled) |
| `HEP_DEBUG` | Debug categories (comma-separated): `rate_limiter,cache,downloads,circuit_breaker,api,tools` | (empty) |
| `DEBUG` | Enable extra debug logs (Node convention) | (empty) |
| `CONCURRENCY_LIMIT` | Max concurrent processing workers in deep research pipelines | `1` |
| `HEP_DOWNLOAD_DIR` | Downloads directory (must be within `HEP_DATA_DIR`) | `<dataDir>/downloads` |
| `ARXIV_DOWNLOAD_DIR` | Alias of `HEP_DOWNLOAD_DIR` | `<dataDir>/downloads` |
| `WRITING_PROGRESS_DIR` | Progress output directory (must be within `HEP_DATA_DIR`) | `<dataDir>/writing_progress` |
| `ZOTERO_BASE_URL` | Zotero Local API base URL (**must be** `http://127.0.0.1:23119`) | `http://127.0.0.1:23119` |
| `ZOTERO_DATA_DIR` | Zotero data directory (contains `zotero.sqlite` + `storage/`; used to read `.zotero-ft-cache`) | `~/Zotero` |
| `ZOTERO_FILE_REDIRECT_GUARD` | Optional hardening: restrict `file://` redirects from Zotero to allowed roots (for linked attachments) | (disabled) |
| `ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS` | Extra allowed roots for `file://` redirects (separated by `:` on macOS/Linux, `;` on Windows) | (empty) |
| `PDG_DB_PATH` | Absolute path to a local PDG sqlite DB (optional; enables `pdg_*`) | (unset) |
| `PDG_DATA_DIR` | PDG local data dir (optional; holds `artifacts/`) | `<HEP_DATA_DIR>/pdg` (when `HEP_DATA_DIR` is set), otherwise `~/.hep-research-mcp/pdg` |
| `PDG_ARTIFACT_TTL_HOURS` | PDG artifact cache TTL in hours (`0/off` disables; cleaned on startup + periodically) | `24` |
| `PDG_ARTIFACT_DELETE_AFTER_READ` | If enabled, deletes a PDG artifact file right after it is successfully read via `pdg://artifacts/<name>` | (disabled) |
| `PDG_TOOL_MODE` | PDG tool exposure mode (`standard`/`full`) | `standard` |
| `PDG_SQLITE_CONCURRENCY` | Max concurrent `sqlite3` processes for PDG tools | `4` |

### Zotero Local API Setup (Zotero 7)

1. In Zotero, enable the **Local API** (Advanced → Local API).
2. Set env vars for the MCP server:
   - `ZOTERO_BASE_URL=http://127.0.0.1:23119`
   - (Optional) `ZOTERO_DATA_DIR=~/Zotero` (only needed if your Zotero data dir is not the default)
   - (Optional hardening) `ZOTERO_FILE_REDIRECT_GUARD=1` (blocks linked attachments unless you allowlist their directories)
   - (Optional hardening) `ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS=/path/to/linked/pdfs` (use `:`/`;` to add multiple roots)
3. Quick sanity check (should return JSON, not HTML):

```bash
curl "http://127.0.0.1:23119/api/users/0/collections?limit=1"
```

If your browser shows `Request not allowed` for `/api/...` URLs, that’s expected — Zotero blocks browser-style requests. Use `curl` or local programs (like this MCP server).

Reference: https://www.zotero.org/support/dev/zotero_7_for_developers

Note: Zotero’s Local API is exposed at `http://127.0.0.1:23119/api/` and largely follows the Zotero Web API v3 request/response shape; you can use the Web API v3 docs as an endpoint/field reference (but still call localhost only): https://www.zotero.org/support/dev/web_api/v3/basics

Note: All `*_at` / `generated_at` timestamps written to manifests/artifacts use ISO 8601 UTC (with a trailing `Z`), not local timezone strings.

Note: Zotero Local API does not provide a stable fulltext HTTP endpoint. Use `zotero_local` with mode `get_attachment_fulltext` to resolve the on-disk cache path at `<ZOTERO_DATA_DIR>/storage/<attachmentKey>/.zotero-ft-cache` (default `~/Zotero`); `hep_run_build_pdf_evidence` reads it automatically when `zotero_attachment_key` is provided.

### Finding Items in Zotero (`zotero_find_items`)

`zotero_find_items` supports two ways to query:
- `identifiers` (DOI/arXiv/INSPIRE recid/title/item_key)
- `filters` (tags/authors/journal/year/volume/issue)

Minimal examples (tool args JSON):

```json
{ "identifiers": { "doi": "10.1103/PhysRevLett.116.061102" } }
```

```json
{ "filters": { "tags": ["hep-th"], "authors": ["Witten"], "publication_title": "Physical Review Letters", "year": 2016 } }
```

### Adding Items to Zotero (`zotero_add`)

`zotero_add` expects a **discriminated union** under `source` (this is the most common source of client-side confusion).

- Typical workflow: select a target collection in Zotero (left sidebar), then call `zotero_add` without `collection_keys` (it targets the currently selected collection).
- If Zotero selects library root, the call errors unless `allow_library_root=true`.
- `zotero_add` is **two-step**: it returns a `confirm_token` preview; execute it via `zotero_confirm`.

Minimal examples (tool args JSON):

```json
{ "source": { "type": "doi", "doi": "10.1103/PhysRevLett.116.061102" }, "tags": ["hep"], "note": "optional note" }
```

```json
{ "source": { "type": "arxiv", "arxiv_id": "2001.00001" } }
```

```json
{ "source": { "type": "inspire", "recid": "123456" } }
```

```json
{ "source": { "type": "item", "item": { "itemType": "journalArticle", "title": "My Paper", "DOI": "10.1000/xyz" } } }
```

Confirm execution:

```json
{ "confirm_token": "<confirm_token_from_zotero_add>" }
```

### Data Directory Layout (`HEP_DATA_DIR`)

All vNext state is local-only under `HEP_DATA_DIR`:

```
<HEP_DATA_DIR>/
  cache/                  # persistent disk cache (safe to delete)
  corpora/                # optional local corpora (style packs, etc.)
  downloads/              # temporary arXiv downloads (auto-cleaned by TTL)
  models/                 # optional local models (embeddings/rerank; local-only)
  projects/<project_id>/  # long-lived research assets (papers, evidence catalogs)
  runs/<run_id>/          # run manifests + artifacts (auditing + reproducibility)
```

Note: PDG artifacts live under `PDG_DATA_DIR`. If `HEP_DATA_DIR` is set, `PDG_DATA_DIR` defaults to `<HEP_DATA_DIR>/pdg` to keep a single relocatable root; otherwise it defaults to `~/.hep-research-mcp/pdg`. `PDG_DATA_DIR/artifacts` is treated as a query cache and is auto-pruned by `PDG_ARTIFACT_TTL_HOURS`.

#### Multiple Projects vs Multiple Roots

- One root: keep a single `HEP_DATA_DIR` and create multiple `hep_project_create` projects; old projects/runs remain discoverable via `hep://projects` / `hep://runs`.
- Multiple roots: set `HEP_DATA_DIR` per research workspace (e.g. `<your_project>/.hep-research-mcp`) for easy cleanup/portability. When you switch `HEP_DATA_DIR`, previously created `hep://...` URIs will only resolve again after switching back to the original root.

#### Cleanup Quick Reference

- PDG query cache: `rm -rf "${PDG_DATA_DIR:-$HOME/.hep-research-mcp/pdg}/artifacts"` (safe)
- HEP persistent cache: `rm -rf "${HEP_DATA_DIR:-$HOME/.hep-research-mcp}/cache"` (safe)

Note: some MCP clients also display previously returned artifact URIs in their UI; deleting files reclaims disk space, but you may need to restart/reload the MCP client/server to refresh the list.

### Disk Cache

By default, the persistent cache lives in `<HEP_DATA_DIR>/cache` (gzipped entries). If you suspect stale/corrupted cache after upgrades, it is safe to delete this directory.

### Progress & Resume (Run-Based)

For vNext workflows, progress is tracked in the run manifest: `hep://runs/{run_id}/manifest` (steps + artifact refs).

### MCP Server Configuration

#### Tool Name Prefixes (Client Namespacing)

Some MCP clients/runtimes expose tools with a prefix like `mcp__<serverAlias>__<toolName>` (example: `mcp__hep__inspire_search`). The `serverAlias` is the key you configured in your client config.

Always call the **exact tool name shown by your client**. If you see “tool not found”, open your client’s Tools list and copy/paste the full name (don’t guess).

Quick sanity check: call `hep_health` (set `check_inspire=true` to probe INSPIRE connectivity).

#### Claude Desktop

Edit config file `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "hep-research-mcp": {
      "command": "node",
      "args": ["/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"]
    }
  }
}
```

#### Cursor

Add the MCP server in Cursor UI (Settings → MCP) **or** edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hep-research-mcp": {
      "command": "node",
      "args": ["/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"]
    }
  }
}
```

**If you see `spawn node ENOENT`**
- Cursor can’t find `node` in its PATH. On macOS this often happens when Cursor is launched as a GUI app and doesn’t inherit your shell PATH.
- Fix: set `"command"` to the absolute Node path (e.g. `/opt/homebrew/bin/node`), or add a `PATH` entry via `"env"`.

**To see tools in Cursor**
1. Make sure the server is built: `pnpm -r build` (so `dist/index.js` exists).
2. Restart Cursor (or reload the MCP servers list if your version supports it).
3. Open Chat/Agent → find the **Tools** panel/list → enable `hep-research-mcp` tools (Cursor may require a “trust/enable tools” toggle per server).

**If tools still don’t show up**
- Cursor may hide tools if `listTools` returns an invalid tool schema. Re-run `pnpm -r build`, restart Cursor, and follow the “listTools sanity check” in `docs/TESTING_GUIDE.md`.

**If you don’t see every artifact under Resources**
- That’s expected: Resources uses the “Iceberg” entrypoint model (you’ll see `hep://projects`, `hep://runs`, `hep://corpora`, `pdg://artifacts`, etc.).
- To find previous projects, read `hep://projects`. To find runs, read `hep://runs`, then read `hep://runs/{run_id}/manifest` for artifact URIs.

#### Claude Code CLI

```bash
claude mcp add hep-research-mcp -- node /path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js
```

#### Chatbox

[Chatbox](https://chatboxai.app/) is a cross-platform AI chat client with MCP support.

1. Open Chatbox Settings → MCP Servers
2. Click "Add Server"
3. Configure as follows:

```json
{
  "hep-research-mcp": {
    "command": "node",
    "args": ["/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"]
  }
}
```

Or via config file `~/.chatbox/mcp.json` (path may vary by system).

#### Cherry Studio

[Cherry Studio](https://cherry-ai.com/) is a multi-model AI assistant with MCP support.

1. Open Cherry Studio Settings → MCP Settings
2. Add new MCP server
3. Fill in configuration:
   - **Name**: `hep-research-mcp`
   - **Command**: `node`
   - **Arguments**: `/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js`

#### Other MCP-Compatible Tools

MCP is an open protocol. The following tools also support MCP servers:

| Tool | Configuration | Description |
|------|---------------|-------------|
| **Cline** (VS Code) | Settings → MCP Servers | VS Code AI coding assistant |
| **Continue** (VS Code/JetBrains) | `~/.continue/config.json` | Open-source AI coding assistant |
| **Zed** | Settings → Assistant → MCP | Modern code editor |

**Universal configuration format** (compatible with most tools):

```json
{
  "mcpServers": {
    "hep-research-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

> **Note**: Replace `/path/to/` with your actual absolute path.

#### Optional: Environment Variables in MCP Config

Customize hep-research-mcp behavior via environment variables:

	```json
	{
	  "mcpServers": {
	    "hep-research-mcp": {
	      "command": "node",
	      "args": ["/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"],
		      "env": {
		        "HEP_DATA_DIR": "/path/to/hep-data",
		        "HEP_TOOL_MODE": "full",
		        "HEP_DOWNLOAD_DIR": "/path/to/hep-data/downloads",
		        "HEP_DEBUG": "tools,downloads",
		        "ZOTERO_BASE_URL": "http://127.0.0.1:23119",
		        "ZOTERO_DATA_DIR": "/path/to/Zotero",
		      }
	    }
	  }
	}
	```

Zotero Local API has no authentication — you do not need a Local API key.

> Note: Do NOT commit any config file that contains real API keys. Keep local MCP configs (e.g., `.mcp.json`) out of git.

See [Environment Variables](#environment-variables) for all available options.

---

## INSPIRE Search Syntax

**Author disambiguation tip:** INSPIRE provides a stable author identifier called **BAI** (e.g. `E.Witten.1`). Prefer it for author queries: `a:E.Witten.1` (instead of ambiguous names like `a:witten`).

| Syntax | Example | Description |
|--------|---------|-------------|
| `a:` | `a:witten` | Author search (supports INSPIRE BAI, e.g. `a:E.Witten.1`) |
| `t:` | `t:supersymmetry` | Title search |
| `aff:` | `aff:CERN` | Affiliation search |
| `topcite:` | `topcite:500+` | Citation count filter |
| `date:` | `date:2020->2024` | Date range |
| `j:` | `j:Phys.Rev.D` | Journal filter |
| `eprint:` | `eprint:2301.12345` | arXiv ID |
| `fulltext:` | `fulltext:"dark matter"` | Full-text search |

## Documentation

- [Feature Testing Guide](./docs/TESTING_GUIDE.md)
- [中文文档](./docs/README_zh.md)
- [pdg-mcp Docs](./packages/pdg-mcp/README.md)

## Related Projects

- [zotero-inspire](https://github.com/fkguo/zotero-inspire) - Zotero INSPIRE Plugin
- [INSPIRE-HEP](https://inspirehep.net) - High Energy Physics Literature Database
- [INSPIRE REST API](https://github.com/inspirehep/rest-api-doc) - INSPIRE API Documentation

## Citation

### Citing This Project

If this project helps your research, you're welcome to mention it in your acknowledgments.

### Citing INSPIRE API

If you use INSPIRE data in academic work, please cite as required by INSPIRE:

```bibtex
@article{Moskovic:2021zjs,
    author = "Moskovic, Micha",
    title = "{The INSPIRE REST API}",
    url = "https://github.com/inspirehep/rest-api-doc",
    doi = "10.5281/zenodo.5788550",
    year = "2021"
}
```

## Development

This project was developed with AI assistance. AI helped with code implementation, documentation writing, and code review.

## License

MIT
