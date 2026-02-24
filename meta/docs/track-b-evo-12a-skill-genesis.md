# EVO-12a: Skill Genesis from Agent Traces — Implementation Design

> **Status**: Draft
> **Date**: 2026-02-21
> **Branch**: `redesign/track-b`
> **Dependencies**: EVO-12 (Skill Lifecycle), trace-jsonl (Full-chain tracing), EVO-19 (Gene Library), EVO-20 (Memory Graph)

## 1. Overview

Skill Genesis detects repeated correction patterns in agent traces and
automatically proposes new skills or extensions to existing skills. This bridges
the gap between EVO-12 (manages existing skills) and EVO-19 (repairs existing
code) — neither covers **extracting new skills from observed agent behavior**.

**Real-world examples**:
- Agent repeatedly fixes LaTeX escaping in Markdown TOC blocks → propose `md-toc-latex-unescape` skill
- Agent repeatedly adds `=` guards at line start in Markdown files → propose scope extension
- Agent repeatedly restructures import statements → propose import-organizer skill

## 2. Pattern Detection Algorithm

### 2.1 Trace Event Model

Pattern detection operates on the trace-jsonl event stream (H-02, trace-jsonl).
Relevant event types:

```typescript
interface TraceEvent {
  ts: string;              // ISO 8601
  trace_id: string;        // UUID v4
  run_id: string;
  event: string;           // event type identifier
  component: string;       // source component
  data: Record<string, unknown>;
}

// Events relevant for pattern detection:
// - 'tool_call': MCP tool invocation with params
// - 'file_edit': File modification (path, old_content hash, new_content hash)
// - 'error_caught': Error intercepted and handled
// - 'fix_applied': Correction applied to a file
// - 'skill_invoked': Skill was used
```

### 2.2 Pattern Fingerprinting

Patterns are identified by a (file_type, edit_pattern, context) triple:

```typescript
interface PatternFingerprint {
  /** File type/extension being edited */
  file_type: string;       // e.g., '.md', '.ts', '.tex'

  /** Normalized edit pattern */
  edit_pattern: string;    // e.g., 'replace_latex_escape', 'add_line_guard'

  /** Contextual signal that triggers the edit */
  context: string;         // e.g., 'toc_block', 'markdown_render_failure'

  /** Composite fingerprint key */
  fingerprint_key: string; // FNV-1a hash of normalized triple
}

function computePatternFingerprint(
  event: TraceEvent
): PatternFingerprint | null {
  if (event.event !== 'file_edit' && event.event !== 'fix_applied') {
    return null;
  }

  const data = event.data as FileEditData;
  const fileType = path.extname(data.file_path);

  // Classify the edit pattern
  const editPattern = classifyEditPattern(data);
  if (!editPattern) return null;

  // Extract context from surrounding trace events
  const context = extractEditContext(event);

  const raw = `${fileType}|${editPattern}|${context}`;
  return {
    file_type: fileType,
    edit_pattern: editPattern,
    context,
    fingerprint_key: fnv1aHash(raw)
  };
}
```

### 2.3 Edit Pattern Classification

