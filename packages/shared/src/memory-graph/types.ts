import type {
  BlastRadiusSummary,
  EpigeneticMark,
  MemoryGraphEdgeV1,
  MemoryGraphEventV1,
  MemoryGraphNodeV1,
} from '../generated/index.js';

export type MemoryGraphNode = MemoryGraphNodeV1;
export type MemoryGraphEdge = MemoryGraphEdgeV1;
export type MemoryGraphEvent = MemoryGraphEventV1;
export type MemoryGraphTrack = MemoryGraphNode['track'];
export type MemoryGraphMutationType = 'repair' | 'optimize' | 'innovate';

export interface MemoryGraphOutcomePayload {
  signal_key: string;
  success: boolean;
  reason?: string;
  mutation_type?: MemoryGraphMutationType;
  selected_arm_id?: string;
  executed_gene_id?: string;
  quality_score?: number;
  blast_radius?: BlastRadiusSummary;
  files_modified?: string[];
  error_delta?: number;
  details_artifact_uri?: string | null;
  validation_passed?: boolean;
  gate_level?: string;
}

export interface MemoryAdvice {
  preferredGeneId: string | null;
  bannedGeneIds: string[];
  scores: Map<string, number>;
}

export interface SignalFrequencyResult {
  signal: string;
  count: number;
}

export interface NodeSummary {
  id: string;
  nodeType: string;
  track: MemoryGraphTrack;
  weight: number;
  updatedAt: string;
}

export interface CapsuleWithMeta {
  node: MemoryGraphNode;
  similarity: number;
}

export interface EdgeStat {
  signal_key: string;
  gene_id: string;
  success: number;
  fail: number;
  total: number;
  last_ts: string;
  laplace_p: number;
  decay_w: number;
}

export interface CreateMemoryGraphOptions {
  dbPath: string;
  halfLifeDays?: number;
}

export type NewMemoryGraphNode = Omit<MemoryGraphNode, 'id' | 'created_at' | 'updated_at'>;
export type NewMemoryGraphEdge = Omit<MemoryGraphEdge, 'id' | 'created_at'>;

export interface MemoryGraph {
  recordSignalSnapshot(runId: string | null, signals: string[], traceId?: string | null): Promise<void>;
  recordHypothesis(
    runId: string | null,
    geneId: string,
    signals: string[],
    selectionReason?: string,
    traceId?: string | null,
  ): Promise<void>;
  recordAttempt(
    runId: string | null,
    geneId: string,
    mutationType?: MemoryGraphMutationType,
    traceId?: string | null,
  ): Promise<void>;
  recordOutcome(
    runId: string | null,
    geneId: string,
    outcome: MemoryGraphOutcomePayload,
    traceId?: string | null,
  ): Promise<void>;
  recordConfidenceEdge(signalKey: string, geneId: string, success: boolean, traceId?: string | null): Promise<void>;
  getMemoryAdvice(currentSignals: string[]): Promise<MemoryAdvice>;
  topSignals(windowDays: number, limit: number): Promise<SignalFrequencyResult[]>;
  highFrequencySignals(threshold: number, windowDays: number): Promise<string[]>;
  getRecentEvents(limit: number): Promise<MemoryGraphEvent[]>;
  aggregateEdges(): Promise<void>;
  archivalCandidates(weightThreshold: number): Promise<NodeSummary[]>;
  recalculateDecay(halfLifeDays?: number): Promise<{ updated: number }>;
  addNode(node: NewMemoryGraphNode): Promise<string>;
  addEdge(edge: NewMemoryGraphEdge): Promise<string>;
  incrementSignalFrequency(signalKey: string, signalValue: string, ts?: string): Promise<void>;
  updateGeneMarks(geneId: string, marks: EpigeneticMark[]): Promise<void>;
  findSimilarCapsules(normalizedTrigger: string[], jaccardThreshold: number): Promise<CapsuleWithMeta[]>;
}
