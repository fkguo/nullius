import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ComputationResultV1 } from '@nullius/shared';

type FeedbackSignal = NonNullable<ComputationResultV1['feedback_lowering']>['signal'];
export const RESEARCH_FEEDBACK_FILENAME = 'research_feedback.json';

/** Only the explicitly named, declared output can authorize research follow-up. */
export function readFeedbackDeclaration(params: {
  executionStatus: 'completed' | 'failed';
  producedOutputs: string[];
}): { signal: FeedbackSignal; filePath: string } | null {
  if (params.executionStatus !== 'completed') return null;
  const files = [...new Set(params.producedOutputs.map(file => path.resolve(file)))]
    .filter(file => path.basename(file) === RESEARCH_FEEDBACK_FILENAME);
  if (files.length !== 1) return null;
  const filePath = files[0]!;
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const signal = (value as Record<string, unknown>).feedback_signal;
    return signal === 'success' || signal === 'weak_signal' || signal === 'failure'
      ? { signal, filePath } : null;
  } catch {
    return null;
  }
}
