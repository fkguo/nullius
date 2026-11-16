---
name: hep-mcp-usage
description: Use proactively when a research task would benefit from the Nullius hep-mcp MCP stack for literature search, arXiv source retrieval, broad scholarly metadata/citation context through OpenAlex, INSPIRE/HEPData/PDG/Zotero provider access, citekey/BibTeX resolution, search exports into project files, or source-backed prior-art checks; explicit user mention is not required. Also trigger when a user asks to use hep-mcp, INSPIRE, arXiv source, arxiv-mcp, OpenAlex, openalex-mcp, HEPData, PDG, Zotero, or local literature/evidence MCP tools. Keep HEP-specific assumptions scoped to HEP workflows and providers.
---

# hep-mcp usage

## Overview

Use `hep-mcp` as the composed MCP front door for the Nullius literature/evidence provider stack. For HEP work, it is the HEP domain entrypoint. It also composes bounded provider atoms such as `arxiv-mcp`, `openalex-mcp`, `hepdata-mcp`, `pdg-mcp`, and `zotero-mcp`; some of those atoms, especially arXiv and OpenAlex, are useful outside HEP. Use the live tool inventory because exact tool names can vary by client and mode.

This skill is an agent-facing operating contract. It does not replace `research-harness`, `claim-grounding`, `deep-literature-review`, `hep-calc`, `pdg-lookup`, or `zotero-import`; use those skills when their narrower workflow is the primary task.

## Entry Point Discipline

- For HEP literature, evidence, citation, paper-source, data, PDG, or Zotero work, first look for a usable `hep-mcp` MCP server/tool surface.
- For non-HEP scholarly literature/source/metadata tasks, use the general provider atoms surfaced through `hep-mcp` when the live inventory exposes them, especially arXiv, OpenAlex, and Zotero. Do not force INSPIRE, HEPData, PDG, or HEP taxonomy onto non-HEP tasks.
- Do not wait for the user to name `hep-mcp` or a provider explicitly. If a task needs source-backed literature discovery, source retrieval, citation metadata, cross-index triangulation, or provenance collection and this MCP stack is available, route through this skill.
- Treat `arxiv_*`, `openalex_*`, `hepdata_*`, `pdg_*`, and `zotero_*` as provider atoms that can be surfaced through `hep-mcp`. Do not ask the user to wire those provider MCP servers separately unless the host lacks the needed `hep-mcp` capability or the user explicitly wants a standalone provider check.
- Keep `hep-mcp` as domain/provider-layer authority. Do not promote HEP assumptions into generic Nullius control-plane behavior.
- Use the live tool inventory from the connected MCP server. Do not rely on stale static tool counts or copied lists.

## Project and Artifact Roots

- If the work belongs to an initialized Nullius project, pass `project_root=/absolute/path/to/project` on HEP tool calls so state lands under `artifacts/hep-mcp`.
- If the current directory is not an initialized Nullius project, do not pass `project_root` just because a local workspace exists. Use scratch mode via the resolved `HEP_DATA_DIR` instead.
- `hep-mcp` keeps no runs of its own; runs, approvals, and lifecycle belong to the Nullius orchestrator (`<project_root>/artifacts/runs/<run_id>/`). The research-output tools (search exports, identifier and Zotero mappings, LaTeX parses, conflict maps, and `inspire_search` when given `output_dir`) need `project_root` plus an `output_dir` inside the project; use a subdirectory of the current run directory, e.g. `artifacts/runs/<run_id>/literature`. `output_dir` may not traverse a symbolic link below the project root, lie under `.nullius/`, `team/runs/` or `artifacts/hep-mcp/` (compared ignoring letter case), or be the project root itself. A call never replaces an existing file, and a call that fails removes what it had published (if a published file cannot be removed, the error says the outputs are incomplete and lists `files_left`; staging files that cannot be removed are listed in `staging_left` on the original error, or in `staging_path` if unidentified; removals that cannot be flushed to disk are reported as UNSAFE_FS with `unflushed_directories`; only a crash during publication can leave part of a set without such a report; later calls naming those files are refused until they are removed); to run a tool again, give a new `output_dir` (or new artifact names). Downloads made by `inspire_paper_source`, caches and PDG data stay in hep-mcp's data root.
- For durable research conclusions, record the project-relative paths the tools return (`export_path`, `meta_path`, `mapping_path`, `path`, `artifacts[].path`); the INSPIRE requests and responses behind a search export, an identifier resolution or the INSPIRE step of a Zotero mapping are recorded under `<output_dir>/external_api/` (other provider calls are not).
- Historical HEP run directories (for example `<project_root>/artifacts/hep-mcp/runs/<run_id>/`), paper/evidence project directories with their evidence catalogs (for example `<project_root>/artifacts/hep-mcp/projects/<project_id>/`), and notes citing `hep://runs/...` or `hep://projects/...` are evidence from earlier versions: read them in place and never rewrite or move them. No tool resolves `hep://` references any more; map `hep://runs/<run_id>/artifact/<name>` to `<HEP data root>/runs/<run_id>/artifacts/<name>`, `hep://runs/<run_id>/manifest` to `<HEP data root>/runs/<run_id>/manifest.json`, `hep://projects/<project_id>` to `<HEP data root>/projects/<project_id>/project.json`, `hep://projects/<project_id>/artifact/<name>` to `<HEP data root>/projects/<project_id>/artifacts/<name>`, `hep://projects/<project_id>/papers/<paper_id>` to `<HEP data root>/projects/<project_id>/papers/<paper_id>/paper.json`, and `hep://projects/<project_id>/papers/<paper_id>/evidence/catalog` to `<HEP data root>/projects/<project_id>/papers/<paper_id>/evidence/catalog.jsonl` (percent-decode the segments); the listings `hep://projects` and `hep://projects/<project_id>/papers` have no single file: they were JSON built on read, `{"projects": [...]}` with one row per readable `project.json` under `<HEP data root>/projects/` (`project_id`, `name`, `description`, `created_at`, `updated_at`, `uri`) and `{"project_id": ..., "papers": [...]}` with one row per readable `paper.json` under `<HEP data root>/projects/<project_id>/papers/` (`paper_id`, `updated_at`, `uri`, and `evidence_catalog_uri` from `artifacts.evidence_catalog.uri` when present), most recently updated first, unreadable entries skipped, where the HEP data root is `<project_root>/artifacts/hep-mcp` if the original call named a project root, else `HEP_DATA_DIR` as configured at that time, else the scratch default of the version that wrote it (`~/.hep-research-mcp` until 2026-02-26, `~/.hep-mcp` until 2026-05-16, `~/.autoresearch/hep-mcp` until 2026-07-05, `~/.nullius/hep-mcp` since; near a changeover date check both).
- Keep fetched sources, extracted text, and generated artifacts outside the Nullius development repo unless the repo explicitly owns that fixture.
- Environment paths such as `HEP_DATA_DIR` and `PDG_DATA_DIR` are filesystem roots, not URI/protocol settings.

