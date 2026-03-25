import { describe, expect, it } from 'vitest';
import { selectStrategy } from '../src/signals/index.js';
import type { ResearchSignal, ResearchSignalType } from '../src/model/research-signal.js';

describe('selectStrategy', () => {
  it('prefers explore for plateau and stagnation-driven signals', () => {
    const result = selectStrategy({
      signals: [
        researchSignal('method_plateau', 'critical', 0.9, 'sig-plateau'),
        researchSignal('stagnation', 'high', 0.8, 'sig-stagnation'),
      ],
    });

    expect(result.selected_strategy).toBe('explore');
    expect(result.decisive_signals).toEqual(['sig-plateau', 'sig-stagnation']);
    expect(result.score).toBeGreaterThan(result.all_scores.verify.final_score);
    expect(result.reasoning).toContain('method_plateau');
    expect(result.reasoning).toContain('stagnation');
  });

  it('prefers verify for cross-check opportunities and falls back to explore on ties', () => {
    const verifyResult = selectStrategy({
      signals: [researchSignal('cross_check_opportunity', 'high', 0.75, 'sig-cross-check')],
    });
    const fallbackResult = selectStrategy({ signals: [] });

    expect(verifyResult.selected_strategy).toBe('verify');
    expect(verifyResult.decisive_signals).toEqual(['sig-cross-check']);
    expect(fallbackResult.selected_strategy).toBe('explore');
    expect(Object.values(fallbackResult.all_scores)).toEqual([
      { signal_match_score: 0, final_score: 0 },
      { signal_match_score: 0, final_score: 0 },
      { signal_match_score: 0, final_score: 0 },
      { signal_match_score: 0, final_score: 0 },
    ]);
  });

  it('keeps deferred signal types from activating deepen or consolidate in this slice', () => {
    const result = selectStrategy({
      signals: [researchSignal('parameter_sensitivity', 'critical', 1, 'sig-deferred')],
    });

    expect(result.selected_strategy).toBe('explore');
    expect(result.decisive_signals).toEqual([]);
    expect(result.all_scores.deepen).toEqual({ signal_match_score: 0, final_score: 0 });
    expect(result.all_scores.consolidate).toEqual({ signal_match_score: 0, final_score: 0 });
  });
});

function researchSignal(
  signalType: ResearchSignalType,
  priority: ResearchSignal['priority'],
  confidence: number,
  signalId: string,
): ResearchSignal {
  return {
    schema_version: 1,
    signal_id: signalId,
    signal_type: signalType,
    source_event_ids: [`event-for-${signalId}`],
    fingerprint: `fingerprint-for-${signalId}`,
    confidence,
    priority,
    detected_at: '2026-03-25T00:00:00.000Z',
    payload: payloadFor(signalType),
  } as ResearchSignal;
}

function payloadFor(signalType: ResearchSignalType): ResearchSignal['payload'] {
  switch (signalType) {
    case 'method_plateau':
      return { current_method: 'strategy-a', cycles_without_improvement: 4 };
    case 'stagnation':
      return { consecutive_empty_cycles: 5, threshold: 5, current_strategy: 'strategy-a' };
    case 'cross_check_opportunity':
      return { new_outcome_ref: 'outcome-2', existing_outcome_refs: ['outcome-1'] };
    default:
      return { gap_description: 'unused in this test', domain_area: 'generic' };
  }
}
