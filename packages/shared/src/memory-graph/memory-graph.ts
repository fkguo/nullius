import type { EpigeneticMark } from '../generated/index.js';
import { DEFAULT_HALF_LIFE_DAYS, decayWeight } from './decay.js';
import { aggregateEdges } from './aggregator.js';
import { getMemoryAdvice } from './advice.js';
import { createSqliteMemoryGraphStore } from './store-sqlite.js';
import { recordAttempt, recordConfidenceEdge, recordHypothesis, recordOutcome, recordSignalSnapshot } from './recorder.js';
import type { CreateMemoryGraphOptions, MemoryGraph, MemoryGraphMutationType, MemoryGraphOutcomePayload, NewMemoryGraphEdge, NewMemoryGraphNode } from './types.js';

class SqliteMemoryGraph implements MemoryGraph {
  private readonly store;
  private readonly halfLifeDays;

  constructor(options: CreateMemoryGraphOptions) {
    this.store = createSqliteMemoryGraphStore(options.dbPath);
    this.halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  }

  recordSignalSnapshot(runId: string | null, signals: string[], traceId?: string | null): Promise<void> {
    return recordSignalSnapshot(this.store, runId, signals, traceId);
  }

  recordHypothesis(runId: string | null, geneId: string, signals: string[], selectionReason?: string, traceId?: string | null): Promise<void> {
    return recordHypothesis(this.store, runId, geneId, signals, selectionReason, traceId);
  }

  recordAttempt(runId: string | null, geneId: string, mutationType?: MemoryGraphMutationType, traceId?: string | null): Promise<void> {
    return recordAttempt(this.store, runId, geneId, mutationType, traceId);
  }

  recordOutcome(runId: string | null, geneId: string, outcome: MemoryGraphOutcomePayload, traceId?: string | null): Promise<void> {
    return recordOutcome(this.store, runId, geneId, outcome, traceId);
  }

  recordConfidenceEdge(signalKey: string, geneId: string, success: boolean, traceId?: string | null): Promise<void> {
    return recordConfidenceEdge(this.store, signalKey, geneId, success, traceId);
  }

  getMemoryAdvice(currentSignals: string[]) { return getMemoryAdvice(currentSignals, this.store, new Date(), this.halfLifeDays); }
  topSignals(windowDays: number, limit: number) { return this.store.topSignals(windowDays, limit); }
  highFrequencySignals(threshold: number, windowDays: number) { return this.store.highFrequencySignals(threshold, windowDays); }
  getRecentEvents(limit: number) { return this.store.getRecentEvents(limit); }
  aggregateEdges() { return aggregateEdges(this.store, this.halfLifeDays); }
  archivalCandidates(weightThreshold: number) { return this.store.archivalCandidates(weightThreshold); }
  addNode(node: NewMemoryGraphNode) { return this.store.addNode(node); }
  addEdge(edge: NewMemoryGraphEdge) { return this.store.addEdge(edge); }
  incrementSignalFrequency(signalKey: string, signalValue: string, ts?: string) { return this.store.incrementSignalFrequency(signalKey, signalValue, ts); }
  updateGeneMarks(geneId: string, marks: EpigeneticMark[]) { return this.store.updateGeneMarks(geneId, marks); }
  findSimilarCapsules(normalizedTrigger: string[], jaccardThreshold: number) { return this.store.findSimilarCapsules(normalizedTrigger, jaccardThreshold); }

  async recalculateDecay(halfLifeDays = this.halfLifeDays): Promise<{ updated: number }> {
    const now = new Date();
    const updates = (await this.store.listNodeDecayInputs()).map(node => ({
      id: node.id,
      weight: decayWeight(node.updated_at, now, halfLifeDays),
      decayTs: now.toISOString(),
    }));
    await this.store.applyNodeDecayUpdates(updates);
    return { updated: updates.length };
  }
}

export function createMemoryGraph(options: CreateMemoryGraphOptions): MemoryGraph {
  return new SqliteMemoryGraph(options);
}
