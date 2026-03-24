import type { MemoryGraphStore } from './store.js';
import type { MemoryGraphEvent, MemoryGraphOutcomePayload } from './types.js';

function isOutcomePayload(payload: unknown): payload is MemoryGraphOutcomePayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.signal_key === 'string' && typeof candidate.success === 'boolean';
}

export async function aggregateEdges(
  store: Pick<MemoryGraphStore, 'getAggregationWatermark' | 'getOutcomeEventsAfter' | 'setAggregationWatermark' | 'upsertEdgeStat'>,
  halfLifeDays: number,
): Promise<void> {
  const watermark = await store.getAggregationWatermark();
  const events = await store.getOutcomeEventsAfter(watermark?.last_event_id ?? 0);
  if (events.length === 0) return;

  for (const event of events) {
    const payload = event.payload;
    if (!isOutcomePayload(payload)) continue;
    const typedPayload = payload as MemoryGraphOutcomePayload & { gene_id?: string };
    const geneId = typedPayload.executed_gene_id ?? typedPayload.gene_id ?? '';
    if (!geneId) continue;
    await store.upsertEdgeStat({
      signalKey: payload.signal_key,
      geneId,
      success: payload.success,
      eventTs: event.created_at,
      halfLifeDays,
    });
  }

  const lastEvent = events[events.length - 1] as MemoryGraphEvent;
  await store.setAggregationWatermark(Number(lastEvent.id ?? watermark?.last_event_id ?? 0));
}
