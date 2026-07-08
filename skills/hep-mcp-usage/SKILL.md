---
name: hep-mcp-usage
description: Use proactively when a research task would benefit from the Nullius hep-mcp MCP stack for literature search, arXiv source retrieval, broad scholarly metadata/citation context through OpenAlex, INSPIRE/HEPData/PDG/Zotero provider access, evidence collection, citation mapping, writing/export support, or source-backed prior-art checks; explicit user mention is not required. Also trigger when a user asks to use hep-mcp, INSPIRE, arXiv source, arxiv-mcp, OpenAlex, openalex-mcp, HEPData, PDG, Zotero, or local literature/evidence MCP tools. Keep HEP-specific assumptions scoped to HEP workflows and providers.
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
- For durable research conclusions, inspect or record the returned run manifest path, usually under `<project_root>/artifacts/hep-mcp/runs/<run_id>/manifest.json`.
- Keep fetched sources, extracted text, and generated artifacts outside the Nullius development repo unless the repo explicitly owns that fixture.
- Environment paths such as `HEP_DATA_DIR` and `PDG_DATA_DIR` are filesystem roots, not URI/protocol settings.

## Evidence Workflow

1. Start with a health/config check when the session has not already proved the MCP server is available.
2. Search with the most authoritative provider for the question. For HEP literature identity and author queries, start with INSPIRE-backed `hep-mcp` search; for non-HEP scholarly metadata or citation context, start with the general provider most suited to the task, such as OpenAlex or arXiv.
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

## Routing to Neighbor Skills

- Use `research-harness` first when entering or recovering an initialized research project.
- Use `deep-literature-review` when the task is a full source-first literature survey rather than a single lookup or evidence check.
- Use `claim-grounding` when the task is to decide whether a cited source actually supports a written claim.
- Use `citation-triangulation` when canonical metadata from multiple bibliographic indexes is the central task.
- Use `hep-calc` for reproducible HEP calculations, symbolic/numerical comparison, or auditable compute runs.
- Use `pdg-lookup` or `zotero-import` when the user specifically asks for those narrower workflows.
