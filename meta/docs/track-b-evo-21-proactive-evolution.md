# EVO-21: Proactive Evolution — Implementation Design

> **Status**: Draft
> **Date**: 2026-02-21
> **Branch**: `redesign/track-b`
> **Ported from**: Evolver `personality.js` (~355 LOC), `signals.js` (~363 LOC) (MIT License, AutoGame Limited)
> **Dependencies**: EVO-19 (Track B base), EVO-20 (Memory Graph), EVO-11 (Bandit)

## 1. Overview

Proactive Evolution extends EVO-19's repair-only capability with two additional
mutation types: **optimize** (performance/quality improvements) and **innovate**
(architectural changes). It also ports the strategy parameter self-adaptation
system from Evolver's `personality.js`, enabling the evolution engine to learn
which mutation strategies work best over time.

## 2. Opportunity Signal Types + Detection

### 2.1 Extended Signal Enumeration

Ported from `signals.js` OPPORTUNITY_SIGNALS, extended for Track B:

```typescript
// MIT License — ported from Evolver (AutoGame Limited), extended for Autoresearch

/** Defensive signals (existing EVO-19 repair triggers) */
type DefensiveSignal =
  | 'error_detected'
  | 'test_failure'
  | 'type_check_failure'
  | 'missing_dependency'
  | 'runtime_exception';

/** Opportunity signals (new EVO-21 optimize/innovate triggers) */
type OpportunitySignal =
  | 'performance_regression'       // benchmark score decrease
  | 'code_smell_detected'          // duplicate code, long files, dead code
  | 'dependency_update_available'  // npm outdated / security advisory
  | 'test_coverage_gap'            // uncovered code paths
  | 'api_usage_pattern_shift'      // tool usage patterns changed
  | 'user_feature_request'         // explicit user request (from signals.js)
  | 'capability_gap'               // missing capability detected
  | 'evolution_stagnation_detected' // no progress in N cycles
  | 'repair_loop_detected'         // same repair applied ≥3 times
  | 'force_innovation_after_repair_loop'; // forced innovation trigger

/** Meta signals (ported from signals.js) */
type MetaSignal =
  | 'consecutive_empty_cycles'     // ≥5 cycles with 0 files changed
  | 'consecutive_failures'         // ≥5 consecutive failures
  | 'force_steady_state';          // forced steady state after stagnation

type EvolutionSignal = DefensiveSignal | OpportunitySignal | MetaSignal;
```

### 2.2 Signal Extraction Engine

Ported from `extractSignals()` with extensions:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)

interface SignalExtractionResult {
  signals: EvolutionSignal[];
  suppressed: EvolutionSignal[];  // de-duplicated (appeared ≥3 times recently)
  meta: {
    consecutiveRepairCount: number;
    consecutiveEmptyCycles: number;
    consecutiveFailureCount: number;
    recentFailureRatio: number;
  };
}

async function extractSignals(
  runContext: RunContext,
  memoryGraph: MemoryGraph
): Promise<SignalExtractionResult> {
  const signals: EvolutionSignal[] = [];

  // --- Defensive signals (from current run state) ---
  if (runContext.errors.length > 0) signals.push('error_detected');
  if (runContext.testFailures > 0) signals.push('test_failure');
  if (runContext.typeErrors > 0) signals.push('type_check_failure');

  // --- Opportunity signals ---

  // Performance regression: compare against stored benchmarks
  const benchDelta = await compareBenchmarks(runContext, memoryGraph);
  if (benchDelta < -0.05) signals.push('performance_regression');

  // Code smell detection
  const smells = await detectCodeSmells(runContext.modifiedFiles);
  if (smells.length > 0) signals.push('code_smell_detected');

  // Dependency updates
  const outdated = await checkOutdatedDeps(runContext.repoRoot);
  if (outdated.length > 0) signals.push('dependency_update_available');

  // Test coverage gaps
  const coverageGaps = await findCoverageGaps(runContext);
  if (coverageGaps.length > 0) signals.push('test_coverage_gap');

  // --- History analysis (ported from analyzeRecentHistory) ---
  const history = await analyzeRecentHistory(memoryGraph);

  // Signal de-duplication (suppress if ≥3 occurrences in last 8 events)
  const suppressed: EvolutionSignal[] = [];
  const filtered = signals.filter(sig => {
    if ((history.signalFreq.get(sig) ?? 0) >= 3) {
      suppressed.push(sig);
      return false;
    }
    return true;
  });

  // Force innovation after repair loop
  if (history.consecutiveRepairCount >= 3) {
    filtered.push('force_innovation_after_repair_loop');
  }

  // Force steady state after stagnation
  if (history.consecutiveEmptyCycles >= 5) {
    filtered.push('force_steady_state');
  }

  // Failure loop detection
  if (history.consecutiveFailureCount >= 5) {
    filtered.push('consecutive_failures');
    // Ban the top gene to break the loop
    await memoryGraph.banTopGene(history.mostRecentGeneId);
  }

  return {
    signals: filtered,
    suppressed,
    meta: {
      consecutiveRepairCount: history.consecutiveRepairCount,
      consecutiveEmptyCycles: history.consecutiveEmptyCycles,
      consecutiveFailureCount: history.consecutiveFailureCount,
      recentFailureRatio: history.recentFailureRatio
    }
  };
}
```

### 2.3 Recent History Analysis

Ported from `analyzeRecentHistory()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const HISTORY_WINDOW = 10;
const SIGNAL_SUPPRESSION_THRESHOLD = 3;
const SIGNAL_SUPPRESSION_WINDOW = 8;

