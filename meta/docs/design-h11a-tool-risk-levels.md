# Design: H-11a MCP Tool Risk Classification

> **Status**: Phase 1 DONE
> **Author**: Claude (Phase 1 kickoff)
> **Date**: 2026-02-25
> **Scope**: Risk level classification for all MCP tools based on NEW-R15-spec threat model
> **Depends on**: C-02 (done), NEW-R15-spec (done)
> **Implementation**: ToolRiskLevel type + TOOL_RISK_LEVELS map in shared, riskLevel on ToolSpec, 3 contract tests

---

## 1. Problem Statement

The autoresearch MCP ecosystem exposes 83 tools (71 standard + 12 full-only) across 4 packages (`hep-mcp`, `pdg-mcp`, `zotero-mcp`, and future `orchestrator`). Currently:

- Tools have `exposure` mode (`standard` / `full`) but no risk classification
- The NEW-R15-spec threat model identifies 5 threat vectors, including "Unauthorized Destructive Operations" (3.4)
- `orch_run_export` is marked `destructive` in the spec, but no enforcement mechanism exists
- C-02 provides shell execution isolation, but the MCP tool layer lacks its own risk classification

**Goal**: Define a risk classification scheme, assign levels to all tools, and design an enforcement mechanism.

## 2. Threat Model Summary (from NEW-R15-spec)

| Vector | Threat | Relevant Risk Level |
|--------|--------|-------------------|
| 3.1 Agent Self-Approval | Agent approves its own work | `write` (approval tools) |
| 3.2 State Corruption | Concurrent state.json corruption | `write` (state-mutating tools) |
| 3.3 Namespace Collision | File write conflicts between packages | `write` (artifact-writing tools) |
| 3.4 Unauthorized Destructive Ops | Agent calls export/delete without consent | `destructive` |
| 3.5 Approval Timeout Bypass | Agent ignores timeout constraints | `write` (approval tools) |

## 3. Risk Level Definitions

### Three-level classification:

| Level | Name | Definition | Enforcement |
|-------|------|-----------|-------------|
| `read` | Read-only | Returns data without modifying any state, artifacts, or external systems | None — always allowed |
| `write` | State-mutating | Creates or modifies run state, artifacts, ledger entries, or external resources | Logged in ledger; subject to approval budget |
| `destructive` | Destructive / Irreversible | Deletes data, exports with side effects, or performs actions that cannot be undone | Requires `_confirm: true` parameter; without it, returns a confirmation prompt |

### Classification criteria:

```
Does the tool modify ANY persistent state?
├── No  → read
└── Yes
    ├── Is the modification reversible within the system?
    │   ├── Yes → write
    │   └── No  → destructive
    └── Does the tool interact with external systems (network, Zotero)?
        └── Yes → at least write (external writes are state-mutating)
```

## 4. Tool Risk Classification

### 4.1 HEP Project Tools

| Tool | Risk | Rationale |
|------|------|-----------|
| `hep_project_create` | `write` | Creates project directory and state files |
| `hep_project_get` | `read` | Returns project metadata |
| `hep_project_list` | `read` | Lists projects |
| `hep_health` | `read` | Health check |
| `hep_project_build_evidence` | `write` | Builds and writes evidence catalog artifacts |
| `hep_project_query_evidence` | `read` | Queries existing evidence |
| `hep_project_query_evidence_semantic` | `read` | Semantic query over evidence |
| `hep_project_playback_evidence` | `read` | Reads evidence timeline |
| `hep_project_compare_measurements` | `read` | Compares existing measurements |

### 4.2 HEP Run Management

| Tool | Risk | Rationale |
|------|------|-----------|
| `hep_run_create` | `write` | Creates run directory, state.json, ledger.jsonl |
| `hep_run_read_artifact_chunk` | `read` | Reads artifact content |
| `hep_run_clear_manifest_lock` | `write` | Removes lock file (state mutation) |
| `hep_run_stage_content` | `write` | Writes staged content to run directory |
| `hep_run_build_pdf_evidence` | `write` | Downloads PDFs and builds evidence artifacts |
| `hep_run_build_evidence_index_v1` | `write` | Builds and writes evidence index |

