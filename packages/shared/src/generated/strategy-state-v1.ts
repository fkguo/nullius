/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Strategy parameter state for the proactive evolution engine. Ported from Evolver personality.js PersonalityState (MIT, AutoGame Limited).
 */
export interface StrategyStateV1 {
  /**
   * Validation thoroughness. Higher = more exhaustive testing. Increases on errors, decreases on repeated success.
   */
  rigor: number;
  /**
   * Willingness to try novel approaches. Higher = more experimental. Increases on opportunity signals and stagnation.
   */
  creativity: number;
  /**
   * Detail level in generated outputs. Lower values preferred for automated operations.
   */
  verbosity: number;
  /**
   * Acceptable blast radius tolerance. Decreases on errors, increases on opportunity signals.
   */
  risk_tolerance: number;
  /**
   * Constraint adherence. Higher = stricter enforcement of Contract rules. Rarely mutated.
   */
  obedience: number;
}