```typescript
type EditPatternClass =
  | 'replace_regex'       // regex-based search & replace
  | 'insert_guard'        // insert a guard/check before content
  | 'wrap_block'          // wrap content in a block/container
  | 'reorder_lines'       // reorder lines (imports, declarations)
  | 'add_annotation'      // add type annotation, comment, or marker
  | 'remove_pattern'      // remove specific pattern occurrences
  | 'restructure'         // structural refactoring
  | 'unknown';

function classifyEditPattern(data: FileEditData): EditPatternClass | null {
  // Heuristic classification based on diff analysis
  const diff = data.diff;
  if (!diff) return null;

  const added = diff.filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const removed = diff.filter(l => l.startsWith('-') && !l.startsWith('---'));

  // No substantive change
  if (added.length === 0 && removed.length === 0) return null;

  // Replace pattern: similar number of adds and removes
  if (added.length > 0 && removed.length > 0 &&
      Math.abs(added.length - removed.length) <= 2) {
    return 'replace_regex';
  }

  // Insert guard: adds before existing content, no removes
  if (added.length > 0 && removed.length === 0 && added.length <= 3) {
    return 'insert_guard';
  }

  // Wrap block: adds surround removes
  if (added.length > removed.length && added.length - removed.length === 2) {
    return 'wrap_block';
  }

  // Remove pattern: only removes
  if (added.length === 0 && removed.length > 0) {
    return 'remove_pattern';
  }

  // Reorder: same content, different order
  const addedContent = new Set(added.map(l => l.slice(1).trim()));
  const removedContent = new Set(removed.map(l => l.slice(1).trim()));
  if (addedContent.size === removedContent.size) {
    let overlap = 0;
    for (const a of addedContent) {
      if (removedContent.has(a)) overlap++;
    }
    if (overlap / addedContent.size > 0.8) return 'reorder_lines';
  }

  return 'restructure';
}
```

### 2.4 Pattern Frequency Tracking

Patterns are tracked in the Memory Graph's signal frequency table (EVO-20):

```typescript
const PATTERN_SKILL_THRESHOLD = 3;  // ≥3 occurrences trigger proposal

interface PatternAccumulator {
  fingerprint: PatternFingerprint;
  occurrences: PatternOccurrence[];
  first_seen: string;
  last_seen: string;
  count: number;
}

interface PatternOccurrence {
  trace_id: string;
  run_id: string;
  file_path: string;
  timestamp: string;
  artifact_uri?: string;  // H-18 ArtifactRef URI to the specific trace event
}

async function detectPatterns(
  events: TraceEvent[],
  memoryGraph: MemoryGraph
): Promise<PatternAccumulator[]> {
  const accumulators = new Map<string, PatternAccumulator>();

  for (const event of events) {
    const fingerprint = computePatternFingerprint(event);
    if (!fingerprint) continue;

    const key = fingerprint.fingerprint_key;
    const existing = accumulators.get(key) ?? {
      fingerprint,
      occurrences: [],
      first_seen: event.ts,
      last_seen: event.ts,
      count: 0
    };

    existing.occurrences.push({
      trace_id: event.trace_id,
      run_id: event.run_id,
      file_path: (event.data as FileEditData).file_path,
      timestamp: event.ts
    });
    existing.last_seen = event.ts;
    existing.count++;
    accumulators.set(key, existing);

    // Update Memory Graph signal frequency
    await memoryGraph.incrementSignalFrequency(
      fingerprint.fingerprint_key,
      `pattern:${fingerprint.edit_pattern}:${fingerprint.file_type}`
    );
  }

  // Return patterns exceeding threshold
  return [...accumulators.values()].filter(
    a => a.count >= PATTERN_SKILL_THRESHOLD
  );
}
```

## 3. Pattern Generalization

### 3.1 From Specific Instances to Reusable Definition

```typescript
interface GeneralizedPattern {
  /** What triggers this skill */
  trigger_description: string;

  /** What the skill does */
  action_description: string;

  /** File types this applies to */
  applicable_file_types: string[];

  /** Generalized regex/rule */
  generalized_rule: string;

  /** Confidence in the generalization */
  confidence: number;
}

function generalizePattern(
  accumulator: PatternAccumulator
): GeneralizedPattern {
  const { fingerprint, occurrences } = accumulator;

  // 1. Determine applicable file types
  const fileTypes = new Set(
    occurrences.map(o => path.extname(o.file_path))
  );

  // 2. Generate trigger description from context
  const triggerDesc = generateTriggerDescription(
    fingerprint.context,
    fingerprint.edit_pattern
  );

  // 3. Generate action description from edit pattern
  const actionDesc = generateActionDescription(
    fingerprint.edit_pattern,
    fingerprint.file_type
  );

  // 4. Confidence based on:
  //    - occurrence count (more = higher)
  //    - consistency of file types (fewer = higher)
  //    - recency (more recent = higher)
  const recencyWeight = decayWeight(
    new Date(accumulator.last_seen),
    new Date(),
    30
  );
  const consistencyWeight = 1 / fileTypes.size;
  const countWeight = Math.min(accumulator.count / 10, 1);
  const confidence = (recencyWeight * 0.3 + consistencyWeight * 0.3 + countWeight * 0.4);

  return {
    trigger_description: triggerDesc,
    action_description: actionDesc,
    applicable_file_types: [...fileTypes],
    generalized_rule: `${fingerprint.edit_pattern}:${fingerprint.context}`,
    confidence
  };
}
```

