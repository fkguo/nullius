import type { ResearchEvent } from '../model/research-event.js';
import type { ResearchSignal } from '../model/research-signal.js';
import { dedupSignals } from './dedup.js';
import { detectEventNativeSignals } from './event-native-detectors.js';
import { synthesizeStagnation } from './stagnation.js';
import type { ExtractSignalsOptions } from './types.js';

export function extractSignals(
  events: readonly ResearchEvent[],
  options: ExtractSignalsOptions = {},
): ResearchSignal[] {
  const eventNativeSignals = detectEventNativeSignals(events);
  const dedupedSignals = dedupSignals(eventNativeSignals, options.dedupWindowsMs);
  const stagnationSignals = synthesizeStagnation(events, dedupedSignals, options);
  return dedupSignals([...dedupedSignals, ...stagnationSignals], options.dedupWindowsMs);
}