interface RecentHistory {
  signalFreq: Map<string, number>;
  geneFreq: Map<string, number>;
  consecutiveRepairCount: number;
  consecutiveEmptyCycles: number;
  consecutiveFailureCount: number;
  recentFailureRatio: number;
  mostRecentGeneId: string | null;
}

async function analyzeRecentHistory(
  store: MemoryGraph
): Promise<RecentHistory> {
  const events = await store.getRecentEvents(HISTORY_WINDOW);

  const signalFreq = new Map<string, number>();
  const geneFreq = new Map<string, number>();
  let consecutiveRepairCount = 0;
  let consecutiveEmptyCycles = 0;
  let consecutiveFailureCount = 0;
  let failCount = 0;
  let totalOutcomes = 0;

  // Analyze last SIGNAL_SUPPRESSION_WINDOW events for signal frequency
  const recentEvents = events.slice(0, SIGNAL_SUPPRESSION_WINDOW);
  for (const event of recentEvents) {
    if (event.event_type === 'signal') {
      for (const sig of event.payload.signals) {
        signalFreq.set(sig, (signalFreq.get(sig) ?? 0) + 1);
      }
    }
  }

  // Track consecutive patterns
  let repairStreak = true;
  let emptyStreak = true;
  let failStreak = true;

  for (const event of events) {
    if (event.event_type === 'outcome') {
      totalOutcomes++;
      if (!event.payload.success) {
        failCount++;
        if (failStreak) consecutiveFailureCount++;
      } else {
        failStreak = false;
      }

      // Check for empty cycles (0 files changed)
      const filesChanged = event.payload.blast_radius?.files_changed ?? 0;
      if (filesChanged === 0 && emptyStreak) {
        consecutiveEmptyCycles++;
      } else {
        emptyStreak = false;
      }
    }

    if (event.event_type === 'attempt') {
      const mutType = event.payload.mutation_type ?? 'repair';
      geneFreq.set(event.payload.gene_id, (geneFreq.get(event.payload.gene_id) ?? 0) + 1);
      if (mutType !== 'repair') repairStreak = false;
      if (repairStreak) consecutiveRepairCount++;
    }
  }

  return {
    signalFreq,
    geneFreq,
    consecutiveRepairCount,
    consecutiveEmptyCycles,
    consecutiveFailureCount,
    recentFailureRatio: totalOutcomes > 0 ? failCount / totalOutcomes : 0,
    mostRecentGeneId: events.find(e => e.event_type === 'attempt')?.payload.gene_id ?? null
  };
}
```

### 2.4 Code Smell Detection

```typescript
interface CodeSmell {
  type: 'duplicate_code' | 'long_file' | 'dead_code' | 'high_complexity';
  file: string;
  details: string;
}