### 4.3 HEP Run Writing Pipeline

| Tool | Risk | Rationale |
|------|------|-----------|
| `hep_run_writing_create_token_budget_plan_v1` | `write` | Creates budget plan artifact |
| `hep_run_writing_token_gate_v1` | `read` | Checks token budget (no mutation) |
| `hep_run_writing_create_section_write_packet_v1` | `write` | Creates prompt packet artifact |
| `hep_run_writing_create_section_candidates_packet_v1` | `write` | Creates candidate packet |
| `hep_run_writing_submit_section_candidates_v1` | `write` | Writes candidate sections |
| `hep_run_writing_create_section_judge_packet_v1` | `write` | Creates judge packet |
| `hep_run_writing_submit_section_judge_decision_v1` | `write` | Writes judge decision, updates manifest |
| `hep_run_writing_create_paperset_curation_packet` | `write` | Creates curation packet |
| `hep_run_writing_submit_paperset_curation` | `write` | Writes curation result |
| `hep_run_writing_create_outline_candidates_packet_v1` | `write` | Creates outline packet |
| `hep_run_writing_submit_outline_candidates_v1` | `write` | Writes outline candidates |
| `hep_run_writing_create_outline_judge_packet_v1` | `write` | Creates outline judge packet |
| `hep_run_writing_submit_outline_judge_decision_v1` | `write` | Writes outline decision |
| `hep_run_build_writing_evidence` | `write` | Builds evidence artifacts (network + disk) |
| `hep_run_build_measurements` | `write` | Builds measurement artifacts |
| `hep_run_build_writing_critical` | `write` | Builds critical analysis artifacts |
| `hep_run_build_citation_mapping` | `write` | Builds citation mapping artifact |
| `hep_run_writing_build_evidence_packet_section_v2` | `write` | Builds per-section evidence packet |
| `hep_run_writing_submit_rerank_result_v1` | `write` | Writes rerank results |
| `hep_run_writing_submit_review` | `write` | Writes reviewer report artifact |
| `hep_run_writing_create_revision_plan_packet_v1` | `write` | Creates revision plan packet |
| `hep_run_writing_submit_revision_plan_v1` | `write` | Writes revision plan |
| `hep_run_writing_refinement_orchestrator_v1` | `write` | Orchestrates refinement (multiple artifacts) |
| `hep_run_writing_integrate_sections_v1` | `write` | Integrates sections into final draft |

### 4.4 HEP Render & Export

| Tool | Risk | Rationale |
|------|------|-----------|
| `hep_render_latex` | `write` | Renders LaTeX, writes output files |
| `hep_export_project` | `destructive` | Exports project bundle; creates archive outside run directory |
| `hep_export_paper_scaffold` | `destructive` | Exports paper scaffold to external location |
| `hep_import_paper_bundle` | `write` | Imports bundle into run (additive, reversible) |
| `hep_import_from_zotero` | `write` | Imports from Zotero (external system read + local write) |

### 4.5 HEP INSPIRE Integration

| Tool | Risk | Rationale |
|------|------|-----------|
| `hep_inspire_search_export` | `write` | Searches INSPIRE and writes export artifact |
| `hep_inspire_resolve_identifiers` | `read` | Resolves identifiers via INSPIRE API (read-only) |

### 4.6 INSPIRE Tools

| Tool | Risk | Rationale |
|------|------|-----------|
| `inspire_search` | `read` | Search query, returns results |
| `inspire_search_next` | `read` | Pagination |
| `inspire_literature` | `read` | Literature lookup |
| `inspire_resolve_citekey` | `read` | Citekey resolution |
| `inspire_parse_latex` | `write` | Parses LaTeX, writes parsed artifacts |
| `inspire_research_navigator` | `read` | Research navigation |
| `inspire_critical_research` | `read` | Critical analysis |
| `inspire_paper_source` | `write` | Downloads paper source (network + disk) |
| `inspire_deep_research` | `write` | Deep research with artifact creation |
| `inspire_find_crossover_topics` | `read` | Topic analysis |
| `inspire_analyze_citation_stance` | `read` | Citation stance analysis |
| `inspire_cleanup_downloads` | `destructive` | Deletes downloaded files |
| `inspire_validate_bibliography` | `read` | Bibliography validation |

