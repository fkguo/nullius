# EVO-20: Cross-Cycle Memory Graph — Implementation Design

> **Status**: Draft
> **Date**: 2026-02-21
> **Branch**: `redesign/track-b`
> **Priority**: Highest — infrastructure foundation for EVO-19, EVO-12a, EVO-21
> **Ported from**: Evolver `memoryGraph.js` (~771 LOC, MIT License, AutoGame Limited)

## 1. Overview

The Cross-Cycle Memory Graph provides persistent knowledge accumulation across
evolution cycles. It tracks signal → gene → outcome relationships, enabling
compound learning: frequently successful repair strategies are preferred,
repeatedly failing genes are banned, and cross-cycle knowledge persists across runs.

**Key property**: The core graph engine is domain-agnostic. It defines shared
node/edge types (signal, outcome) and tool-evolution types (gene, capsule, skill).
Domain-specific node/edge types (e.g., research concepts for Track A) are
registered at runtime by consuming tracks — they are NOT hardcoded in the core
schema.

## 2. Node Type Enumeration

### 2.1 Core Node Types (shared)

| Type ID | Description | Track |
|---|---|---|
| `signal` | An observed event/condition that triggers evolution | A + B |
| `outcome` | Result of an evolution attempt (success/failure/partial) | A + B |

### 2.2 Track B Node Types (Tool Evolution)

| Type ID | Description | Examples |
|---|---|---|
| `gene` | Reusable repair/optimization strategy template | `fix-import-path`, `add-type-annotation` |
| `capsule` | Verified fix instance (gene application result) | Specific commit fixing a specific error |
| `skill` | Skill definition (EVO-12a integration point) | `md-toc-latex-unescape` |

### 2.3 Runtime-Extensible Node Types

The Memory Graph supports runtime registration of additional node types by
consuming tracks (e.g., Track A may register `research_idea`, `computation`,
`paper_section`, `evidence`). These are NOT defined in the core schema.

Registration API:

```typescript
interface NodeTypeRegistry {
  /** Register a new node type with its payload schema */
  registerNodeType(typeId: string, track: string, payloadSchema?: object): void;

  /** Check if a node type is registered */
  isRegistered(typeId: string): boolean;
}
```

### 2.4 Extension Node Types (future)

| Type ID | Description | Application |
|---|---|---|
| `module` | Source code module/file | Dependency risk heatmap |
| `test` | Test case | Co-change tracking |
| `approval_pattern` | Approval decision pattern | Approval preference learning |

## 3. Edge Type Enumeration

### 3.1 Core Edge Types (shared)

| Type ID | From → To | Semantics |
|---|---|---|
| `triggered_by` | outcome → signal | "This outcome was triggered by this signal" |
| `confidence` | signal → gene/skill | "Historical confidence of this signal-strategy pair" |

### 3.2 Track B Edge Types

| Type ID | From → To | Semantics |
|---|---|---|
| `resolved_by` | signal → gene | "This signal was resolved by this gene" |
| `produced` | gene → capsule | "This gene produced this capsule" |
| `supersedes` | gene → gene | "New gene supersedes old one" |
| `generalizes` | capsule → gene | "Capsule was generalized into gene" (EVO-19) |
| `spawned_skill` | gene → skill | "Repeated gene success spawned this skill" (EVO-12a) |
| `co_change` | module → module | "These modules change together" (extension) |
| `failure_in` | outcome → module | "Failure occurred in this module" (risk heatmap) |

### 3.3 Runtime-Extensible Edge Types

The Memory Graph supports runtime registration of additional edge types by
consuming tracks. For example, a research track may register `supports`,
`contradicts`, `depends_on`, etc. These are NOT defined in the core schema.

Registration follows the same `NodeTypeRegistry` pattern (extended to edges):

```typescript
interface EdgeTypeRegistry {
  registerEdgeType(typeId: string, payloadSchema?: object): void;
  isRegistered(typeId: string): boolean;
}
```