async function detectCodeSmells(files: string[]): Promise<CodeSmell[]> {
  const smells: CodeSmell[] = [];

  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const lines = content.split('\n');
    const ext = path.extname(file);

    // Long file (CODE-01 alignment: ≤200 eLOC)
    if (ext === '.ts' || ext === '.py') {
      const eloc = countEffectiveLOC(content, ext);
      if (eloc > 200) {
        smells.push({
          type: 'long_file',
          file,
          details: `${eloc} eLOC (limit: 200)`
        });
      }
    }

    // Dead exports: exported symbols not imported elsewhere
    // (Deferred to implementation — requires cross-file analysis)
  }

  return smells;
}
```

## 3. Three Mutation Types

### 3.1 Mutation Type Definitions

```typescript
interface MutationStrategy {
  type: 'repair' | 'optimize' | 'innovate';
  description: string;
  validation_requirements: string[];
  gate_level: 'A0' | 'A1' | 'A2';
  max_blast_radius_files: number;
  risk_level: number;  // 0-1
}

const MUTATION_STRATEGIES: Record<string, MutationStrategy> = {
  repair: {
    type: 'repair',
    description: 'Fix detected errors — reactive, low risk',
    validation_requirements: ['vitest', 'tsc'],
    gate_level: 'A0',
    max_blast_radius_files: 10,
    risk_level: 0.2
  },
  optimize: {
    type: 'optimize',
    description: 'Improve performance/quality — proactive, medium risk',
    validation_requirements: ['vitest', 'tsc', 'benchmark_no_regression'],
    gate_level: 'A0',
    max_blast_radius_files: 5,
    risk_level: 0.5
  },
  innovate: {
    type: 'innovate',
    description: 'Architectural improvements — proactive, high risk',
    validation_requirements: ['vitest', 'tsc', 'blast_radius_le_3'],
    gate_level: 'A2',
    max_blast_radius_files: 3,
    risk_level: 0.8
  }
};
```

### 3.2 Risk Grading + GATE Mapping

```typescript
// Risk grading matrix: mutation_type × blast_severity → gate_level
const RISK_GATE_MATRIX: Record<string, Record<BlastSeverity, GateLevel>> = {
  repair: {
    within_limit: 'A0',
    approaching_limit: 'A0',
    exceeded: 'A1',
    critical_overrun: 'A2',
    hard_cap_breach: 'reject'
  },
  optimize: {
    within_limit: 'A0',
    approaching_limit: 'A1',
    exceeded: 'A2',
    critical_overrun: 'A2',
    hard_cap_breach: 'reject'
  },
  innovate: {
    within_limit: 'A1',
    approaching_limit: 'A2',
    exceeded: 'A2',
    critical_overrun: 'reject',
    hard_cap_breach: 'reject'
  }
};

function determineGateLevel(
  mutationType: MutationType,
  severity: BlastSeverity,
  riskModuleCount: number
): GateLevel {
  let gate = RISK_GATE_MATRIX[mutationType][severity];

  // Escalate if touching risk modules
  if (riskModuleCount > 0 && gate === 'A0') gate = 'A1';
  if (riskModuleCount > 2 && gate === 'A1') gate = 'A2';

  return gate;
}
```

### 3.3 Mutation Type Selection

Signal-driven selection of which mutation type to apply:

```typescript
function selectMutationType(
  signals: EvolutionSignal[],
  strategy: StrategyState
): MutationType {
  // Defensive signals → repair
  const hasDefensive = signals.some(s =>
    ['error_detected', 'test_failure', 'type_check_failure',
     'missing_dependency', 'runtime_exception'].includes(s)
  );
  if (hasDefensive) return 'repair';

  // Force innovation after repair loop
  if (signals.includes('force_innovation_after_repair_loop')) return 'innovate';

  // Force steady state: the system must still respond to the cycle (it cannot
  // return null / skip), so we fall back to 'repair' as the lowest-risk mutation
  // type. Repair-with-no-defensive-signals will effectively be a no-op once
  // selectGene finds nothing actionable, which is the intended steady-state
  // behaviour.
  if (signals.includes('force_steady_state')) return 'repair';

  // Opportunity signals → optimize or innovate based on strategy
  const hasOpportunity = signals.some(s =>
    ['performance_regression', 'code_smell_detected',
     'test_coverage_gap', 'dependency_update_available'].includes(s)
  );

  if (hasOpportunity) {
    // Use strategy parameters to decide
    if (strategy.creativity > 0.6 && strategy.risk_tolerance > 0.5) {
      return 'innovate';
    }
    return 'optimize';
  }

  // Architecture signals → innovate
  if (signals.includes('capability_gap') ||
      signals.includes('api_usage_pattern_shift')) {
    return 'innovate';
  }

  return 'repair';  // default
}
```

## 4. Strategy Parameter Self-Adaptation (personality.js Port)

### 4.1 Strategy State

Ported from `defaultPersonalityState()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)

