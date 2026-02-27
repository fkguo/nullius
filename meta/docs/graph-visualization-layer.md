# Graph Visualization Layer — Design Document

> **Status**: Approved (dual-model convergence: Codex READY + Gemini READY after 9 rounds)
> **Branch**: `design/graph-viz`
> **Review history**:
>   - R1: Codex NOT_READY, Gemini NOT_READY
>   - R2: Codex NOT_READY (4), Gemini READY
>   - R3: Codex NOT_READY (3), Gemini NOT_READY (2)
>   - R4: Codex NOT_READY (3), Gemini READY (all 5/5)
>   - R5: Codex NOT_READY (3 text-consistency), Gemini READY (all 5/5)
>   - R6: Codex NOT_READY (3 specific bugs), Gemini READY (all 5/5)
>   - R7: Codex NOT_READY (2), Gemini NOT_READY (2)
>   - R8: Codex NOT_READY (2), Gemini READY (all 5/5)
>   - R9: Codex READY, Gemini READY (all 5/5) — **CONVERGED**

## 1. Motivation

Five subsystems in Autoresearch produce typed directed graphs:

| Subsystem | Node types | Edge types | Source format |
|---|---|---|---|
| Claim DAG | claim (with status) | supports, contradicts, requires, fork, supersedes, competitor | claims.jsonl + edges.jsonl |
| Memory Graph (EVO-20) | signal, gene, capsule, outcome, skill, module, ... | resolved_by, confidence, co_change, supersedes, ... | SQLite (mg_nodes/mg_edges) |
| Literature graph | paper | cites, extends, contradicts, reviews | INSPIRE API JSON |
| Idea map | idea_node, claim, evidence, formalism | parent_of, supports, refutes, mentions, derived_from | nodes_latest.json + artifacts/ |
| Progress graph | milestone, task | depends_on | RESEARCH_PLAN.md task board |

The existing `render_claim_graph.py` (~458 LOC) already does `typed nodes + typed edges → Graphviz DOT/PNG/SVG`. This design extracts a domain-agnostic core and defines per-domain adapters.

## 2. Universal Node/Edge Schema

### 2.1 UniversalNode

```typescript
/** Domain-agnostic graph node. All domain-specific semantics are in metadata. */
interface UniversalNode {
  /** Unique ID within the graph (must be DOT-safe after escaping). */
  id: string;

  /** Domain-specific type string (e.g. "claim", "gene", "paper"). */
  type: string;

  /** Human-readable display label. */
  label: string;

  /** Optional grouping key for subgraph/cluster rendering. */
  group?: string;

  /** Optional status string driving shape/color styling. */
  status?: string;

  /** Weight in [0, 1]. Maps to visual size or opacity. */
  weight?: number;

  /** Opaque domain-specific data (not used by renderer). */
  metadata?: Record<string, unknown>;
}
```

### 2.2 UniversalEdge

```typescript
/** Domain-agnostic graph edge. Supports multigraphs via optional id. */
interface UniversalEdge {
  /** Optional unique ID for this edge. Required for multigraph support
   *  (multiple edges between the same pair of nodes). */
  id?: string;

  /** Source node ID. */
  source: string;

  /** Target node ID. */
  target: string;

  /** Domain-specific edge type (e.g. "supports", "resolved_by"). */
  type: string;

  /** Optional edge label. Defaults to type if omitted. */
  label?: string;

  /** Weight in [0, 1]. Maps to line width or opacity. */
  weight?: number;

  /** Whether the edge is directed. Default: true. */
  directed?: boolean;

  /** Opaque domain-specific data. */
  metadata?: Record<string, unknown>;
}
```

### 2.3 UniversalGraph (container)

```typescript
interface UniversalGraph {
  /** Graph title (used in DOT graph label). */
  title?: string;

  /** Optional graph-level metadata (not used by renderer). */
  metadata?: Record<string, unknown>;

  nodes: UniversalNode[];
  edges: UniversalEdge[];
}
```

### 2.4 StyleSheet (adapter-provided)

The renderer itself is domain-agnostic. Domain-specific visual mapping is injected
via a `StyleSheet`:

```typescript
interface NodeStyle {
  shape?: string;          // DOT shape: box, ellipse, octagon, diamond, ...
  fillColor?: string;      // hex color
  borderColor?: string;    // hex color
  borderStyle?: 'solid' | 'dashed' | 'dotted';
  borderWidth?: number;
  peripheries?: number;    // 1 or 2 (double border)
  fontColor?: string;
}

interface EdgeStyle {
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  fontColor?: string;
  penWidth?: number;
  arrowHead?: string;      // DOT arrowhead name
}

interface StyleSheet {
  /** Map node (type, status) → visual style. */
  nodeStyle(node: UniversalNode): NodeStyle;

  /** Map edge type → visual style. */
  edgeStyle(edge: UniversalEdge): EdgeStyle;

  /** Map edge type → display label. Allows renaming (e.g. "requires" → "enables"). */
  edgeLabel?(edge: UniversalEdge): string;

  /** Whether to reverse edge direction for certain types (workflow-forward rendering). */
  reverseEdge?(edge: UniversalEdge): boolean;
}
```

**Default/fallback policy**: Every `StyleSheet` MUST return a sensible default for
unknown types and statuses. The renderer never throws on unrecognized type/status
values. Adapters for subsystems with runtime-extensible types (Memory Graph, idea-core)
MUST implement a catch-all fallback (e.g., grey box for unknown node type, grey solid
line for unknown edge type).

## 3. Renderer Core

### 3.1 Responsibilities

The renderer core (`render.ts`, ≤200 eLOC) takes `UniversalGraph + StyleSheet + RenderOptions` and produces:

