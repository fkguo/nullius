/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Structured self-report emitted by a checker directly executed by Nullius. request_sha256 binds the report to the exact Nullius-generated request; matching observations do not by themselves prove that the checker actually read the output or executed the named negative controls.
 */
export interface ValidationCheckerVerdictV1 {
  schema_version: 1;
  request_sha256: string;
  check_kind: string;
  status: "pass" | "fail" | "blocked";
  summary: string;
  quantity_id: string;
  layer_id: string;
  /**
   * @minItems 1
   */
  disputed_dimensions: [string, ...string[]];
  /**
   * @minItems 1
   */
  consumed_output_observations: [
    {
      uri: string;
      path: string;
      sha256: string;
    },
    ...{
      uri: string;
      path: string;
      sha256: string;
    }[],
  ];
  /**
   * @minItems 1
   */
  negative_control_results: [
    {
      control_id: string;
      status: "pass" | "fail" | "blocked";
    },
    ...{
      control_id: string;
      status: "pass" | "fail" | "blocked";
    }[],
  ];
}