interface StrategyState {
  /** Rigor: how thorough validation is (0=minimal, 1=exhaustive) */
  rigor: number;        // default: 0.7

  /** Creativity: willingness to try novel approaches (0=conservative, 1=experimental) */
  creativity: number;   // default: 0.35

  /** Verbosity: detail level in outputs (0=minimal, 1=detailed) */
  verbosity: number;    // default: 0.25

  /** Risk tolerance: willingness to accept larger blast radius (0=minimal, 1=high) */
  risk_tolerance: number;  // default: 0.4

  /** Obedience: adherence to constraints (0=flexible, 1=strict) */
  obedience: number;    // default: 0.85
}

const DEFAULT_STRATEGY: StrategyState = {
  rigor: 0.7,
  creativity: 0.35,
  verbosity: 0.25,
  risk_tolerance: 0.4,
  obedience: 0.85
};

/** Quantize to 0.1 step for statistics aggregation */
function strategyKey(state: StrategyState): string {
  const q = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
  return `r=${q(state.rigor)}|c=${q(state.creativity)}|v=${q(state.verbosity)}|rt=${q(state.risk_tolerance)}|o=${q(state.obedience)}`;
}
```

### 4.2 Strategy Scoring

Ported from `personalityScore()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)

interface StrategyStats {
  key: string;
  total_runs: number;
  success_count: number;
  avg_quality: number;
  score: number;
}

function computeStrategyScore(stats: StrategyStats): number {
  const p = laplaceProbability(stats.success_count, stats.total_runs);
  const sampleWeight = Math.min(stats.total_runs / 5, 1);  // ramp up confidence
  return p * 0.75 + stats.avg_quality * 0.25 * sampleWeight;
}
```

### 4.3 Strategy Mutations

Ported from `applyPersonalityMutations()` and `proposeMutations()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const MAX_MUTATION_DELTA = 0.2;
const MAX_MUTATIONS_PER_ROUND = 2;

interface StrategyMutation {
  param: keyof StrategyState;
  delta: number;
  reason: string;
}

function proposeMutations(
  signals: EvolutionSignal[],
  current: StrategyState
): StrategyMutation[] {
  const mutations: StrategyMutation[] = [];

  // Error signals → increase rigor, decrease risk tolerance
  if (signals.includes('error_detected') || signals.includes('test_failure')) {
    if (current.rigor < 0.9) {
      mutations.push({ param: 'rigor', delta: 0.1, reason: 'errors detected' });
    }
    if (current.risk_tolerance > 0.2) {
      mutations.push({ param: 'risk_tolerance', delta: -0.1, reason: 'errors detected' });
    }
  }

  // Opportunity signals → increase creativity, increase risk tolerance
  if (signals.includes('capability_gap') || signals.includes('code_smell_detected')) {
    if (current.creativity < 0.8) {
      mutations.push({ param: 'creativity', delta: 0.1, reason: 'opportunity detected' });
    }
    if (current.risk_tolerance < 0.7) {
      mutations.push({ param: 'risk_tolerance', delta: 0.1, reason: 'opportunity detected' });
    }
  }

  // Stagnation → increase creativity
  if (signals.includes('evolution_stagnation_detected') ||
      signals.includes('consecutive_empty_cycles')) {
    if (current.creativity < 0.9) {
      mutations.push({ param: 'creativity', delta: 0.15, reason: 'stagnation' });
    }
  }

  // Limit to max mutations per round
  return mutations.slice(0, MAX_MUTATIONS_PER_ROUND);
}

function applyMutations(
  state: StrategyState,
  mutations: StrategyMutation[]
): StrategyState {
  const next = { ...state };
  for (const mut of mutations) {
    const clamped = Math.max(-MAX_MUTATION_DELTA, Math.min(MAX_MUTATION_DELTA, mut.delta));
    next[mut.param] = Math.max(0, Math.min(1, next[mut.param] + clamped));
  }
  return next;
}
```

### 4.4 Natural Selection + Strategy Selection

Ported from `selectPersonalityForRun()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const NATURAL_SELECTION_NUDGE = 0.1;

