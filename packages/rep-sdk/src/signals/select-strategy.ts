import type { StrategyPreset } from '../model/research-strategy.js';
import {
  PRIORITY_WEIGHTS,
  SELECTOR_SIGNAL_STRATEGY_MAP,
  type SelectStrategyInput,
  type StrategySelectionResult,
} from './types.js';

const PRESET_ORDER: readonly StrategyPreset[] = ['explore', 'deepen', 'verify', 'consolidate'];

export function selectStrategy(input: SelectStrategyInput): StrategySelectionResult {
  const decisiveSignals = new Map<StrategyPreset, string[]>(PRESET_ORDER.map((preset) => [preset, []]));
  const all_scores = Object.fromEntries(
    PRESET_ORDER.map((preset) => [preset, { signal_match_score: 0, final_score: 0 }]),
  ) as StrategySelectionResult['all_scores'];
  const maxPossible = input.signals.length * PRIORITY_WEIGHTS.critical;

  for (const signal of input.signals) {
    const preset = SELECTOR_SIGNAL_STRATEGY_MAP[signal.signal_type];
    if (!preset) {
      continue;
    }
    all_scores[preset].signal_match_score += signal.confidence * PRIORITY_WEIGHTS[signal.priority];
    decisiveSignals.get(preset)?.push(signal.signal_id);
  }

  for (const preset of PRESET_ORDER) {
    const normalized = maxPossible > 0 ? all_scores[preset].signal_match_score / maxPossible : 0;
    all_scores[preset] = { signal_match_score: normalized, final_score: normalized };
  }

  const selectedStrategy = PRESET_ORDER.reduce((best, current) =>
    all_scores[current].final_score > all_scores[best].final_score ? current : best,
  );
  const selectedSignals = decisiveSignals.get(selectedStrategy) ?? [];
  const matchedTypes = [...new Set(
    input.signals
      .filter((signal) => SELECTOR_SIGNAL_STRATEGY_MAP[signal.signal_type] === selectedStrategy)
      .map((signal) => signal.signal_type),
  )];
  const reasoning =
    input.signals.length === 0
      ? 'Selected strategy: "explore" (score: 0.000). No active signals were provided, so the selector fell back to the default preset ordering.'
      : `Selected strategy: "${selectedStrategy}" (score: ${all_scores[selectedStrategy].final_score.toFixed(3)}). Driven by ${selectedSignals.length} signal(s): ${matchedTypes.join(', ') || 'none'}.`;

  return {
    selected_strategy: selectedStrategy,
    score: all_scores[selectedStrategy].final_score,
    all_scores,
    reasoning,
    decisive_signals: selectedSignals,
  };
}