1. DOT source string
2. Optional PNG/SVG via `dot` subprocess

It handles:
- DOT escaping, label wrapping/truncation
- Subgraph clustering (from `node.group`)
- Legend generation (embedded or separate, auto-threshold)
- Graphviz subprocess invocation

It does NOT handle:
- Data loading (adapter responsibility)
- Domain-specific styling logic (StyleSheet responsibility)
- Any domain-specific types or enums

### 3.2 RenderOptions

```typescript
interface RenderOptions {
  /** Output DOT path. */
  outDot?: string;

  /** Output PNG path (requires graphviz). */
  outPng?: string;

  /** Output SVG path (requires graphviz). */
  outSvg?: string;

  /** Graph direction: LR (default) or TB. */
  rankDir?: 'LR' | 'TB';

  /** Graphviz layout engine. Default: 'dot'. */
  layoutEngine?: 'dot' | 'neato' | 'fdp' | 'sfdp' | 'circo' | 'twopi';

  /** Max label length (0 = no truncation). Default: 80. */
  maxLabel?: number;

  /** Wrap labels at this width (0 = no wrap). Default: 34. */
  wrapWidth?: number;

  /** Disable all color (grayscale-safe output). Default: false. */
  noColor?: boolean;

  /** Legend mode. Default: 'auto'. */
  legend?: 'auto' | 'embedded' | 'separate' | 'none';

  /** Auto-embed legend if node count ≤ this value. Default: 30. */
  legendThreshold?: number;
}
```

### 3.3 API

```typescript
/** Render a UniversalGraph to DOT string (+ optional PNG/SVG files). */
function renderGraph(
  graph: UniversalGraph,
  style: StyleSheet,
  options?: RenderOptions
): string;  // returns DOT source
```

Single function. No classes. The renderer is stateless.

### 3.4 Adapter Interface

Each adapter exports a function conforming to this interface (defined in `types.ts`):

```typescript
/** Adapter: loads domain data and converts to UniversalGraph + StyleSheet. */
interface Adapter {
  /** Unique adapter name (used in CLI --adapter flag). */
  name: string;

  /** Load domain data from args/paths and produce a renderable graph. */
  adapt(args: Record<string, string>): Promise<{
    graph: UniversalGraph;
    style: StyleSheet;
  }>;
}
```

The CLI entrypoint (`bin/graph-viz.ts`) maintains a registry of `Adapter` instances
and dispatches to the selected adapter. The `Adapter` interface lives in
`packages/shared/src/graph-viz/types.ts` (domain-agnostic); concrete adapter
implementations live in `packages/shared/` (see §5.1 for exact placement).

### 3.5 Operational Contracts

**Input validation** (renderer enforces before generating DOT):
- Duplicate node IDs → error
- Dangling edges (source/target referencing non-existent node) → warning + skip edge
- `weight` outside [0, 1] → clamp to [0, 1] with warning
- Empty graph (0 nodes) → return empty DOT with graph title only

**Graphviz availability**: `graphviz.ts` checks `which dot` before subprocess
invocation. If `dot` is not found: write `.dot` file, log warning, skip PNG/SVG
generation. Never throw on missing `dot` binary.

**Deterministic output**: Node/edge ordering in DOT follows insertion order from
`UniversalGraph.nodes` / `UniversalGraph.edges`. Legend entries are ordered by
first-appearance of each type/status. This ensures diffable, reproducible DOT.

**Adapter ordering contract**: Every adapter MUST produce nodes and edges in a
deterministic, stable order. For file-based adapters (claim, progress, literature,
idea-map), insertion order from the source file provides this naturally. For
database-backed adapters (Memory Graph), the `exportGraph()` query MUST include an
explicit `ORDER BY id` clause on both nodes and edges to guarantee reproducible
ordering across calls.

## 4. Adapter Specifications

Each adapter is a function: `domain data → UniversalGraph + StyleSheet`.

**Adapter placement rule**: All adapters live in `packages/shared/`. JSON-parsing
adapters (claim, progress, literature, idea-map) live in `graph-viz/adapters/`
since they have zero TypeScript imports from domain packages. The Memory Graph
adapter lives in `memory-graph/viz-adapter.ts` since it imports the `exportGraph()`
API. See §5.1 for the full placement rationale.

### 4.1 Claim DAG Adapter

**Source**: `knowledge_graph/claims.jsonl` + `knowledge_graph/edges.jsonl`
**Location**: `packages/shared/src/graph-viz/adapters/claim-dag.ts`

**Node mapping**:

| claims.jsonl field | UniversalNode field |
|---|---|
| `id` | `id` |
| `"claim"` (constant) | `type` |
| `id + "\n" + statement` | `label` |
| `status` | `status` |
| entire claim object | `metadata` |

**Edge mapping**:

| edges.jsonl field | UniversalEdge field |
|---|---|
| `source + "→" + target + ":" + type` | `id` |
| `source` | `source` |
| `target` | `target` |
| `type` | `type` |
| `type` (or renamed) | `label` |

**StyleSheet** (ported from render_claim_graph.py — ALL statuses from check_claim_graph.py):