## 4. Two Evolution Paths

### 4.1 Path A: New Skill Creation

When a pattern has no matching existing skill:

```typescript
async function proposeNewSkill(
  pattern: PatternAccumulator,
  generalized: GeneralizedPattern,
  existingSkills: SkillRegistry
): Promise<SkillProposal | null> {
  // 1. Check no existing skill covers this
  const matching = await existingSkills.findByTrigger(
    generalized.trigger_description
  );
  if (matching.length > 0) return null;  // use Path B instead

  // 2. Generate skill proposal
  const proposal: SkillProposal = {
    proposal_id: `sp_${generateId()}`,
    proposal_type: 'new_skill',
    origin: 'agent_trace',
    name: generateSkillName(generalized),
    description: generalized.action_description,
    trigger: {
      description: generalized.trigger_description,
      file_types: generalized.applicable_file_types,
      signal_pattern: pattern.fingerprint.context
    },
    action: {
      type: pattern.fingerprint.edit_pattern,
      rule: generalized.generalized_rule
    },
    evidence_traces: pattern.occurrences.map(o => ({
      trace_id: o.trace_id,
      run_id: o.run_id,
      file_path: o.file_path,
      timestamp: o.timestamp,
      artifact_uri: o.artifact_uri ?? null
    })),
    generalization_confidence: generalized.confidence,
    gate_level: generalized.confidence >= 0.8 ? 'A0' : 'A2',
    status: 'pending_review',
    created_at: new Date().toISOString()
  };

  return proposal;
}
```

### 4.2 Path B: Existing Skill Scope Extension

When a pattern partially matches an existing skill but covers new cases:

```typescript
interface ScopeExtensionProposal extends SkillProposal {
  proposal_type: 'scope_extension';
  existing_skill_id: string;
  existing_scope: SkillScope;
  proposed_scope: SkillScope;
  new_cases: PatternOccurrence[];
  coverage_delta: {
    before: string;  // description of current coverage
    after: string;   // description of proposed coverage
  };
}

async function proposeScopeExtension(
  pattern: PatternAccumulator,
  generalized: GeneralizedPattern,
  existingSkill: Skill
): Promise<ScopeExtensionProposal> {
  // 1. Identify new cases not covered by existing skill
  const newCases = pattern.occurrences.filter(o => {
    return !existingSkill.covers(o.file_path, pattern.fingerprint.context);
  });

  if (newCases.length === 0) return null;

  // 2. Compute coverage delta
  const existingScope = existingSkill.scope;
  const proposedScope = mergeScopes(
    existingScope,
    generalized.applicable_file_types,
    generalized.trigger_description
  );

  return {
    proposal_id: `sp_${generateId()}`,
    proposal_type: 'scope_extension',
    origin: 'agent_trace',
    existing_skill_id: existingSkill.id,
    name: existingSkill.name,
    description: `Extend ${existingSkill.name} to cover ${generalized.trigger_description}`,
    trigger: existingSkill.trigger,
    action: existingSkill.action,
    existing_scope: existingScope,
    proposed_scope: proposedScope,
    new_cases: newCases,
    coverage_delta: {
      before: describeScope(existingScope),
      after: describeScope(proposedScope)
    },
    evidence_traces: newCases.map(o => ({
      trace_id: o.trace_id,
      run_id: o.run_id,
      file_path: o.file_path,
      timestamp: o.timestamp,
      artifact_uri: o.artifact_uri ?? null
    })),
    generalization_confidence: generalized.confidence,
    gate_level: 'A1',  // scope extensions need review but are lower risk
    status: 'pending_review',
    created_at: new Date().toISOString()
  };
}
```

