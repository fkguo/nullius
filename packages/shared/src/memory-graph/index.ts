export type {
  CapsuleWithMeta,
  CreateMemoryGraphOptions,
  EdgeStat,
  MemoryAdvice,
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphEvent,
  MemoryGraphMutationType,
  MemoryGraphNode,
  MemoryGraphOutcomePayload,
  NewMemoryGraphEdge,
  NewMemoryGraphNode,
  NodeSummary,
  SignalFrequencyResult,
} from './types.js';

export { createMemoryGraph } from './memory-graph.js';
export { computeSignalKey, normalizeSignal, normalizeSignals } from './hash.js';
export { DEFAULT_HALF_LIFE_DAYS, decayWeight, edgeExpectedSuccess, laplaceProbability } from './decay.js';
export { jaccardSimilarity } from './similarity.js';