interface StrategySelectionResult {
  strategy: StrategyState;
  mutations_applied: StrategyMutation[];
  selection_method: 'best_known' | 'mutated' | 'default';
}

async function selectStrategy(
  signals: EvolutionSignal[],
  current: StrategyState,
  store: StrategyStatsStore
): Promise<StrategySelectionResult> {
  // 1. Find best-known strategy from history
  const allStats = await store.getAllStrategyStats();
  let bestStats: StrategyStats | null = null;
  let bestScore = -1;
  for (const stats of allStats) {
    const score = computeStrategyScore(stats);
    if (score > bestScore) {
      bestScore = score;
      bestStats = stats;
    }
  }

  // 2. Determine if mutation should trigger
  const shouldMutate = shouldTriggerMutation(signals, current, store);

  if (!shouldMutate && bestStats) {
    // Natural selection: nudge current toward best-known
    const bestState = parseStrategyKey(bestStats.key);
    const nudged = nudgeToward(current, bestState, NATURAL_SELECTION_NUDGE);
    return {
      strategy: nudged,
      mutations_applied: [],
      selection_method: 'best_known'
    };
  }

  // 3. Apply signal-driven mutations
  const mutations = proposeMutations(signals, current);
  if (mutations.length === 0) {
    return {
      strategy: current,
      mutations_applied: [],
      selection_method: 'default'
    };
  }

  const mutated = applyMutations(current, mutations);
  return {
    strategy: mutated,
    mutations_applied: mutations,
    selection_method: 'mutated'
  };
}

function shouldTriggerMutation(
  signals: EvolutionSignal[],
  current: StrategyState,
  store: StrategyStatsStore
): boolean {
  // Trigger on:
  // 1. Drift is enabled (evolutionary exploration phase)
  // 2. ≥3 recent failures (current strategy isn't working)
  // 3. ≥3 consecutive mutation failures
  const stats = store.getStrategyStats(strategyKey(current));
  if (!stats) return true;  // no data yet, explore

  if (stats.total_runs >= 3 && stats.success_count === 0) return true;

  return signals.some(s => [
    'evolution_stagnation_detected',
    'force_innovation_after_repair_loop',
    'consecutive_failures'
  ].includes(s));
}