| Status | Fill | Border | Shape | Extra |
|---|---|---|---|---|
| verified | #e8f5e9 | #2e7d32 | box | peripheries=2 |
| verified_with_dissent | #fff8e1 | #ff8f00 | box | peripheries=2, dashed |
| active | #e3f2fd | #1565c0 | box | penwidth=1.6 |
| under_review | #eeeeee | default | box | dotted |
| draft | #f5f5f5 | default | box | dashed |
| paused | #f5f5f5 | default | box | dotted, fontcolor=#555 |
| stalled | #f5f5f5 | default | box | dotted, fontcolor=#555 |
| archived | #f5f5f5 | default | box | dotted, fontcolor=#555 |
| superseded | #eceff1 | #546e7a | box | dotted, fontcolor=#555 |
| refuted | #ffebee | #c62828 | octagon | penwidth=2.2 |
| disputed | #fce4ec | #ad1457 | diamond | dashed, penwidth=2.0 |
| (unknown) | #ffffff | #444444 | box | (default fallback) |

| Edge type | Color | Style | Display label |
|---|---|---|---|
| supports | #2e7d32 | solid | supports |
| contradicts | #c62828 | dashed | contradicts |
| requires | #555555 | solid | enables (workflow-forward) |
| competitor | #ef6c00 | dashed | competitor |
| fork | #1565c0 | dotted | fork |
| supersedes | #546e7a | solid | superseded by (workflow-forward) |
| (unknown) | #555555 | solid | (type string as-is) |

**reverseEdge**: `true` for `requires` and `supersedes` (workflow-forward rendering).

### 4.2 Memory Graph Adapter

**Source**: MemoryGraph `exportGraph()` (§7.2) — NOT direct SQLite
**Location**: `packages/shared/src/memory-graph/viz-adapter.ts` (colocated with
MemoryGraph service; see §5.1 for dependency direction rationale)

**Node mapping** (from `MemoryGraphNode` via export API):

| MemoryGraphNode field | UniversalNode field |
|---|---|
| `id` | `id` |
| `node_type` | `type` |
| `payload.name \|\| payload.gene_id \|\| node_type + ":" + id` | `label` |
| `track` | `group` (cluster by track: a/b/shared) |
| derived from `weight` | `status` ("active" if weight>0.5, "decaying" if 0.1-0.5, "archived" if <0.1) |
| `weight` | `weight` |
| `payload` | `metadata` |

**Edge mapping** (from `MemoryGraphEdge` via export API):

| MemoryGraphEdge field | UniversalEdge field |
|---|---|
| `id` | `id` |
| `source_id` | `source` |
| `target_id` | `target` |
| `edge_type` | `type` |
| `edge_type` | `label` |
| `weight` | `weight` |
| `payload` | `metadata` |

**StyleSheet** (ALL built-in types from EVO-20 §2/§3 + fallback):

| Node type | Shape | Fill |
|---|---|---|
| signal | hexagon | #fff3e0 |
| gene | box | #e8f5e9 |
| capsule | ellipse | #e3f2fd |
| outcome | diamond | success→#c8e6c9, fail→#ffcdd2 |
| skill | doubleoctagon | #f3e5f5 |
| module | folder | #eceff1 |
| test | triangle | #e8eaf6 |
| approval_pattern | house | #fce4ec |
| (unknown/extension) | box | #f5f5f5 (grey fallback) |

| Edge type | Color | Style |
|---|---|---|
| triggered_by | #9e9e9e | solid |
| confidence | #1565c0 | solid (penWidth from weight) |
| resolved_by | #2e7d32 | solid |
| produced | #555555 | solid |
| supersedes | #546e7a | solid |
| generalizes | #7b1fa2 | dashed |
| spawned_skill | #f3e5f5 | dotted |
| co_change | #ff8f00 | dashed |
| failure_in | #c62828 | dashed |
| (unknown/extension) | #9e9e9e | solid (grey fallback) |

### 4.3 Literature Graph Adapter

**Source**: INSPIRE API output (from `inspire_research_navigator` / `inspire_literature` tools)
**Location**: `packages/shared/src/graph-viz/adapters/literature.ts`

**Node mapping**:

| INSPIRE field | UniversalNode field |
|---|---|
| `recid` | `id` |
| `"paper"` | `type` |
| `first_author + " (" + year + ")"` | `label` |
| arXiv category or journal | `group` |
| citation_count bucket | `status` ("seminal" >500, "influential" >100, "notable" >20, "standard" else) |
| `log10(max(citation_count, 1)) / 4` clamped to [0,1] | `weight` |
| full record | `metadata` |

**Note**: `max(citation_count, 1)` ensures `log10` is always defined (avoids
`log10(0) = -Infinity`). Papers with `citation_count=0` or `null` get `weight=0`.

**Edge mapping** (from citation network / `inspire_research_navigator` connections output):

| Field | UniversalEdge field |
|---|---|
| `citing_recid + "→" + cited_recid + ":" + type` | `id` (multigraph-safe) |
| citing recid | `source` |
| cited recid | `target` |
| relation type | `type` ("cites", "extends", "contradicts", "reviews") |
| relation type | `label` |

**StyleSheet**:

| Status | Shape | Fill |
|---|---|---|
| seminal | doubleoctagon | #fff9c4 |
| influential | box | #e8f5e9 |
| notable | box | #e3f2fd |
| standard | ellipse | #f5f5f5 |

| Edge type | Color | Style | Notes |
|---|---|---|---|
| cites | #555555 | solid | default citation |
| extends | #2e7d32 | solid | builds upon |
| contradicts | #c62828 | dashed | tension/disagreement |
| reviews | #1565c0 | dotted | review/survey |
| (unknown) | #9e9e9e | solid | grey fallback |

### 4.4 Idea Map Adapter

**Source**: Composite from two idea-core data stores:
1. `nodes_latest.json` — IdeaNode lineage (parent_node_ids, operator_family, idea_card)
2. `IdeaEvidenceGraph` artifacts — claim/evidence provenance (supports/refutes/mentions/derived_from)