### 4.7 INSPIRE Style Corpus

| Tool | Risk | Rationale |
|------|------|-----------|
| `inspire_style_corpus_query` | `read` | Queries style corpus |
| `inspire_style_corpus_init_profile` | `write` | Creates style profile |
| `inspire_style_corpus_build_manifest` | `write` | Builds manifest |
| `inspire_style_corpus_download` | `write` | Downloads papers (network + disk) |
| `inspire_style_corpus_build_evidence` | `write` | Builds evidence from corpus |
| `inspire_style_corpus_build_index` | `write` | Builds search index |
| `inspire_style_corpus_export_pack` | `destructive` | Exports pack to external location |
| `inspire_style_corpus_import_pack` | `write` | Imports pack (additive) |

### 4.8 PDG Tools

| Tool | Risk | Rationale |
|------|------|-----------|
| `pdg_info` | `read` | Database metadata |
| `pdg_find_particle` | `read` | Particle search |
| `pdg_find_reference` | `read` | Reference search |
| `pdg_get_reference` | `read` | Reference lookup |
| `pdg_get_property` | `read` | Property lookup |
| `pdg_get` | `read` | General lookup |
| `pdg_get_decays` | `read` | Decay data |
| `pdg_get_measurements` | `read` | Measurement data (writes artifact) |
| `pdg_batch` | `read` | Batch queries |

Note: `pdg_get_measurements` writes an artifact file but is classified as `read` because it produces a deterministic cache artifact from immutable PDG data — it has no destructive potential.

### 4.9 Zotero Tools

| Tool | Risk | Rationale |
|------|------|-----------|
| `zotero_local` | `read` | Zotero connection test |
| `zotero_find_items` | `read` | Search items |
| `zotero_search_items` | `read` | Full-text search |
| `zotero_export_items` | `read` | Export item data |
| `zotero_get_selected_collection` | `read` | Get selected collection |
| `zotero_add` | `write` | Add item to Zotero (external system mutation) |
| `zotero_confirm` | `write` | Confirm pending add (external system mutation) |

### 4.10 Orchestrator Tools (Future — from NEW-R15-spec)

| Tool | Risk | Rationale |
|------|------|-----------|
| `orch_run_create` | `write` | Creates run state |
| `orch_run_status` | `read` | State snapshot |
| `orch_run_approve` | `write` | Clears approval gate |
| `orch_run_reject` | `write` | Rejects approval |
| `orch_run_pause` | `write` | Pauses run |
| `orch_run_resume` | `write` | Resumes run |
| `orch_run_checkpoint` | `write` | Records checkpoint |
| `orch_run_export` | `destructive` | Exports bundle |
| `orch_run_request_approval` | `write` | Creates approval gate |
| `orch_run_logs` | `read` | Tail ledger |
| `orch_run_branch_list` | `read` | List branches |
| `orch_run_branch_add` | `write` | Add branch |
| `orch_run_branch_switch` | `write` | Switch branch |

### Summary

| Risk Level | Count | Percentage |
|-----------|-------|-----------|
| `read` | 39 | 47% |
| `write` | 39 | 47% |
| `destructive` | 5 | 6% |
| **Total** | **83** | 100% |

Destructive tools: `hep_export_project`, `hep_export_paper_scaffold`, `inspire_cleanup_downloads`, `inspire_style_corpus_export_pack`, `orch_run_export`.

## 5. Implementation Design

### 5.1 Schema Extension: `riskLevel` in ToolSpec

Extend the `ToolSpec` interface to include risk level:

```typescript
// packages/shared/src/tool-names.ts (or a new tool-risk.ts)

export type ToolRiskLevel = 'read' | 'write' | 'destructive';
```

