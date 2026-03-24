import type { EpigeneticMark } from '../generated/index.js';
import type { CapsuleWithMeta, EdgeStat, MemoryGraphEdge, MemoryGraphEvent, MemoryGraphNode, NodeSummary, SignalFrequencyResult } from './types.js';

export interface CandidateEdgeStat extends EdgeStat {
  normalized_signals: string;
}

export interface StoredEventInput {
  eventType: MemoryGraphEvent['event_type'];
  runId?: string | null;
  traceId?: string | null;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface UpsertEdgeStatInput {
  signalKey: string;
  geneId: string;
  success: boolean;
  eventTs: string;
  halfLifeDays: number;
}

export interface GenePriorUpdate {
  geneId: string;
  success: boolean;
  eventTs: string;
}

export interface NodeDecayInput {
  id: string;
  updated_at: string;
}

export interface NodeDecayUpdate {
  id: string;
  weight: number;
  decayTs: string;
}

export interface MemoryGraphStore {
  insertEvent(event: StoredEventInput): Promise<void>;
  getOutcomeEventsAfter(lastEventId: number): Promise<MemoryGraphEvent[]>;
  getRecentEvents(limit: number): Promise<MemoryGraphEvent[]>;
  upsertSignalSet(signalKey: string, normalizedSignals: string[]): Promise<void>;
  incrementSignalFrequency(signalKey: string, signalValue: string, ts?: string): Promise<void>;
  topSignals(windowDays: number, limit: number): Promise<SignalFrequencyResult[]>;
  highFrequencySignals(threshold: number, windowDays: number): Promise<string[]>;
  getCandidateEdgeStats(normalizedSignals: string[], recencyWindowDays: number, candidateLimit: number): Promise<CandidateEdgeStat[]>;
  upsertEdgeStat(input: UpsertEdgeStatInput): Promise<void>;
  getGenePriorsBatch(geneIds: string[]): Promise<Map<string, number>>;
  upsertGenePrior(update: GenePriorUpdate): Promise<void>;
  getAggregationWatermark(): Promise<{ last_event_id: number } | null>;
  setAggregationWatermark(lastEventId: number): Promise<void>;
  addNode(node: Omit<MemoryGraphNode, 'id' | 'created_at' | 'updated_at'>): Promise<string>;
  addEdge(edge: Omit<MemoryGraphEdge, 'id' | 'created_at'>): Promise<string>;
  updateGeneMarks(geneId: string, marks: EpigeneticMark[]): Promise<void>;
  archivalCandidates(weightThreshold: number): Promise<NodeSummary[]>;
  listNodeDecayInputs(): Promise<NodeDecayInput[]>;
  applyNodeDecayUpdates(updates: NodeDecayUpdate[]): Promise<void>;
  findSimilarCapsules(normalizedTrigger: string[], jaccardThreshold: number): Promise<CapsuleWithMeta[]>;
}