## 4. Storage Scheme

### 4.1 Decision: SQLite Graph Model (not embedded vector)

**Rationale**:
- M-06 (SQLite WAL) already provides the concurrency infrastructure
- Graph queries (path traversal, frequency counting) are relational, not vector-similarity
- Jaccard similarity on signal sets is a set operation, efficiently computed without vector DB
- Vector retrieval adds complexity without benefit for the core use case
- SQLite FTS5 can handle keyword search if needed later

**Hybrid extension point**: If semantic similarity is needed by a consuming
track, a future `embedding` column can be added to the `nodes` table with
sqlite-vss. This is NOT part of the initial implementation.

### 4.2 Schema Design

```sql
-- Core tables
CREATE TABLE mg_nodes (
  id          TEXT PRIMARY KEY,        -- prefixed: mgn_{uuid}
  node_type   TEXT NOT NULL,           -- from node type enum
  track       TEXT NOT NULL,           -- 'a' | 'b' | 'shared'
  payload     TEXT NOT NULL,           -- JSON: type-specific data
  created_at  TEXT NOT NULL,           -- ISO 8601
  updated_at  TEXT NOT NULL,           -- ISO 8601
  decay_ts    TEXT,                    -- last decay recalculation
  weight      REAL NOT NULL DEFAULT 1.0  -- current decay weight
);

CREATE TABLE mg_edges (
  id          TEXT PRIMARY KEY,        -- mge_{uuid}
  edge_type   TEXT NOT NULL,           -- from edge type enum
  source_id   TEXT NOT NULL REFERENCES mg_nodes(id),
  target_id   TEXT NOT NULL REFERENCES mg_nodes(id),
  payload     TEXT NOT NULL DEFAULT '{}',  -- JSON: edge-specific data
  created_at  TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0
);

-- Append-only event log (ported from Evolver JSONL model)
CREATE TABLE mg_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,           -- signal|hypothesis|attempt|outcome|
                                       -- confidence_edge|confidence_gene_outcome|
                                       -- external_candidate
  run_id      TEXT,                    -- nullable (cross-run context)
  trace_id    TEXT,                    -- from H-02
  payload     TEXT NOT NULL,           -- JSON event data
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Aggregated edge statistics (materialized view, ported from aggregateEdges)
CREATE TABLE mg_edge_stats (
  signal_key  TEXT NOT NULL,           -- FNV-1a hash of normalized signal set
  gene_id     TEXT NOT NULL,
  success     INTEGER NOT NULL DEFAULT 0,
  fail        INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  last_ts     TEXT NOT NULL,
  laplace_p   REAL NOT NULL DEFAULT 0.5,  -- (success+1)/(total+2)
  decay_w     REAL NOT NULL DEFAULT 1.0,  -- 0.5^(age_days/half_life_days)
  PRIMARY KEY (signal_key, gene_id)
);

-- Signal frequency tracking (for EVO-12a threshold triggers)
CREATE TABLE mg_signal_freq (
  signal_key    TEXT NOT NULL,
  signal_value  TEXT NOT NULL,         -- individual signal string
  window_start  TEXT NOT NULL,         -- rolling window start
  count         INTEGER NOT NULL DEFAULT 0,
  last_seen     TEXT NOT NULL,
  PRIMARY KEY (signal_key, signal_value, window_start)
);

-- Canonical signal-key → signal-set mapping (for Jaccard matching correctness)
CREATE TABLE mg_signal_sets (
  signal_key       TEXT PRIMARY KEY,
  normalized_signals TEXT NOT NULL,  -- JSON array of normalized signal strings
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Aggregation watermark for incremental edge stat projection (avoids full rescan)
CREATE TABLE mg_aggregation_watermark (
  id              INTEGER PRIMARY KEY CHECK(id=1),
  last_event_id   INTEGER NOT NULL DEFAULT 0
);

-- Indexes
CREATE INDEX idx_mg_nodes_type ON mg_nodes(node_type);
CREATE INDEX idx_mg_nodes_track ON mg_nodes(track);
CREATE INDEX idx_mg_edges_source ON mg_edges(source_id);
CREATE INDEX idx_mg_edges_target ON mg_edges(target_id);
CREATE INDEX idx_mg_edges_type ON mg_edges(edge_type);
CREATE INDEX idx_mg_events_type ON mg_events(event_type);
CREATE INDEX idx_mg_events_run ON mg_events(run_id);
CREATE INDEX idx_mg_events_ts ON mg_events(created_at);
CREATE INDEX idx_mg_edge_stats_gene ON mg_edge_stats(gene_id);
CREATE INDEX idx_mg_signal_freq_value ON mg_signal_freq(signal_value);
CREATE INDEX idx_mg_signal_freq_value_seen ON mg_signal_freq(signal_value, last_seen);
CREATE INDEX idx_mg_signal_sets_key ON mg_signal_sets(signal_key);
```

