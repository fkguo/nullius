import * as fs from 'node:fs';
import type { ComputationResultV1 } from '@autoresearch/shared';

type FeedbackSignal = ComputationResultV1['feedback_lowering']['signal'];
type CompletedFeedbackSignal = Exclude<FeedbackSignal, 'failure'>;

function readCompletedFeedbackSignal(filePath: string): CompletedFeedbackSignal | null {
  if (!filePath.endsWith('.json') || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const signal = (parsed as Record<string, unknown>).feedback_signal;
    if (signal === 'success' || signal === 'weak_signal') {
      return signal;
    }
    return null;
  } catch {
    return null;
  }
}

export function deriveFeedbackSignal(params: {
  executionStatus: 'completed' | 'failed';
  producedOutputs: string[];
}): FeedbackSignal {
  if (params.executionStatus === 'failed') {
    return 'failure';
  }
  let sawWeakSignal = false;
  for (const filePath of [...params.producedOutputs].sort()) {
    const signal = readCompletedFeedbackSignal(filePath);
    if (signal === 'success') {
      return 'success';
    }
    if (signal === 'weak_signal') {
      sawWeakSignal = true;
    }
  }
  return sawWeakSignal ? 'weak_signal' : 'success';
}
