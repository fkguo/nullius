import { invalidParams } from '../errors.js';
import { computeSignalKey, normalizeSignals } from './hash.js';
import type { MemoryGraphStore } from './store.js';
import type { MemoryGraphMutationType, MemoryGraphOutcomePayload } from './types.js';

export async function recordSignalSnapshot(
  store: Pick<MemoryGraphStore, 'insertEvent' | 'upsertSignalSet' | 'incrementSignalFrequency'>,
  runId: string | null,
  signals: string[],
  traceId?: string | null,
): Promise<void> {
  const normalizedSignals = normalizeSignals(signals);
  if (normalizedSignals.length === 0) {
    throw invalidParams('recordSignalSnapshot requires at least one non-empty signal');
  }

  const signalKey = computeSignalKey(normalizedSignals);
  await store.upsertSignalSet(signalKey, normalizedSignals);
  for (const signal of normalizedSignals) {
    await store.incrementSignalFrequency(signalKey, signal);
  }
  await store.insertEvent({ eventType: 'signal', runId, traceId, payload: { type: 'signal', signals: normalizedSignals, signal_key: signalKey } });
}

export async function recordHypothesis(
  store: Pick<MemoryGraphStore, 'insertEvent'>,
  runId: string | null,
  geneId: string,
  signals: string[],
  selectionReason?: string,
  traceId?: string | null,
): Promise<void> {
  const normalizedSignals = normalizeSignals(signals);
  await store.insertEvent({
    eventType: 'hypothesis',
    runId,
    traceId,
    payload: { type: 'hypothesis', gene_id: geneId, signals: normalizedSignals, signal_key: computeSignalKey(normalizedSignals), ...(selectionReason ? { selection_reason: selectionReason } : {}) },
  });
}

export async function recordAttempt(
  store: Pick<MemoryGraphStore, 'insertEvent'>,
  runId: string | null,
  geneId: string,
  mutationType?: MemoryGraphMutationType,
  traceId?: string | null,
): Promise<void> {
  await store.insertEvent({ eventType: 'attempt', runId, traceId, payload: { type: 'attempt', gene_id: geneId, ...(mutationType ? { mutation_type: mutationType } : {}) } });
}

export async function recordOutcome(
  store: Pick<MemoryGraphStore, 'insertEvent' | 'upsertGenePrior'>,
  runId: string | null,
  geneId: string,
  outcome: MemoryGraphOutcomePayload,
  traceId?: string | null,
): Promise<void> {
  const createdAt = new Date().toISOString();
  const payload = { type: 'outcome', gene_id: geneId, ...outcome };
  await store.insertEvent({ eventType: 'outcome', runId, traceId, payload, createdAt });
  await store.upsertGenePrior({ geneId, success: outcome.success, eventTs: createdAt });
}

export async function recordConfidenceEdge(
  store: Pick<MemoryGraphStore, 'insertEvent'>,
  signalKey: string,
  geneId: string,
  success: boolean,
  traceId?: string | null,
): Promise<void> {
  await store.insertEvent({ eventType: 'confidence_edge', traceId, payload: { type: 'confidence_edge', signal_key: signalKey, gene_id: geneId, success } });
}
