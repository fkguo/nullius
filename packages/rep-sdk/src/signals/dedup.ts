import type {
  ResearchSignal,
  ResearchSignalPriority,
  ResearchSignalType,
} from '../model/research-signal.js';
import { DEFAULT_DEDUP_WINDOWS_MS } from './types.js';

const PRIORITY_RANK: Record<ResearchSignalPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function dedupSignals(
  signals: readonly ResearchSignal[],
  dedupWindowsMs: Partial<Record<ResearchSignalType, number>> = {},
): ResearchSignal[] {
  const merged: ResearchSignal[] = [];
  const latestByFingerprint = new Map<string, number>();

  for (const signal of signals) {
    const key = `${signal.signal_type}:${signal.fingerprint}`;
    const existingIndex = latestByFingerprint.get(key);
    if (existingIndex === undefined) {
      merged.push(cloneSignal(signal));
      latestByFingerprint.set(key, merged.length - 1);
      continue;
    }

    const windowMs = dedupWindowsMs[signal.signal_type] ?? DEFAULT_DEDUP_WINDOWS_MS[signal.signal_type];
    const current = merged[existingIndex];
    // `0` means merge every same-fingerprint signal across the full input sequence.
    if (windowMs > 0 && Date.parse(signal.detected_at) - Date.parse(current.detected_at) > windowMs) {
      merged.push(cloneSignal(signal));
      latestByFingerprint.set(key, merged.length - 1);
      continue;
    }

    // SAFETY: the dedup key includes `signal_type`, so merged signals share the same discriminant.
    merged[existingIndex] = mergeSignals(current, signal);
  }

  return merged;
}

function cloneSignal(signal: ResearchSignal): ResearchSignal {
  return { ...signal, source_event_ids: [...signal.source_event_ids] };
}

function mergeSignals(existing: ResearchSignal, incoming: ResearchSignal): ResearchSignal {
  return {
    ...existing,
    payload: incoming.payload,
    source_event_ids: [...new Set([...existing.source_event_ids, ...incoming.source_event_ids])],
    confidence: Math.max(existing.confidence, incoming.confidence),
    priority:
      PRIORITY_RANK[incoming.priority] > PRIORITY_RANK[existing.priority]
        ? incoming.priority
        : existing.priority,
    detected_at:
      Date.parse(incoming.detected_at) > Date.parse(existing.detected_at)
        ? incoming.detected_at
        : existing.detected_at,
    expires_at: mergeExpiry(existing.expires_at, incoming.expires_at),
    run_id: existing.run_id ?? incoming.run_id,
  } as ResearchSignal;
}

function mergeExpiry(existing?: string, incoming?: string): string | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  return Date.parse(incoming) > Date.parse(existing) ? incoming : existing;
}