```typescript
// In each package's registry.ts
export interface ToolSpec<TSchema extends z.ZodType<any, any> = z.ZodType<any, any>> {
  name: string;
  description: string;
  tier: ToolTier;
  exposure: ToolExposure;
  riskLevel: ToolRiskLevel;    // NEW
  zodSchema: TSchema;
  handler: (params: z.output<TSchema>, ctx: ToolHandlerContext) => Promise<unknown>;
}
```

### 5.2 `_confirm` Parameter Injection for Destructive Tools

For tools classified as `destructive`, the dispatcher automatically checks for a `_confirm: true` parameter:

```typescript
// In dispatcher.ts
async function handleToolCall(name: string, args: Record<string, unknown>, ...) {
  const spec = getToolSpec(name);
  // ...

  if (spec.riskLevel === 'destructive') {
    if (args._confirm !== true) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            confirmation_required: true,
            tool: name,
            risk_level: 'destructive',
            message: `This tool performs an irreversible operation. Pass _confirm: true to proceed.`,
            description: spec.description,
          }, null, 2),
        }],
      };
    }
  }

  // ... proceed with handler
}
```

### 5.3 Risk Level Annotation in Tool Catalog

The tool catalog (C-03) includes risk level in its output:

```json
{
  "name": "hep_export_project",
  "tier": "core",
  "exposure": "standard",
  "risk_level": "destructive",
  "description": "..."
}
```

### 5.4 Ledger Annotation

All `write` and `destructive` tool calls are logged in the run ledger with risk metadata:

```jsonl
{"event_type": "tool_call", "tool": "hep_run_stage_content", "risk_level": "write", "ts": "..."}
{"event_type": "tool_call", "tool": "hep_export_project", "risk_level": "destructive", "confirmed": true, "ts": "..."}
```

### 5.5 Default Risk Level Lookup

A static map in `packages/shared/` enables risk level lookup without importing the full registry:

```typescript
// packages/shared/src/tool-risk.ts
import type { ToolRiskLevel } from './tool-risk-types.js';
import * as T from './tool-names.js';

export const TOOL_RISK_LEVELS: Record<string, ToolRiskLevel> = {
  [T.HEP_PROJECT_CREATE]: 'write',
  [T.HEP_PROJECT_GET]: 'read',
  // ... all 83+ tools
};
```

This is consumed by the orchestrator for policy decisions without needing the MCP tool registry.

## 6. Integration Points

### 6.1 H-11b (Phase 2): Permission Composition

H-11b builds on H-11a to compose tool permissions from risk levels + user roles:

```
risk_level: read  → allowed by default
risk_level: write → allowed if run is active
risk_level: destructive → requires _confirm + approval gate
```

### 6.2 NEW-R15-impl (Phase 2): Orchestrator Enforcement

The orchestrator uses risk levels to enforce:
- **Budget limits**: count `write` operations per run
- **Approval gates**: `destructive` operations trigger approval before execution
- **Audit trail**: all non-`read` operations logged with risk metadata

### 6.3 C-02 Integration

C-02's shell execution isolation provides a parallel defense layer. Risk classification operates at the MCP tool level, C-02 operates at the system call level. They are complementary.

## 7. Migration Plan

### 7.1 Phase 1 (This PR)
1. Add `ToolRiskLevel` type to `packages/shared/src/tool-names.ts`
2. Add `TOOL_RISK_LEVELS` map to `packages/shared/src/tool-risk.ts`
3. Add `riskLevel` field to `ToolSpec` in all 3 registry files
4. Add `_confirm` enforcement in dispatcher for `destructive` tools
5. Update tool catalog generator to include risk level
6. Add contract tests verifying risk classifications

### 7.2 Phase 2 (H-11b, NEW-R15-impl)
- Permission composition logic
- Orchestrator enforcement
- Ledger risk metadata

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| Misclassification of a tool's risk level | Contract tests + dual-model review of classifications |
| `_confirm` parameter conflicts with tool's existing schema | Use underscore prefix convention; no current tools use `_confirm` |
| Performance overhead of risk checks | Negligible — single map lookup + boolean check |