## 5. Skill Genesis Engine (Orchestrator)

```typescript
async function runSkillGenesis(
  traceWindow: { from: string; to: string },
  memoryGraph: MemoryGraph,
  geneIndex: GeneIndex,
  skillRegistry: SkillRegistry
): Promise<SkillProposal[]> {
  const proposals: SkillProposal[] = [];

  // 1. Load trace events in window (indexed query — see §5.1)
  const events = await traceIndex.queryEvents(traceWindow);

  // 2. Detect patterns
  const patterns = await detectPatterns(events, memoryGraph);

  for (const pattern of patterns) {
    // 3. Generalize
    const generalized = generalizePattern(pattern);

    // 4. Skip low-confidence generalizations
    if (generalized.confidence < 0.5) continue;

    // 5. Check for existing skill match
    const existingSkills = await skillRegistry.findByTrigger(
      generalized.trigger_description
    );

    if (existingSkills.length > 0) {
      // Path B: scope extension
      for (const skill of existingSkills) {
        const extension = await proposeScopeExtension(
          pattern, generalized, skill
        );
        if (extension) proposals.push(extension);
      }
    } else {
      // Path A: new skill
      const newSkill = await proposeNewSkill(
        pattern, generalized, skillRegistry
      );
      if (newSkill) proposals.push(newSkill);
    }

    // 6. Record in Memory Graph (spawned_skill edge if approved)
    await memoryGraph.addNode({
      node_type: 'signal',
      track: 'b',
      payload: {
        signal_key: pattern.fingerprint.fingerprint_key,
        signals: [`pattern:${pattern.fingerprint.edit_pattern}`],
        occurrence_count: pattern.count
      }
    });
  }

  return proposals;
}
```

### 5.1 Trace Index Prerequisite

> **Blocker**: Before EVO-12a can be implemented, the trace-jsonl store must
> be indexed. The original `loadTraceEvents(traceWindow)` call performs an
> O(N) sequential scan of append-only JSONL files, which becomes untenable
> for production repositories with millions of accumulated trace events.

The `traceIndex.queryEvents(traceWindow)` call in the code above assumes a
SQLite-backed trace index is available (see Gap 5 in
`track-b-prerequisite-gaps.md`). The index must provide:

1. **Columns**: `event_id`, `event_type`, `ts`, `run_id`, `offset` (byte
   offset into the source JSONL file)
2. **Incremental build**: Index rows are appended as trace events are written
3. **Window query path**: `queryEvents(window)` reads the SQLite index to
   resolve matching offsets, then seeks directly to those positions in the
   JSONL file — eliminating full-file scans

This prerequisite is tracked as a specification addition to the existing
trace-jsonl deliverable (Phase 2), not as a new REDESIGN_PLAN item.

## 6. Integration with EVO-20 Memory Graph

### 6.1 Signal Frequency → Skill Proposal Trigger

The Memory Graph's `mg_signal_freq` table tracks pattern frequencies across runs.
When `count >= PATTERN_SKILL_THRESHOLD` for a pattern signal, the skill genesis
detector is triggered:

```sql
-- Query: patterns exceeding threshold in last 30 days
SELECT signal_value, SUM(count) as total
FROM mg_signal_freq
WHERE signal_value LIKE 'pattern:%'
  AND last_seen >= datetime('now', '-30 days')
GROUP BY signal_value
HAVING total >= 3
ORDER BY total DESC;
```