The adapter synthesizes a unified graph from both sources. Formalism nodes and
`parent_of` / `uses_formalism` edges are **derived by the adapter** from IdeaNode
fields (`parent_node_ids`, `idea_card.candidate_formalisms`), NOT from the evidence
graph schema (which only defines kinds `claim|evidence|idea_node` and relations
`supports|refutes|mentions|derived_from`).

**ID namespacing** (prevents cross-source collision, required since renderer treats
duplicate IDs as error):

| Source | ID prefix | Example |
|---|---|---|
| `nodes_latest.json` IdeaNode | `idea:` | `idea:node_42` |
| `IdeaEvidenceGraph` claim/evidence | `ev:` | `ev:claim_17` |
| Adapter-derived formalism | `form:` | `form:lattice_qcd` |

Evidence graph nodes with `kind=idea_node` are **not emitted** as separate nodes;
they are resolved to the corresponding `idea:*` node from `nodes_latest.json`. This
dedup rule ensures exactly one node per idea, even when both sources reference it.

**Location**: `packages/shared/src/graph-viz/adapters/idea-map.ts`

**Node mapping** (from `nodes_latest.json` IdeaNode):

| IdeaNode field | UniversalNode field | Notes |
|---|---|---|
| `"idea:" + node_id` | `id` | **namespaced** (e.g., `idea:node_42`) |
| `"idea_node"` | `type` | |
| `idea_card.thesis_statement` (truncated) | `label` | |
| `operator_family` | `group` | cluster by Seed/Ideator/Formalizer |
| derived from pipeline stage | `status` | "seed" / "refined" / "formalized" / "evaluated" |
| `avg(eval_info.scores)` or `0` if unevaluated | `weight` | NaN → 0 fallback |
| full IdeaNode | `metadata` | |

**Node mapping** (from `IdeaEvidenceGraph` nodes):

| EvidenceGraph node field | UniversalNode field | Notes |
|---|---|---|
| `"ev:" + id` | `id` | **namespaced** (e.g., `ev:claim_17`) |
| `kind` ("claim" / "evidence") | `type` | `idea_node` kind → skip (resolved to `idea:*` node) |
| `label` | `label` | |

**Adapter-derived nodes** (NOT from evidence graph schema):

| Derived from | UniversalNode field | Notes |
|---|---|---|
| `idea_card.candidate_formalisms[]` | `type` = "formalism", `id` = `"form:" + formalism_name` | **namespaced** (e.g., `form:lattice_qcd`) |

**Edge mapping** (from `IdeaEvidenceGraph` edges — schema-defined):

| EvidenceGraph edge field | UniversalEdge field | Notes |
|---|---|---|
| auto-generated | `id` | |
| `"ev:" + from` or `"idea:" + from` | `source` | remapped to namespaced ID |
| `"ev:" + to` or `"idea:" + to` | `target` | remapped to namespaced ID |
| `relation` | `type` | "supports" / "refutes" / "mentions" / "derived_from" |
| `relation` | `label` | |
| `confidence` | `weight` | |

