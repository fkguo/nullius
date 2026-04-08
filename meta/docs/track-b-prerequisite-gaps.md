# Track B: Prerequisite Gap Analysis

> **Date**: 2026-02-21
> **Branch**: `redesign/track-b`
> **2026-04 public-surface note**: `REDESIGN_PLAN` / tracker references in this memo are historical planning context only, not current public authority.

## Gap Analysis

### Gap 1: trace-jsonl Event Type Schema (Phase 2)

**Current state**: trace-jsonl defines transport format (JSONL) and basic fields
(`ts`, `trace_id`, `level`, `component`, `event`, `data`) but does NOT enumerate
required event types for downstream consumers.

**Impact**: EVO-12a (Skill Genesis) requires `file_edit`, `fix_applied`,
`tool_call`, and `skill_invoked` event types with structured `data` fields.
Without these, pattern detection cannot operate.

**Recommended action**: Add note to the historical trace-jsonl planning item specifying
that the event schema must define these event types as part of the trace-jsonl
deliverable. This is a specification refinement, not a new item.

**Severity**: Medium — does not block design, but blocks EVO-12a implementation.

### Gap 2: M-06 SQLite WAL Scope Expansion

**Current state**: M-06 specifies WAL mode and busy_timeout for `pdg-mcp/src/db.ts`
only. It does not address:
- Shared SQLite connection management for multiple consumers
- Connection pooling beyond PDG database
- Schema migration support for new databases (Memory Graph, Gene Library, Strategy Stats)

**Impact**: EVO-20 Memory Graph and EVO-19 Gene Library both need SQLite with WAL
mode. The current M-06 scope is too narrow — it only applies to the PDG database.

**Recommended action**: Expand M-06 scope to include a shared SQLite utility in
`packages/shared/src/db/` that provides:
1. WAL mode configuration
2. Busy timeout management
3. Connection lifecycle (open/close/checkpoint)
4. Schema initialization (CREATE TABLE IF NOT EXISTS)

This utility would be consumed by: PDG database (existing), Memory Graph (EVO-20),
Gene Library (EVO-19), Strategy Stats (EVO-21).

**Severity**: Medium — design can proceed; implementation needs M-06 expanded.

### Gap 3: H-18 ArtifactRef Extension for Gene/Capsule

**Current state**: H-18 ArtifactRef V1 defines `{component, kind, id, sha256, size_bytes}`.
The `kind` field needs to be extended to support Gene and Capsule artifact types.

**Impact**: EVO-19 capsules need ArtifactRef to reference their content (patches, diffs).
EVO-12a evidence traces use ArtifactRef to reference specific trace events.

**Recommended action**: Add new `kind` values to H-18's artifact kind enumeration:
- `gene` — Gene definition artifact
- `capsule` — Capsule content (diff/patch)
- `trace_event` — Individual trace event reference
- `skill_proposal` — Skill proposal artifact

This is a schema field addition, not a structural change.

**Severity**: Low — ArtifactRef is designed to be extensible. Adding `kind` values
does not break existing consumers.

### Gap 4: EVO-20 Dependency on EVO-17 vs M-06 — **RESOLVED**

**Current state**: The remediation tracker previously listed EVO-20 depending on
`EVO-17` (REP SDK). This has been resolved: EVO-20's dependency table now lists
only M-06 (SQLite WAL), H-02 (trace_id), and H-18 (ArtifactRef V1).

**Resolution**: Track A types (research_idea, computation, etc.) have been removed
from the EVO-20 core schema. They are now runtime-extensible — consuming tracks
register their own node/edge types. This eliminates the EVO-17 dependency entirely.
EVO-17 consumes EVO-20, not the reverse.

**Severity**: Resolved — no longer affects Phase 5 ordering.

### Gap 5: Trace-JSONL Indexing for Pattern Detection (Phase 2)

**Current state**: trace-jsonl stores events as append-only JSONL files. Querying a specific time window requires sequential O(N) scanning of the entire file.

**Impact**: EVO-12a `loadTraceEvents(traceWindow)` will lock the orchestrator under long-lived agent memory with millions of accumulated events. This is a performance blocker for production use.

**Recommended action**: Add a trace index requirement to the trace-jsonl deliverable:
1. SQLite-backed index with columns: `event_id`, `event_type`, `ts`, `run_id`, `offset` (byte offset into JSONL)
2. Index is built incrementally as events are appended
3. `queryEvents(window)` reads the index first, then seeks to relevant JSONL offsets

**Severity**: High — blocks EVO-12a implementation for production-scale repos.

### Items NOT Requiring Changes

1. **trace/ledger format sufficiency**: The trace-jsonl transport format (JSONL with
   structured fields) is sufficient. Only the event type enumeration needs addition
   (Gap 1). The ledger event format (H-10) is separate and adequate.

2. **SQLite WAL concurrency**: WAL mode with `busy_timeout=5000` is sufficient for
   the expected concurrency pattern (single writer, multiple readers). No fundamental
   concurrency changes needed — just scope expansion (Gap 2).

3. **Schema field additions**: Beyond the H-18 `kind` extension (Gap 3), no existing
   schemas need structural changes. The new schemas (memory_graph_*, gene_v1,
   capsule_v1, skill_proposal_v2, mutation_proposal_v1, strategy_state_v1) are
   all new files, not modifications to existing schemas.