## Evidence Workflow

1. Start with a health/config check when the session has not already proved the MCP server is available.
2. Search with the most authoritative provider for the question. For HEP literature identity and author queries, start with INSPIRE-backed `hep-mcp` search; for non-HEP scholarly metadata or citation context, start with the general provider most suited to the task, such as OpenAlex or arXiv. Use direct identifier lookup for an ID supplied by the user or found in a source or catalog record. When working from memory, a topic, or a partial citation, search by title words, author or collaboration first. Check the returned title, authors and subject against the intended work before copying its identifier. If the matched record has no arXiv ID, use its DOI or INSPIRE recid. An INSPIRE miss alone says nothing about availability on arXiv.
3. For arXiv papers, prefer source retrieval and LaTeX/source-level reading over abstract-only summaries or PDF-only skim when the claim is load-bearing.
4. Treat metadata resolution as identification, not verification. A paper, DOI, recid, arXiv id, or citekey match does not prove the cited content supports the claim.
5. Check author/name collisions, year/topic outliers, and suspicious citation mappings explicitly. Report collisions instead of silently accepting a mixed result set.
6. For source-backed claims, record enough provenance for a later reader to locate the supporting section, equation, figure, table, or extracted source span.

## Provider Composition

- `arxiv-mcp`: use through `hep-mcp` for arXiv metadata, paper source retrieval, source trees, and source-first reading across arXiv-covered fields.
- `openalex-mcp`: use through `hep-mcp` for broad scholarly metadata, citation graph context, and cross-index triangulation across fields.
- `hepdata-mcp`: use through `hep-mcp` for HEPData records and data-backed evidence where relevant.
- `pdg-mcp`: use through `hep-mcp` or the `pdg-lookup` skill for particle properties, measurements, and reference checks.
- `zotero-mcp`: use through `hep-mcp` or the `zotero-import` skill for local library import/confirmation flows.

Standalone provider MCPs remain valid bounded atoms. For HEP work, `hep-mcp` is the composed entrypoint unless there is a concrete reason to bypass it. For non-HEP scholarly work, use only the general provider capabilities exposed through the stack and avoid HEP-specific inference unless the source evidence warrants it.

Query sizing: a single MCP tool call is bounded by the host's per-call timeout (host-dependent — as low as about two minutes by default on some CLI hosts, hours on others), and broad full-text literature searches have been observed to hit such ceilings. Decompose wide questions into several narrow metadata or citation-graph queries (then follow up on specific records) instead of one exhaustive full-text sweep, and prefer paginated continuation over raising result counts. Large source downloads that stall are better fetched through the host's page-fetch fallback than retried through the same MCP call.

## Routing to Neighbor Skills

- Use `research-harness` first when entering or recovering an initialized research project.
- Use `deep-literature-review` when the task is a full source-first literature survey rather than a single lookup or evidence check.
- Use `claim-grounding` when the task is to decide whether a cited source actually supports a written claim.
- Use `citation-triangulation` when canonical metadata from multiple bibliographic indexes is the central task.
- Use `hep-calc` for reproducible HEP calculations, symbolic/numerical comparison, or auditable compute runs.
- Use `pdg-lookup` or `zotero-import` when the user specifically asks for those narrower workflows.
