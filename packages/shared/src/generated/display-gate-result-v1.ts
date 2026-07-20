/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Machine verdict of the display-acceptance gate: before a figure or table becomes durable or outward-facing, its provenance bundle must bind every plotted quantity to a verification-gate verdict artifact and archive a human-review overview figure spanning all output components. The verdict is computed only by the gate script; callers must not self-assess. Fail-closed: missing or unverifiable evidence is a failure, never a pass.
 */
export interface DisplayGateResultV1 {
  schema_version: 1;
  /**
   * Path of the figure provenance manifest that was judged.
   */
  manifest: string;
  /**
   * Falsification-labelled verdict. pass only when every plotted quantity has a binding whose verdict artifact exists, hashes to the recorded digest, covers that quantity, and records an accepted outcome, AND the all-component overview figure is archived and present on disk.
   */
  result:
    | "pass"
    | "missing_verdict_binding"
    | "verdict_mismatch"
    | "missing_overview_figure"
    | "invalid_manifest";
  findings: DisplayGateFinding[];
  /**
   * Number of plotted quantities declared in the manifest.
   */
  quantities_declared: number;
  /**
   * Number of verdict bindings inspected.
   */
  bindings_checked: number;
  /**
   * Declared path of the archived human-review overview figure, or null when undeclared.
   */
  overview_figure: string | null;
}
/**
 * This interface was referenced by `DisplayGateResultV1`'s JSON-Schema
 * via the `definition` "DisplayGateFinding".
 */
export interface DisplayGateFinding {
  /**
   * Fine-grained finding label, e.g. missing-binding, verdict-hash-mismatch, quantity-not-covered, overview-file-missing.
   */
  kind: string;
  /**
   * The result-level category this finding rolls up into.
   */
  category:
    | "missing_verdict_binding"
    | "verdict_mismatch"
    | "missing_overview_figure"
    | "invalid_manifest";
  message: string;
  /**
   * Plotted-quantity identifier the finding concerns, when applicable.
   */
  quantity?: string;
  /**
   * File path the finding concerns, when applicable.
   */
  path?: string;
}