function nudgeToward(
  current: StrategyState,
  target: StrategyState,
  maxDelta: number
): StrategyState {
  const result = { ...current };
  const params: (keyof StrategyState)[] = [
    'rigor', 'creativity', 'verbosity', 'risk_tolerance', 'obedience'
  ];
  for (const param of params) {
    const diff = target[param] - current[param];
    const nudge = Math.max(-maxDelta, Math.min(maxDelta, diff));
    result[param] = Math.max(0, Math.min(1, current[param] + nudge));
  }
  return result;
}
```

### 4.5 Strategy Statistics Update

Ported from `updatePersonalityStats()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
async function updateStrategyStats(
  strategy: StrategyState,
  outcome: { success: boolean; quality_score: number },
  store: StrategyStatsStore
): Promise<void> {
  const key = strategyKey(strategy);
  const existing = await store.getStrategyStats(key);

  if (existing) {
    existing.total_runs++;
    if (outcome.success) existing.success_count++;
    // Running average of quality
    existing.avg_quality =
      (existing.avg_quality * (existing.total_runs - 1) + outcome.quality_score) /
      existing.total_runs;
    existing.score = computeStrategyScore(existing);
    await store.updateStrategyStats(existing);
  } else {
    await store.insertStrategyStats({
      key,
      total_runs: 1,
      success_count: outcome.success ? 1 : 0,
      avg_quality: outcome.quality_score,
      score: computeStrategyScore({
        key,
        total_runs: 1,
        success_count: outcome.success ? 1 : 0,
        avg_quality: outcome.quality_score,
        score: 0
      })
    });
  }
}
```

### 4.6 SQLite Schema for Strategy Stats

```sql
CREATE TABLE strategy_stats (
  key         TEXT PRIMARY KEY,
  total_runs  INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  avg_quality REAL NOT NULL DEFAULT 0,
  score       REAL NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_strategy_score ON strategy_stats(score DESC);
```

## 5. Interface with EVO-11 Bandit

### 5.1 Division of Responsibility

| Concern | EVO-11 (Bandit) | EVO-21 (Proactive Evolution) |
|---|---|---|
| **What** | Which strategy arm to pull | What strategy parameters to use |
| **Scope** | High-level action selection (which task/gene family) | Strategy parameter tuning within a gene family |
| **Algorithm** | Multi-armed bandit (UCB1 / Thompson Sampling) | Natural selection + signal-driven mutations |
| **Timescale** | Per-decision (each evolution cycle) | Cross-cycle (accumulated statistics) |
| **State** | Arm rewards, pull counts | StrategyState, StrategyStats |

### 5.2 Integration Points

```typescript
interface BanditArm {
  arm_id: string;
  reward_mean: number;
  pull_count: number;
}

interface ProactiveEvolutionContext {
  /** Strategy parameters (from EVO-21) */
  strategy: StrategyState;

  /** Selected mutation type (from EVO-21) */
  mutation_type: MutationType;

  /** Current signals */
  signals: EvolutionSignal[];
}

/** Outcome payload — captures the arm/gene binding for traceability. */
interface EvolutionOutcome {
  success: boolean;
  reason?: string;
  selected_arm_id?: string;   // Bandit arm that was selected (omitted if no selection)
  executed_gene_id?: string;  // Gene that actually ran (omitted if none executed)
  mutation_type: MutationType;
  strategy_key: string;
  capsule?: SolidificationCapsule;
}

// EVO-11 selects WHICH gene family to try
// EVO-21 provides HOW to execute (strategy params + mutation type)
async function evolve(
  signals: EvolutionSignal[],
  bandit: BanditSelector,      // EVO-11
  strategyStore: StrategyStatsStore,  // EVO-21
  geneIndex: GeneIndex,        // EVO-19
  memoryGraph: MemoryGraph // EVO-20
): Promise<EvolutionOutcome> {
  // 1. EVO-21: Select strategy parameters
  const currentStrategy = await strategyStore.getCurrentStrategy();
  const { strategy, mutations_applied } = await selectStrategy(
    signals, currentStrategy, strategyStore
  );

  // 2. EVO-21: Determine mutation type
  const mutationType = selectMutationType(signals, strategy);

  // 3. EVO-11: Select gene family (bandit arm)
  const geneFamilies = await geneIndex.findByMutationType(mutationType);
  const arm = bandit.selectArm(geneFamilies.map(g => ({
    arm_id: g.gene_id,
    reward_mean: g.confidence,
    pull_count: g.total_uses
  })));

  // 4. EVO-20: Get memory advice for selected gene
  const advice = await memoryGraph.getMemoryAdvice(signals);

  // 5. EVO-19: Select specific gene and execute
  // BINDING: constrain gene selection to the bandit-selected arm's gene family.
  // This ensures the reward we record in step 8 corresponds to the gene family
  // the bandit actually chose, not an arbitrary gene from the full index.
  const gene = await selectGene(signals, geneIndex, advice, arm.arm_id);
  if (!gene) return {
    success: false,
    reason: 'no_gene_available',
    // Omit selected_arm_id/executed_gene_id: no gene was executed, so no
    // bandit binding to record. The bandit arm was selected but never tested,
    // so recording a reward would corrupt the learning loop.
    mutation_type: mutationType,
    strategy_key: strategyKey(strategy),
  };

  // 6. Execute solidification pipeline
  const result = await solidify(gene, signals, repoRoot, memoryGraph, geneIndex, contractGuard);

  // 7. Update statistics
  await updateStrategyStats(strategy, {
    success: result.success,
    quality_score: result.capsule?.confidence ?? 0
  }, strategyStore);

  // 8. EVO-11: Update bandit reward
  // Record reward for the arm the bandit SELECTED (arm.arm_id), not the gene
  // that executed — the bandit must learn from its own selection decisions.
  // The executed gene_id is persisted in the outcome payload for traceability.
  bandit.recordReward(arm.arm_id, result.success ? 1 : 0);

  // 9. Safety: consecutive innovate failures → fallback to repair-only
  if (mutationType === 'innovate' && !result.success) {
    const innovateFailCount = await getConsecutiveInnovateFailures(memoryGraph);
    if (innovateFailCount >= 3) {
      await strategyStore.forceRepairOnly();
    }
  }

  // 10. Return outcome with arm↔gene binding for traceability
  return {
    ...result,
    selected_arm_id: arm.arm_id,
    executed_gene_id: gene.gene_id,
    mutation_type: mutationType,
    strategy_key: strategyKey(strategy),
  };
}
```

## 6. Safety: Innovate Failure Fallback

```typescript
const MAX_CONSECUTIVE_INNOVATE_FAILURES = 3;

async function getConsecutiveInnovateFailures(
  store: MemoryGraph
): Promise<number> {
  const recent = await store.getRecentEvents(10);
  let count = 0;
  for (const event of recent) {
    if (event.event_type !== 'outcome') continue;
    if (event.payload.mutation_type !== 'innovate') break;
    if (event.payload.success) break;
    count++;
  }
  return count;
}

// Force repair-only mode: set creativity=0, risk_tolerance=0.1
async function forceRepairOnly(store: StrategyStatsStore): Promise<void> {
  const current = await store.getCurrentStrategy();
  const safeMode: StrategyState = {
    ...current,
    creativity: 0,
    risk_tolerance: 0.1,
    obedience: 1.0
  };
  await store.setCurrentStrategy(safeMode);
}
```

## 7. File Layout (CODE-01 Compliant)

```
packages/evolver-bridge/src/
├── signals-extended/
│   ├── index.ts                   -- re-exports only
│   ├── types.ts                   -- Signal type enums (~40 eLOC)
│   ├── signal-extractor.ts        -- extractSignals orchestrator (~120 eLOC)
│   ├── history-analyzer.ts        -- analyzeRecentHistory (~100 eLOC)
│   ├── code-smell-detector.ts     -- detectCodeSmells (~80 eLOC)
│   └── benchmark-compare.ts       -- compareBenchmarks (~50 eLOC)
├── mutation-types/
│   ├── index.ts                   -- re-exports
│   ├── types.ts                   -- MutationStrategy definitions (~40 eLOC)
│   ├── risk-grading.ts            -- RISK_GATE_MATRIX, determineGateLevel (~60 eLOC)
│   └── mutation-selector.ts       -- selectMutationType (~50 eLOC)
├── strategy-evolution/
│   ├── index.ts                   -- re-exports
│   ├── strategy-state.ts          -- StrategyState, defaults, strategyKey (~50 eLOC)
│   ├── strategy-scoring.ts        -- computeStrategyScore (~30 eLOC)
│   ├── strategy-mutations.ts      -- proposeMutations, applyMutations (~80 eLOC)
│   ├── strategy-selection.ts      -- selectStrategy, nudgeToward (~100 eLOC)
│   ├── strategy-stats.ts          -- updateStrategyStats, StrategyStatsStore (~60 eLOC)
│   └── safety.ts                  -- forceRepairOnly, failure fallback (~40 eLOC)
└── proactive-evolution.ts         -- evolve() orchestrator (~80 eLOC)
```

**Estimated total**: ~980 eLOC across 15 implementation files.

## 8. JSON Schema

See companion schema file:
- `schemas/mutation_proposal_v1.schema.json`
- `schemas/strategy_state_v1.schema.json`

## 9. Dependencies

| Prerequisite | Status | Notes |
|---|---|---|
| EVO-19 (Track B base) | This design | Gene Library, solidification pipeline |
| EVO-20 (Memory Graph) | This design | Signal frequency, history analysis |
| EVO-11 (Bandit) | Phase 5, pending | Strategy arm selection |
| trace-jsonl | Phase 2, pending | Signal extraction data source |

## 10. MIT Attribution Notice

```
Portions of this module are derived from Evolver (https://github.com/autogame-17/evolver)
Copyright (c) 2024-2026 AutoGame Limited
Licensed under the MIT License

Specifically ported algorithms:
- Opportunity signal enumeration and extraction (signals.js)
- Signal de-duplication and frequency suppression (signals.js)
- Recent history analysis with streak detection (signals.js)
- Force innovation/steady state triggers (signals.js)
- Failure loop detection and gene banning (signals.js)
- PersonalityState → StrategyState parameter space (personality.js)
- Strategy parameter quantization (personality.js)
- Strategy scoring with Laplace smoothing (personality.js)
- Small-step mutations with signal-driven proposals (personality.js)
- Natural selection with nudge-toward-best (personality.js)
- Strategy statistics tracking (personality.js)
```