### 6.2 Memory Graph Edges for Skill Genesis

When a skill proposal is approved and the skill is registered:

```typescript
// Create spawned_skill edge from the gene(s) that produced the pattern
await memoryGraph.addEdge({
  edge_type: 'spawned_skill',
  source_id: geneNodeId,
  target_id: skillNodeId,
  payload: {
    proposal_id: proposal.proposal_id,
    confidence: proposal.generalization_confidence
  }
});
```

## 7. File Layout (CODE-01 Compliant)

```
packages/orchestrator/src/
├── skill-genesis/
│   ├── index.ts                  -- re-exports only
│   ├── types.ts                  -- PatternFingerprint, PatternAccumulator, etc. (~70 eLOC)
│   ├── pattern-fingerprint.ts    -- computePatternFingerprint, classifyEditPattern (~100 eLOC)
│   ├── pattern-detector.ts       -- detectPatterns, frequency tracking (~90 eLOC)
│   ├── pattern-generalizer.ts    -- generalizePattern, generateDescriptions (~80 eLOC)
│   ├── proposal-new-skill.ts     -- proposeNewSkill (~70 eLOC)
│   ├── proposal-scope-ext.ts     -- proposeScopeExtension (~90 eLOC)
│   └── genesis-engine.ts         -- runSkillGenesis orchestrator (~80 eLOC)
```

**Estimated total**: ~580 eLOC across 7 implementation files.

## 8. JSON Schema

See companion schema file:
- `schemas/skill_proposal_v2.schema.json`

## 9. Dependencies

| Prerequisite | Status | Notes |
|---|---|---|
| EVO-12 (Skill Lifecycle) | Phase 5, pending | Skill registry, --auto-safe install path |
| trace-jsonl | Phase 2, pending | Provides trace events for pattern detection |
| EVO-19 (Gene Library) | This design | Signal index mechanism reuse |
| EVO-20 (Memory Graph) | This design | Signal frequency persistence, spawned_skill edges |
| H-18 (ArtifactRef) | Phase 1, pending | Evidence trace references |
| trace-jsonl indexing | Phase 2, pending | SQLite trace index for `queryEvents(window)` — see §5.1 and Gap 5 |

**Gap identified**: trace-jsonl currently specifies JSONL format for logging but
does not define a standard event schema for `file_edit` or `fix_applied` events.
Pattern detection requires these event types. **REDESIGN_PLAN update needed**:
add note to trace-jsonl item that file_edit and fix_applied event types must be
defined in the trace event schema (see §10 below).

## 10. Prerequisite Gap: trace-jsonl Event Types

**Current state**: trace-jsonl (Phase 2) defines the transport format (JSONL) and
basic fields (ts, trace_id, level, component, event, data) but does not enumerate
required event types for tool evolution.

**Required addition**: The trace-jsonl event schema must include:

| Event Type | Data Fields | Consumer |
|---|---|---|
| `file_edit` | `file_path`, `diff` (unified diff lines), `edit_type` | EVO-12a pattern detection |
| `fix_applied` | `file_path`, `fix_type`, `signal_context` | EVO-12a pattern detection |
| `tool_call` | `tool_name`, `params`, `result_status` | EVO-12a context extraction |
| `skill_invoked` | `skill_id`, `trigger`, `result` | EVO-12a scope coverage check |

This does NOT require a new REDESIGN_PLAN item — it is a specification refinement
within the existing trace-jsonl scope. The trace-jsonl description should note
these event types as required for downstream consumers.

## 11. MIT Attribution

No direct Evolver code porting in EVO-12a. However, the signal frequency mechanism
from EVO-20 (which ports memoryGraph.js) is used for pattern threshold triggers.
The Gene Library signal indexing mechanism from EVO-19 (which ports selector.js)
is reused for pattern matching. Attribution is inherited transitively from those
modules.