**Edge endpoint resolution**: The adapter resolves each `from`/`to` reference to its
namespaced node ID. If the referenced node has `kind=idea_node`, it maps to `idea:*`
(the canonical IdeaNode). If `kind=claim` or `kind=evidence`, it maps to `ev:*`.
If a referenced ID exists in neither source, the edge is **skipped with a warning**
(consistent with renderer's dangling-edge policy in §3.5).

**Adapter-derived edges** (NOT from evidence graph schema):

| Derived from | UniversalEdge type | Source → Target | Notes |
|---|---|---|---|
| IdeaNode `parent_node_ids[]` | `parent_of` | `idea:<parent>` → `idea:<child>` | parent → child direction |
| IdeaCard `candidate_formalisms[]` | `uses_formalism` | `idea:<node>` → `form:<formalism>` | namespaced |

**StyleSheet**:

| Node type | Shape | Fill |
|---|---|---|
| idea_node | box | stage-dependent (#fff3e0→#e8f5e9→#e3f2fd→#f3e5f5) |
| claim | ellipse | #e8eaf6 |
| evidence | note | #fce4ec |
| formalism | component | #e0f2f1 |

| Edge type | Color | Style |
|---|---|---|
| parent_of | #555555 | solid |
| supports | #2e7d32 | solid |
| refutes | #c62828 | dashed |
| mentions | #9e9e9e | dotted |
| derived_from | #1565c0 | solid |
| uses_formalism | #00695c | dotted |

### 4.5 Progress Graph Adapter

**Source**: `RESEARCH_PLAN.md` task board + progress log (Markdown format, the
canonical progress tracking artifact in research-team).

**Canonical input schema** (adapter accepts structured JSON parsed from RESEARCH_PLAN.md):

```typescript
interface ProgressItem {
  id: string;                    // e.g. "M0", "T1", "T2"
  type: 'milestone' | 'task';
  title: string;
  workstream?: string;           // e.g. "A", "B", "shared"
  status: 'converged' | 'active' | 'pending' | 'blocked';
  depends_on?: string[];         // IDs of dependencies
}
```

**Parsing contract** (for the external parser that produces `ProgressItem[]`):

The parser reads `RESEARCH_PLAN.md` and extracts items from two structural elements:

1. **Task Board checkboxes** (under `## Task Board` heading):
   Lines matching `- [x] T<n>: <description>` or `- [ ] T<n>: <description>`:
   - `id`: task label (e.g., `"T1"`, `"T2"`, `"T3"`)
   - `type`: `"task"`
   - `title`: description text after `T<n>:`
   - `status`: `[x]` → resolved via progress log; `[ ]` → `"pending"` (default)

2. **Progress Log entries** (under `## Progress Log` heading):
   Lines matching `- <date> tag=<TAG> status=<converged|not_converged> task=<Tn> note=<text>`:
   - Status override: `status=converged` → set task `status` to `"converged"`
   - Status override: `status=not_converged` → set task `status` to `"active"`
   - Latest entry wins (multiple entries for same task → use last)

3. **Milestone headings** (matching `### M<n> — <title>`):
   - `id`: milestone number (e.g., `"M0"`)
   - `type`: `"milestone"`
   - `title`: text after `—`
   - `depends_on`: `["T1", "T2", "T3"]` (all tasks under the milestone heading)

**Task→milestone association**: Tasks (`T<n>`) listed under a milestone heading
(`### M<n>`) are associated with that milestone. The milestone's `depends_on` array
includes all its task IDs.

**Milestone status reduction** (deterministic, derived from associated task statuses):

The milestone status is computed by evaluating conditions in order (first match wins):

| # | Condition | Milestone status | Rule |
|---|---|---|---|
| 1 | No tasks under milestone (empty) | `pending` | No work defined yet |
| 2 | Any task `blocked` | `blocked` | Blocked propagates up |
| 3 | All tasks `converged` | `converged` | All children done |
| 4 | Any task `active` | `active` | Work in progress |
| 5 | Mix of `converged` + `pending` (none active/blocked) | `active` | Partial progress implies active |
| 6 | All tasks `pending` | `pending` | Not started |

**Note**: Row 5 maps `{converged, pending}` to `active` because partial completion
implies work has started, even if no task is individually marked `active`. This is
NOT a "highest priority wins" rule — it is a sequential condition check.

Progress log entries with `tag=milestone` and `status=converged` override the
reduction (explicit milestone convergence takes precedence).

**Status derivation summary**:

| Source | Condition | `ProgressItem.status` |
|---|---|---|
| Progress log | `status=converged` | `converged` |
| Progress log | `status=not_converged` | `active` |
| Task board | `[x]` with no progress log | `converged` |
| Task board | `[ ]` with no progress log | `pending` |
| (blocked) | explicit `BLOCKED:` note in log | `blocked` |

The parser outputs a JSON file conforming to `ProgressItem[]`. The adapter validates
this JSON against the `ProgressItem` schema at load time and rejects malformed input
with exit code 2 (parse error).

**Parser implementation**: `packages/shared/src/graph-viz/parse-progress.ts` (~100 eLOC).
The CLI `--adapter progress` flag accepts either pre-parsed JSON (`--plan <path.json>`)
or raw Markdown (`--plan <path.md>`). When a `.md` file is provided, the CLI invokes
`parse-progress.ts` automatically before passing the result to the adapter.

**Location**: `packages/shared/src/graph-viz/adapters/progress.ts`

**Node mapping**:

| ProgressItem field | UniversalNode field |
|---|---|
| `id` | `id` |
| `type` | `type` |
| `title` | `label` |
| `workstream` | `group` |
| `status` | `status` |
| 1.0 if converged, 0.5 if active, 0.0 if pending/blocked | `weight` |

**Edge mapping**:

| Derived from | UniversalEdge field |
|---|---|
| `source + "→" + target + ":depends_on"` | `id` |
| dependent ID | `source` |
| dependency ID (from `depends_on[]`) | `target` |
| `"depends_on"` | `type` |
| `"enables"` | `label` (workflow-forward after reversal) |

**reverseEdge**: `true` for `depends_on` (renders workflow-forward: dependency → dependent).
The display label is `"enables"` (not `"depends on"`) because after visual reversal the
arrow points from dependency to dependent, matching the "enables" semantic direction.
This follows the same pattern as Claim DAG's `requires → "enables"` reversal.

**StyleSheet**:

| Status | Shape | Fill | Border |
|---|---|---|---|
| converged | box | #e8f5e9 | #2e7d32 |
| active | box | #e3f2fd | #1565c0 |
| blocked | octagon | #ffebee | #c62828 |
| pending | box | #f5f5f5 | #9e9e9e |
| milestone (type) | doubleoctagon | (status color) | (status color) |

## 5. Architecture Placement

### 5.1 Decision: Core + JSON adapters in `packages/shared/`, CLI at monorepo root

The visualization **core** (types + renderer + graphviz wrapper) and **JSON-parsing
adapters** (claim, progress, literature, idea-map) live in `packages/shared/`.
These adapters have **zero TypeScript imports from domain packages** — they parse
plain JSON/JSONL files and map fields, with no compile-time dependency on domain
modules.

The **CLI entrypoint** (with adapter registry) lives at the monorepo root
(`bin/graph-viz.ts`), which imports from `shared` only — no cross-layer boundary
violations.

**Dependency direction rule**: `packages/shared/src/graph-viz/` (including adapters)
must have **zero imports** from any domain module outside `packages/shared/`. The
Memory Graph adapter is colocated with the MemoryGraph service (also in `shared`).

**Dependency direction**:
```
bin/graph-viz.ts  (CLI entrypoint — monorepo root)
  └── imports packages/shared/src/graph-viz/   (types + renderer + all adapters)

packages/shared/src/graph-viz/
  ├── core: types.ts, render.ts, graphviz.ts   (zero external imports)
  └── adapters/: claim-dag.ts, progress.ts,    (zero external imports — parse JSON only)
      literature.ts, idea-map.ts

packages/shared/src/memory-graph/
  └── viz-adapter.ts                           (imports graph-viz/types.ts only)
```

### 5.2 File Layout (CODE-01 compliant, ≤200 eLOC each)

**Shared core + adapters** (all in `packages/shared/`, zero external domain imports):
```
packages/shared/src/graph-viz/
├── index.ts                    -- re-exports (CODE-01 rule 3)
├── types.ts                    -- UniversalNode, UniversalEdge, UniversalGraph,
│                                  StyleSheet, NodeStyle, EdgeStyle, RenderOptions,
│                                  Adapter interface (~80 eLOC)
├── render.ts                   -- renderGraph(): graph + style + options → DOT string (~160 eLOC)
├── graphviz.ts                 -- runDot(): DOT → PNG/SVG subprocess + availability check (~50 eLOC)
├── parse-progress.ts           -- RESEARCH_PLAN.md → ProgressItem[] parser (~100 eLOC)
└── adapters/
    ├── claim-dag.ts            -- Claim DAG adapter + stylesheet (~90 eLOC)
    ├── progress.ts             -- Progress graph adapter + stylesheet (~70 eLOC)
    ├── literature.ts           -- Literature graph adapter + stylesheet (~80 eLOC)
    └── idea-map.ts             -- Idea Map adapter + stylesheet (~100 eLOC)
```

**Memory Graph adapter** (colocated with MemoryGraph service):
```
packages/shared/src/memory-graph/
└── viz-adapter.ts              -- Memory Graph adapter + stylesheet (~100 eLOC)
```

**CLI entrypoint** (monorepo root — composes adapters, parses args):
```
bin/
└── graph-viz.ts                -- arg parsing, adapter registry, invoke render (~120 eLOC)
```

**Estimated total**: ~950 eLOC across 11 implementation files, all ≤200 eLOC.

### 5.3 REDESIGN_PLAN Placement

**Suggested REDESIGN_PLAN item**:

> **NEW-VIZ-01: Graph Visualization Core**
>
> - **Phase**: 2 (depends on NEW-05 monorepo structure)
> - **Priority**: Medium
> - **Depends on**: NEW-05 (monorepo), EVO-20 (Memory Graph types)
> - **Description**: Extract domain-agnostic graph renderer from `render_claim_graph.py`,
>   define universal node/edge schema. Core + adapters in `packages/shared/src/graph-viz/`.
>   CLI entrypoint at `bin/graph-viz.ts`.
> - **eLOC budget**: ≤ 950 (11 files)
> - **Acceptance**: All 5 adapters produce valid DOT; existing claim graph rendering
>   uses the new adapter with identical output (snapshot test parity).

## 6. Rendering Strategy

### 6.1 Decision: Static Only (DOT/PNG/SVG)

**No interactive rendering (D3.js/Mermaid/browser).**

**Rationale**:

1. **Primary consumers are agents + researchers reviewing artifacts.** Agents consume
   structured data (`UniversalGraph` JSON), not interactive visualizations. Researchers
   review static PNGs/SVGs in artifact directories or embedded in Markdown reports.

2. **No web frontend exists.** Autoresearch has no browser UI. Adding one solely for
   graph visualization would be significant infrastructure with no other use case.

3. **Graphviz is proven.** The existing `render_claim_graph.py` uses Graphviz successfully.
   DOT is a well-understood, deterministic, text-diffable format. Layout algorithms
   (dot, neato, fdp) handle the graph sizes in this ecosystem (tens to low hundreds of nodes).

4. **Complexity vs. benefit.** Interactive rendering (D3.js) requires: a web server,
   a build toolchain (bundler, framework), browser launch logic, and ongoing maintenance
   of JavaScript assets. None of this infrastructure exists or is needed elsewhere.

5. **Structured data is the interaction layer.** When an agent needs to "interact" with
   a graph (traverse, filter, query), it uses the structured `UniversalGraph` or the
   domain-specific API (MemoryGraph queries, idea-core traversals). Visual interaction
   would be a poor substitute.

### 6.2 Output Modes

| Mode | Output | Use case |
|---|---|---|
| `dot` | `.dot` file | Debugging, custom rendering, CI diffing |
| `png` | `.png` file | Embedding in Markdown reports, quick viewing |
| `svg` | `.svg` file | Scalable output, web embedding if needed later |
| `json` | `UniversalGraph` JSON | Agent consumption, programmatic access |

### 6.3 Future Extension Point

If interactive visualization becomes necessary (e.g., a dashboard UI in a later phase),
the `UniversalGraph` JSON format is directly consumable by D3.js force-directed layouts
or Mermaid diagram generators. The adapter layer remains unchanged; only a new renderer
backend would be needed.

## 7. Memory Graph Integration

### 7.1 Decision: Via MemoryGraph Service API (§6.6), Not Direct SQLite

**Rationale**:
- `MemoryGraphStore` (§6.5) is explicitly documented as internal
- `MemoryGraph` (§6.6) is the public interface that consuming modules depend on
- Direct SQLite access would violate the storage abstraction and create coupling to
  the SQLite schema (tables, column names, indexes)
- The adapter should work identically regardless of whether the underlying store is
  SQLite, PostgreSQL, or in-memory

### 7.2 Integration Approach: Atomic `exportGraph()`

The **single canonical API** for visualization is `MemoryGraphExport`, extending the
existing `MemoryGraph` (§6.6) service with one atomic export method. This replaces
the earlier two-call design (`exportNodes` + `exportEdges`) which could not guarantee
a consistent snapshot across independent calls.

```typescript
/** Extension to MemoryGraph (§6.6) for visualization export.
 *  Returns a consistent snapshot (nodes + edges read within a single
 *  SQLite transaction to guarantee referential integrity). */
interface MemoryGraphExport {
  /** Export graph topology as a single atomic snapshot.
   *  Both nodes and edges are read within one transaction. */
  exportGraph(filter?: {
    nodeTypes?: string[];
    tracks?: string[];
    edgeTypes?: string[];
    minWeight?: number;
  }): Promise<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>;
}
```

**Snapshot guarantee**: The single `exportGraph()` call executes both queries within
a `BEGIN DEFERRED ... COMMIT` transaction (leveraging M-06 WAL mode). `DEFERRED`
(not `IMMEDIATE`) is used because this is a read-only operation — WAL mode already
provides snapshot isolation for readers without blocking concurrent writers.

**Ordering guarantee**: Both queries include `ORDER BY id` to ensure deterministic,
reproducible node/edge ordering in the exported snapshot. This satisfies the adapter
ordering contract (§3.5) required for diffable DOT output.

**Subgraph closure guarantee**: When filters are applied, `exportGraph()` returns a
**closed subgraph** — every returned edge has both `source_id` and `target_id` present
in the returned node set. Edges referencing nodes excluded by the filter are pruned at
the query level (via `WHERE source_id IN (...) AND target_id IN (...)`). This prevents
dangling edges in the adapter output and avoids relying on the renderer's dangling-edge
skip as a correctness mechanism.

### 7.3 JSONL Export Fallback

For offline/debug use, the adapter also accepts pre-exported JSONL files:

```bash
# Render from exported JSONL
graph-viz render --adapter memory-graph --nodes mg_nodes.jsonl --edges mg_edges.jsonl --out graph.png
```

The JSONL format matches the JSON schemas already defined:
- `memory_graph_node_v1.schema.json` (one node per line)
- `memory_graph_edge_v1.schema.json` (one edge per line)

### 7.4 Integration Sequence

```
┌──────────────┐       exportGraph()         ┌──────────────────┐
│ MemoryGraph  │  ──────────────────────►     │  Memory Graph    │
│ Service      │  (atomic snapshot, DEFERRED) │  Viz Adapter     │
│ (§6.6)       │                              │  (viz-adapter.ts) │
└──────────────┘                              └────────┬─────────┘
                                                       │
                                              UniversalGraph + StyleSheet
                                                       │
                                                       ▼
                                              ┌──────────────────┐
                                              │  Renderer Core   │
                                              │  (render.ts)     │
                                              └────────┬─────────┘
                                                       │
                                                 DOT / PNG / SVG
```

## 8. Invocation Model: CLI + Skill

### 8.1 Decision: Adapter-aware CLI, wrapped by Skill

The graph-viz layer is invoked via a **CLI tool** (`graph-viz render`) that knows
about all registered adapters. Agents learn when/how to call it via a **Skill**.
There is **no MCP wrapping** — graph rendering is a batch operation (input files →
output images), not a real-time stateful service.

**Layer stack**:

```
┌─────────────────────────────────────────────┐
│  Skill (skills/graph-viz/skill.md)          │  ← agent reads this
│  Teaches: when to render, which adapter,    │
│  how to interpret output, integration points│
└──────────────────────┬──────────────────────┘
                       │ agent executes via bash
                       ▼
┌─────────────────────────────────────────────┐
│  CLI  (bin/graph-viz.ts)                    │  ← monorepo root
│  Adapter registry, arg parsing, dispatch    │
└──────────────────────┬──────────────────────┘
                       │ imports (single package)
                       ▼
┌─────────────────────────────────────────────┐
│  packages/shared/src/graph-viz/             │
│  ├── core: types + render + graphviz        │
│  └── adapters/: claim, progress, lit, idea  │
│                                             │
│  packages/shared/src/memory-graph/          │
│  └── viz-adapter.ts                         │
└─────────────────────────────────────────────┘
```

### 8.2 CLI Contract

**Command**:
```bash
graph-viz render --adapter <name> [adapter-specific flags] --out <path> [--format dot|png|svg|json]
```

**Adapter registry** (built-in, no plugin discovery; lazy-loaded via dynamic `import()`
to avoid pulling all domain dependencies when only one adapter is needed):

| `--adapter` name | Adapter module | Required flags |
|---|---|---|
| `claim` | claim-dag.ts | `--claims <path>` `--edges <path>` |
| `memory-graph` | viz-adapter.ts | `--db <sqlite-path>` or `--nodes <jsonl>` `--edges <jsonl>` |
| `literature` | literature.ts | `--input <inspire-json>` |
| `idea-map` | idea-map.ts | `--nodes <path>` `--evidence <path>` |
| `progress` | progress.ts | `--plan <path>` (ProgressItem JSON or RESEARCH_PLAN.md) |

**Common flags**:

| Flag | Default | Description |
|---|---|---|
| `--out <path>` | (required) | Output file path |
| `--format <fmt>` | inferred from `--out` extension | `dot`, `png`, `svg`, `json` |
| `--rank-dir <dir>` | `LR` | Graph direction: `LR` or `TB` |
| `--layout <engine>` | `dot` | Graphviz layout engine |
| `--no-color` | false | Grayscale output |
| `--legend <mode>` | `auto` | `auto`, `embedded`, `separate`, `none` |
| `--max-label <n>` | 80 | Max label length |

**Exit codes**:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Invalid arguments or missing required flags |
| 2 | Input file not found or parse error |
| 3 | Adapter error (mapping failure, invalid data) |
| 4 | Graphviz not installed (DOT file still written) |

**Example invocations**:
```bash
# Claim DAG
graph-viz render --adapter claim \
  --claims knowledge_graph/claims.jsonl \
  --edges knowledge_graph/edges.jsonl \
  --out artifacts/claim_graph.svg

# Memory Graph (from live DB)
graph-viz render --adapter memory-graph \
  --db data/memory_graph.sqlite \
  --out artifacts/memory_graph.png

# Memory Graph (from exported JSONL)
graph-viz render --adapter memory-graph \
  --nodes mg_nodes.jsonl --edges mg_edges.jsonl \
  --out artifacts/memory_graph.png

# Literature graph
graph-viz render --adapter literature \
  --input artifacts/inspire_network.json \
  --out artifacts/literature.svg

# Progress graph
graph-viz render --adapter progress \
  --plan artifacts/progress_items.json \
  --out artifacts/progress.svg --rank-dir TB
```

### 8.3 Skill Specification

The Skill (`skills/graph-viz/skill.md`) teaches agents:

1. **When to render**: After claim convergence milestones, after memory graph updates,
   after literature discovery runs, after idea evaluation cycles, after progress
   board changes.

2. **Which adapter**: Maps research-team workflow stages to adapter names.

3. **Data preparation**: How to produce the input files each adapter expects
   (e.g., "export RESEARCH_PLAN.md task board to `progress_items.json` first").

4. **Output interpretation**: What to look for in the rendered graph (e.g., red
   octagon = refuted claim, thick blue edges = high-confidence links).

5. **Integration points**: Where to place output files in the artifact directory
   structure, how to embed in Markdown reports.

### 8.4 Why Not MCP

| Criterion | MCP tool | CLI + Skill |
|---|---|---|
| Statefulness | Requires running server | Stateless, one-shot |
| Infrastructure | MCP server process | None (just a binary/script) |
| Input size | Must fit in tool call params | Reads files directly |
| Batch rendering | Awkward (one call per graph) | Natural (one command) |
| CI/testing | Needs server mock | Direct invocation |
| Agent integration | Structured params | Skill teaches CLI flags |

Graph rendering is batch, stateless, and file-oriented. MCP adds server overhead
with no compensating benefit. If a future real-time dashboard requires live graph
queries, that would be a separate MCP tool operating on `UniversalGraph` JSON —
the renderer core and adapters remain unchanged.

## 9. Testing Strategy

**Snapshot tests** for `renderGraph()`:
- Construct mock `UniversalGraph` objects with known nodes/edges
- Call `renderGraph()` with a fixed `StyleSheet`
- Assert DOT output matches saved snapshot (string comparison)
- Catches regressions in escaping, ordering, layout, legend generation

**Parity test** for Claim DAG adapter:
- Load a reference `claims.jsonl` + `edges.jsonl` from the existing research-team tests
- Run through Claim DAG adapter + `renderGraph()`
- Compare output DOT against saved snapshot from `render_claim_graph.py`
- Ensures the new adapter produces identical visual output

**Adapter unit tests** (per adapter):
- Test mapping correctness: domain object → `UniversalNode`/`UniversalEdge`
- Test edge cases: empty input, unknown types, null fields, weight=0, weight=1
- Test stylesheet fallback: unrecognized type/status → default style (no error)

## 10. Summary

| Aspect | Decision |
|---|---|
| Core model | `UniversalNode` + `UniversalEdge` (with `id`) + `StyleSheet` + `Adapter` interface |
| Architecture | Core + JSON adapters in `packages/shared/src/graph-viz/`; MG adapter in `memory-graph/`; CLI at `bin/graph-viz.ts` |
| Invocation | Adapter-aware CLI (`graph-viz render --adapter <name>`) wrapped by Skill; no MCP |
| Rendering | Static only: DOT → PNG/SVG via Graphviz |
| Memory Graph | Via atomic `exportGraph()` API (DEFERRED transaction), JSONL fallback |
| Progress Graph | Parsed from `RESEARCH_PLAN.md` task board + progress log; `ProgressItem` schema |
| Idea Map | Composite sources with ID namespacing (`idea:`/`ev:`/`form:`) + edge endpoint resolution |
| REDESIGN_PLAN | Proposed item NEW-VIZ-01, Phase 2, depends on NEW-05 + EVO-20 |
| Budget | ~950 eLOC, 11 files, all ≤200 eLOC (CODE-01 compliant) |
| Adapters | 5 adapters (4 JSON-parsing in shared, 1 API-based in memory-graph) + 1 progress parser |
| Testing | Snapshot tests + parity test + adapter unit tests |

## 11. Future Extension: Graph Compute Layer (派生节点 + 结构化查询)

> **状态**: 仅注记，不做详细设计。详细设计时机：EVO-20 (Memory Graph) 实现时。
> **来源**: GitNexus (github.com/abhigyanpatwari/GitNexus) 知识图谱设计的启发。

NEW-VIZ-01 是纯渲染层。未来在 UniversalGraph 之上需要一层 compute/query 能力：

1. **派生节点生成** — 从基础图的边关系预计算聚类/模式节点（构建时，非查询时）：
   - Claim DAG → argument cluster（共享 supports/contradicts 链的 claim 群）
   - Literature graph → citation community（引用密集的论文群 = research school）
   - Idea map → research direction（共享 evidence/formalism 的 idea 聚类）
   - Memory Graph (EVO-20) → signal pattern（高频 triggered_by 链 = 反复出现的模式）

2. **结构化查询 API** — 类似 GitNexus 的 `impact`/`context` 工具：
   - "这个 claim 的 blast radius"（downstream supports/contradicts 链）
   - "这个 signal pattern 关联了哪些 Gene"（跨节点类型遍历）

**关键设计原则**（借鉴 GitNexus）：预计算 > 实时遍历。对 LLM agent 而言，预计算的聚类节点 = 一次查询完整上下文，实时遍历 = 多轮可能遗漏。

**不影响 NEW-VIZ-01 实现**：派生节点是普通 `UniversalNode`（`type: "claim_cluster"` 等），adapter 产出，renderer 无需感知。
