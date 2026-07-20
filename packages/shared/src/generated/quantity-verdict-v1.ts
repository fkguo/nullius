/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * This interface was referenced by `QuantityVerdictV1`'s JSON-Schema
 * via the `definition` "QuantityVerdictIdentifier".
 */
export type QuantityVerdictIdentifier = string;
/**
 * Closed verification outcome. A consuming gate decides which outcome is acceptable; producers cannot extend this vocabulary.
 *
 * This interface was referenced by `QuantityVerdictV1`'s JSON-Schema
 * via the `definition` "QuantityVerdictOutcome".
 */
export type QuantityVerdictOutcome = "pass" | "fail";

/**
 * Domain-neutral, closed verdict artifact binding one verification outcome to an explicit non-empty set of quantity identifiers. Display and other acceptance gates consume this artifact only after validating its schema identity and version.
 */
export interface QuantityVerdictV1 {
  schema_id: "quantity_verdict_v1";
  schema_version: 1;
  /**
   * Stable identifiers of every quantity covered by this verdict.
   *
   * @minItems 1
   */
  quantities: [QuantityVerdictIdentifier, ...QuantityVerdictIdentifier[]];
  verdict: QuantityVerdictOutcome;
}