### 4.3 WAL Concurrency (M-06 Dependency)

- Write path: single writer (evolution engine), append-only events + materialized stat updates
- Read path: concurrent readers (selector, skill genesis detector, dashboard)
- WAL mode enables concurrent reads during writes
- Checkpoint strategy: automatic after every 1000 events or 5 minutes

## 5. Core Algorithms (Ported from Evolver)

### 5.1 Signal Key Computation

Ported from `computeSignalKey()` using FNV-1a hash:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function fnv1aHash(str: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeSignal(sig: string): string {
  return sig
    .replace(/\/[^\s/]+\.(ts|js|py|json)/g, '/<path>')  // normalize file paths
    .replace(/\b\d+\b/g, '<N>')                           // normalize numbers
    .trim()
    .toLowerCase();
}

function computeSignalKey(signals: string[]): string {
  const normalized = signals.map(normalizeSignal);
  normalized.sort();
  return fnv1aHash(normalized.join('|'));
}
```

### 5.2 Exponential Half-Life Decay

Ported from `decayWeight()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const DEFAULT_HALF_LIFE_DAYS = 30;

function decayWeight(
  eventTs: Date,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS
): number {
  const ageDays = (now.getTime() - eventTs.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}
```

**Decay schedule** (half_life = 30 days):

| Age (days) | Weight |
|---|---|
| 0 | 1.000 |
| 7 | 0.851 |
| 30 | 0.500 |
| 60 | 0.250 |
| 90 | 0.125 (≈ TTL threshold) |
| 180 | 0.016 |

**TTL policy**: Nodes with weight < 0.1 are candidates for archival (not deletion).
The 90-day "effective TTL" from REDESIGN_PLAN matches weight ≈ 0.125.

### 5.3 Laplace-Smoothed Success Probability

Ported from `edgeExpectedSuccess()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
function laplaceProbability(success: number, total: number): number {
  return (success + 1) / (total + 2);
}

function edgeExpectedSuccess(stats: EdgeStats, now: Date): {
  p: number;     // Laplace-smoothed probability
  w: number;     // decay weight
  total: number;
  value: number; // p * w (composite score)
} {
  const p = laplaceProbability(stats.success, stats.total);
  const w = decayWeight(new Date(stats.last_ts), now);
  return { p, w, total: stats.total, value: p * w };
}
```

### 5.4 Jaccard Similarity for Signal Matching

Ported from `getMemoryAdvice()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const JACCARD_THRESHOLD = 0.34;

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
```

### 5.5 Memory Advice (Gene Scoring from History)

Ported from `getMemoryAdvice()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const GENE_PRIOR_WEIGHT = 0.12;
const MIN_ATTEMPTS_FOR_BAN = 2;
const BAN_THRESHOLD = 0.18;

interface MemoryAdvice {
  preferredGeneId: string | null;
  bannedGeneIds: string[];
  scores: Map<string, number>;
}

/** Maximum candidate signal keys to evaluate per getMemoryAdvice call.
 *  Prevents O(N) full-table scan on large histories. */
const ADVICE_CANDIDATE_LIMIT = 200;
/** Recency window for candidate prefiltering (days). */
const ADVICE_RECENCY_WINDOW_DAYS = 90;

async function getMemoryAdvice(
  currentSignals: string[],
  store: MemoryGraphStore
): Promise<MemoryAdvice> {
  const currentKey = computeSignalKey(currentSignals);
  const currentSet = new Set(currentSignals.map(normalizeSignal));
  const normalizedSignals = [...currentSet];
  const now = new Date();

  // 1. Bounded candidate selection via SQL prefilter.
  //    Uses mg_signal_freq overlap (indexed) + recency window + LIMIT to
  //    restrict the set of signal_keys evaluated, instead of loading ALL
  //    edge_stats rows into memory.
  //
  //    SQL executed by getCandidateEdgeStats():
  //      WITH candidate_keys AS (
  //        SELECT DISTINCT signal_key
  //        FROM mg_signal_freq
  //        WHERE signal_value IN (?,?,...)
  //          AND last_seen >= datetime('now', '-90 days')
  //        LIMIT ?
  //      )
  //      SELECT s.*, ss.normalized_signals
  //      FROM mg_edge_stats s
  //      JOIN mg_signal_sets ss USING(signal_key)
  //      WHERE s.signal_key IN (SELECT signal_key FROM candidate_keys);
  const statsWithSignals = await store.getCandidateEdgeStats(
    normalizedSignals,
    ADVICE_RECENCY_WINDOW_DAYS,
    ADVICE_CANDIDATE_LIMIT
  );

  const geneScores = new Map<string, number>();
  const geneTotals = new Map<string, number>();

  for (const row of statsWithSignals) {
    const historicalSignals: string[] = JSON.parse(row.normalized_signals);
    const similarity = jaccardSimilarity(
      currentSet,
      new Set(historicalSignals)
    );
    if (similarity < JACCARD_THRESHOLD) continue;

    const { value } = edgeExpectedSuccess(row, now);
    const score = value * similarity;

    const existing = geneScores.get(row.gene_id) ?? 0;
    geneScores.set(row.gene_id, existing + score);
    geneTotals.set(row.gene_id, (geneTotals.get(row.gene_id) ?? 0) + row.total);
  }

  // 2. Batch gene priors: single IN(...) query (eliminates second N+1)
  const geneIds = Array.from(geneScores.keys());
  const genePriors = geneIds.length > 0
    ? await store.getGenePriorsBatch(geneIds)
    : new Map<string, number>();
  for (const [geneId, score] of geneScores) {
    const prior = genePriors.get(geneId) ?? 0;
    geneScores.set(geneId, score + prior * GENE_PRIOR_WEIGHT);
  }

  // 3. Determine preferred and banned genes
  let preferredGeneId: string | null = null;
  let bestScore = 0;
  const bannedGeneIds: string[] = [];

  for (const [geneId, score] of geneScores) {
    const total = geneTotals.get(geneId) ?? 0;
    if (total >= MIN_ATTEMPTS_FOR_BAN && score < BAN_THRESHOLD) {
      bannedGeneIds.push(geneId);
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      preferredGeneId = geneId;
    }
  }

  return { preferredGeneId, bannedGeneIds, scores: geneScores };
}
```

### 5.6 Edge Aggregation

Ported from `aggregateEdges()` — maintains the `mg_edge_stats` table using
incremental projection from the `mg_aggregation_watermark` to avoid rescanning
all outcome events on every call:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
async function aggregateEdges(store: MemoryGraphStore): Promise<void> {
  // 1. Read the high-water mark (last processed event id)
  const watermark = await store.getAggregationWatermark();  // reads mg_aggregation_watermark
  const lastEventId = watermark?.last_event_id ?? 0;

  // 2. Fetch only NEW outcome events since the watermark (ORDER BY id ASC
  //    guarantees monotonic processing for watermark advance)
  const newOutcomes = await store.getEvents({
    event_type: 'outcome',
    id_gt: lastEventId,          // WHERE id > last_event_id
    order_by: 'id ASC',
  });

  if (newOutcomes.length === 0) return;

  // 3. Incrementally update stats using UPSERT
  for (const event of newOutcomes) {
    const { signal_key, gene_id, success } = event.payload;
    const now = new Date();

    // INSERT ... ON CONFLICT(signal_key, gene_id) DO UPDATE
    await store.upsertEdgeStat({
      signal_key,
      gene_id,
      success_delta: success ? 1 : 0,
      fail_delta: success ? 0 : 1,
      last_ts: event.created_at,
      laplace_p_fn: (s: number, t: number) => laplaceProbability(s, t),
      decay_w_fn: (ts: string) => decayWeight(new Date(ts), now),
    });
  }

  // 4. Advance the watermark to the last processed event id
  const maxEventId = newOutcomes[newOutcomes.length - 1].id;
  await store.setAggregationWatermark(maxEventId);
  // SQL: INSERT INTO mg_aggregation_watermark(id, last_event_id) VALUES(1, ?)
  //      ON CONFLICT(id) DO UPDATE SET last_event_id = excluded.last_event_id;
}
```

## 6. Query API

### 6.1 Frequency Queries

```typescript
interface FrequencyQuery {
  /** Top N most frequent signals in the given time window */
  topSignals(windowDays: number, limit: number): Promise<SignalFrequencyResult[]>;

  /** Frequency of a specific signal over time (for trend detection) */
  signalTrend(signal: string, windowDays: number, bucketSize: 'day' | 'week'): Promise<TrendBucket[]>;

  /** Signals exceeding frequency threshold (EVO-12a trigger) */
  highFrequencySignals(threshold: number, windowDays: number): Promise<string[]>;
}
```

**SQL for topSignals**:
```sql
SELECT signal_value, SUM(count) as total_count
FROM mg_signal_freq
WHERE last_seen >= datetime('now', '-' || ? || ' days')
GROUP BY signal_value
ORDER BY total_count DESC
LIMIT ?;
```

### 6.2 Path Queries

```typescript
interface PathQuery {
  /** Find resolution chain: signal → gene → capsule → outcome */
  resolutionPath(signalId: string): Promise<GraphPath[]>;

  /** Find all genes that have resolved similar signals */
  genesForSignal(signals: string[]): Promise<GeneWithScore[]>;

  /** Find dependency chain between nodes (generic graph traversal) */
  dependencyChain(nodeId: string, edgeType: string, depth: number): Promise<GraphPath[]>;

  /** Find co-change patterns for a module */
  coChangePartners(moduleId: string, minCount: number): Promise<CoChangeResult[]>;
}
```

**SQL for coChangePartners** (extension application):
```sql
SELECT e.target_id, n.payload, e.weight
FROM mg_edges e
JOIN mg_nodes n ON e.target_id = n.id
WHERE e.source_id = ? AND e.edge_type = 'co_change'
  AND e.weight >= ?
ORDER BY e.weight DESC;
```

### 6.3 Decay Queries

```typescript
interface DecayQuery {
  /** Get memory advice for current signal set (core Gene selection) */
  getMemoryAdvice(currentSignals: string[]): Promise<MemoryAdvice>;

  /** Get nodes below decay threshold (archival candidates) */
  archivalCandidates(weightThreshold: number): Promise<NodeSummary[]>;

  /** Recalculate all decay weights (batch maintenance) */
  recalculateDecay(halfLifeDays?: number): Promise<{ updated: number }>;
}
```

**SQL for recalculateDecay**:
```sql
UPDATE mg_nodes
SET weight = POWER(0.5, (julianday('now') - julianday(updated_at)) / ?),
    decay_ts = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE weight > 0.01;  -- skip already near-zero nodes
```

### 6.4 Event Recording API

```typescript
interface EventRecorder {
  /**
   * Record observed signals (from signal extraction engine).
   *
   * In addition to inserting a 'signal' event into mg_events, this method MUST
   * UPSERT into mg_signal_sets(signal_key, normalized_signals) so that
   * getCandidateEdgeStats (§5.5) can retrieve historical signal sets via a
   * bounded CTE + JOIN query instead of issuing per-row N+1 lookups. The
   * signal_key is computed via computeSignalKey(signals) and
   * normalized_signals is the JSON-serialized sorted array of
   * normalizeSignal(sig) for each signal.
   */
  recordSignalSnapshot(runId: string, signals: string[]): Promise<void>;

  /** Record gene selection hypothesis */
  recordHypothesis(runId: string, geneId: string, signals: string[]): Promise<void>;

  /** Record evolution attempt start */
  recordAttempt(runId: string, geneId: string): Promise<void>;

  /** Record attempt outcome */
  recordOutcome(runId: string, geneId: string, outcome: OutcomePayload): Promise<void>;

  /** Record confidence edge update */
  recordConfidenceEdge(signalKey: string, geneId: string, success: boolean): Promise<void>;
}
```

### 6.5 MemoryGraphStore Interface (store.ts — internal SQLite backend)

```typescript
interface MemoryGraphStore {
  // --- Edge stats ---
  getAllEdgeStats(): Promise<EdgeStat[]>;
  /** Bounded candidate query: prefilters signal_keys via mg_signal_freq overlap
   *  + recency window + LIMIT, then JOINs mg_edge_stats with mg_signal_sets.
   *  Replaces unbounded getEdgeStatsWithSignalSets(). */
  getCandidateEdgeStats(
    normalizedSignals: string[],
    recencyWindowDays: number,
    candidateLimit: number
  ): Promise<(EdgeStat & { normalized_signals: string })[]>;
  upsertEdgeStat(params: UpsertEdgeStatParams): Promise<void>;

  // --- Signal sets ---
  getSignalSet(signalKey: string): Promise<{ normalized_signals: string } | null>;
  upsertSignalSet(signalKey: string, normalizedSignals: string[]): Promise<void>;

  // --- Signal frequency ---
  incrementSignalFrequency(signalKey: string, signalValue: string, ts?: string): Promise<void>;

  // --- Gene priors ---
  getGenePrior(geneId: string): Promise<number>;
  /** Batch query: SELECT * FROM mg_gene_priors WHERE gene_id IN (...).
   *  Eliminates N+1 from per-gene getGenePrior calls. */
  getGenePriorsBatch(geneIds: string[]): Promise<Map<string, number>>;

  // --- Aggregation watermark ---
  getAggregationWatermark(): Promise<{ last_event_id: number } | null>;
  setAggregationWatermark(lastEventId: number): Promise<void>;

  // --- Events ---
  getEvents(query: EventQuery): Promise<MemoryGraphEvent[]>;
  getRecentEvents(limit: number): Promise<MemoryGraphEvent[]>;

  // --- Nodes & edges ---
  addNode(node: Omit<MemoryGraphNode, 'id' | 'created_at' | 'updated_at'>): Promise<string>;
  addEdge(edge: Omit<MemoryGraphEdge, 'id' | 'created_at'>): Promise<string>;
  updateGeneMarks(geneId: string, marks: EpigeneticMark[]): Promise<void>;

  // --- Capsule queries ---
  findSimilarCapsules(
    normalizedTrigger: string[],
    jaccardThreshold: number
  ): Promise<CapsuleWithMeta[]>;
}
```

### 6.6 MemoryGraph Service Interface (memory-graph.ts — public API)

The `MemoryGraph` service composes `MemoryGraphStore` (§6.5) with `EventRecorder`
(§6.4) and higher-level query methods. **This is the interface that consuming
modules (EVO-19, EVO-12a, EVO-21) depend on.** `MemoryGraphStore` is internal.

```typescript
interface MemoryGraph extends EventRecorder {
  // --- Inherited from EventRecorder (§6.4) ---
  // recordSignalSnapshot, recordHypothesis, recordAttempt, recordOutcome,
  // recordConfidenceEdge

  // --- Higher-level queries ---
  /** Gene scoring from history (see §5.5). Uses bounded getCandidateEdgeStats. */
  getMemoryAdvice(currentSignals: string[]): Promise<MemoryAdvice>;

  /** Ban a gene (set confidence to 0, mark as banned in mg_edge_stats). */
  banTopGene(geneId: string): Promise<void>;

  /** Get recent events for history analysis (ordered by created_at DESC). */
  getRecentEvents(limit: number): Promise<MemoryGraphEvent[]>;

  // --- Graph mutation ---
  addNode(node: Omit<MemoryGraphNode, 'id' | 'created_at' | 'updated_at'>): Promise<string>;
  addEdge(edge: Omit<MemoryGraphEdge, 'id' | 'created_at'>): Promise<string>;

  // --- Signal frequency ---
  incrementSignalFrequency(signalKey: string, signalValue: string, ts?: string): Promise<void>;

  // --- Maintenance ---
  updateGeneMarks(geneId: string, marks: EpigeneticMark[]): Promise<void>;
  findSimilarCapsules(
    normalizedTrigger: string[],
    jaccardThreshold: number
  ): Promise<CapsuleWithMeta[]>;

  /** Edge aggregation (§5.6). Delegates to MemoryGraphStore for watermark + upsert. */
  aggregateEdges(): Promise<void>;
}
```

**Implementation note**: `MemoryGraph` is implemented as a class that holds a
`MemoryGraphStore` instance and delegates store operations, while implementing
higher-level methods (e.g., `getMemoryAdvice` uses `store.getCandidateEdgeStats`
+ `store.getGenePriorsBatch`). This separation keeps the SQLite backend testable
independently from the business logic.

## 7. File Layout (CODE-01 Compliant)

All files ≤200 eLOC per CODE-01:

```
packages/shared/src/
├── memory-graph/
│   ├── index.ts              -- re-exports only (CODE-01 rule 3)
│   ├── types.ts              -- NodeType, EdgeType, event type enums (~50 eLOC)
│   ├── hash.ts               -- FNV-1a, normalizeSignal, computeSignalKey (~40 eLOC)
│   ├── decay.ts              -- decayWeight, laplaceProbability, edgeExpectedSuccess (~35 eLOC)
│   ├── similarity.ts         -- jaccardSimilarity, signal matching (~30 eLOC)
│   ├── advice.ts             -- getMemoryAdvice (gene scoring from history) (~80 eLOC)
│   ├── aggregator.ts         -- aggregateEdges (stat materialization) (~60 eLOC)
│   ├── recorder.ts           -- EventRecorder implementation (~100 eLOC)
│   ├── memory-graph.ts       -- MemoryGraph service (public API, composes store+recorder) (~120 eLOC)
│   ├── store.ts              -- MemoryGraphStore interface (~80 eLOC)
│   └── store-sqlite.ts       -- SQLite implementation of MemoryGraphStore (~180 eLOC)
```

**Estimated total**: ~775 eLOC across 10 implementation files.

## 8. Extension Applications Evaluation

### 8.1 Co-Change Tracking

**Mechanism**: During `recordOutcome`, extract modified file list from blast_radius.
For each pair of modified files, create or strengthen a `co_change` edge.

**Value**: When modifying file A, suggest also reviewing co-change partners. Reduces
regression risk from correlated changes.

**Integration**: Edge weight = min(co_occurrence_count × 0.1, 1.0) × decay_factor.
The raw count is stored in CoChangePayload.co_occurrence_count; the bounded weight
is recomputed on each update. Query via `coChangePartners()`.

**Verdict**: Include in initial design (low effort, high value).

### 8.2 Debug Acceleration (Error → Resolution Mapping)

**Mechanism**: `resolved_by` edges map signal patterns to successful genes.
When a new error appears, query similar historical signals to find likely fixes.

**Value**: Directly powers the Gene selection pipeline (§5.5 getMemoryAdvice).
This is not an extension — it IS the core use case.

**Verdict**: Core feature (already designed above).

### 8.3 Approval Pattern Learning

**Mechanism**: Track `approval_pattern` nodes linked to outcomes. Edges record
whether human approver accepted/rejected, with what gate type and what conditions.

**Value**: Over time, can predict approval likelihood, auto-suggest gate level,
and identify patterns where human review adds little value (candidates for A0 auto-approval).

**Integration**: Requires GATE-02 GateSpec integration. Approval events are recorded
as outcomes with gate metadata in payload.

**Verdict**: Design the node/edge types now; defer implementation to post-GATE-02.

### 8.4 Domain-Specific Knowledge Graph (Runtime Extension)

**Mechanism**: Consuming tracks register their own node/edge types at runtime
(see §2.3, §3.3). For example, a research track could register `research_idea`,
`computation`, `evidence` nodes and `supports`, `contradicts` edges to form a
persistent knowledge graph.

**Value**: The Memory Graph becomes a general-purpose cross-cycle knowledge
accumulator, not limited to tool evolution.

**Integration**: Consuming tracks register types via `NodeTypeRegistry` and
`EdgeTypeRegistry`. The core graph engine handles storage, decay, and traversal
without knowing about domain semantics.

**Verdict**: Registration API designed in §2.3/§3.3. Domain-specific types are
defined and registered by each consuming track's own design documents.

### 8.5 Dependency Risk Heatmap

**Mechanism**: `failure_in` edges accumulate from outcome events. Modules with
high failure frequency (decay-weighted) are flagged as high-risk.

**Value**: Focus testing and review effort on historically problematic modules.
Inform blast_radius risk scoring.

**Integration**: Feed into EVO-19 blast_radius severity classification — a capsule
modifying a high-risk module gets elevated review requirements.

**Verdict**: Include in initial design. Low additional effort given `failure_in`
edge type is already defined.

## 9. JSON Schema Definitions

See companion schema files:
- `schemas/memory_graph_event_v1.schema.json`
- `schemas/memory_graph_node_v1.schema.json`
- `schemas/memory_graph_edge_v1.schema.json`

## 10. Dependencies and Prerequisites

| Prerequisite | Status | Notes |
|---|---|---|
| M-06 (SQLite WAL) | Phase 2, pending | Required for concurrent read/write |
| H-02 (trace_id) | Phase 1, pending | Required for event correlation |
| H-18 (ArtifactRef V1) | Phase 1, pending | Node payloads may reference artifacts |

**Gap identified**: M-06 specifies "SQLite WAL + connection pool" but does not
mention `POWER()` SQL function. SQLite has `POWER()` only if compiled with
`-DSQLITE_ENABLE_MATH_FUNCTIONS` (available since 3.35.0, 2021). If not available,
decay weight must be computed in application code (which is the recommended approach
anyway for portability). **No REDESIGN_PLAN change needed** — application-side
computation is the design choice.

## 11. MIT Attribution Notice

```
Portions of this module are derived from Evolver (https://github.com/autogame-17/evolver)
Copyright (c) 2024-2026 AutoGame Limited
Licensed under the MIT License

Specifically ported algorithms:
- FNV-1a signal key hashing (memoryGraph.js)
- Exponential half-life decay (memoryGraph.js)
- Laplace-smoothed success probability (memoryGraph.js)
- Jaccard similarity for signal matching (memoryGraph.js)
- Edge aggregation with temporal weighting (memoryGraph.js)
- Memory advice / gene scoring pipeline (memoryGraph.js)
```
