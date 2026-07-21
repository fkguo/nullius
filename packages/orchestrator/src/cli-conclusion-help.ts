export const FINAL_CONCLUSIONS_HELP = `nullius final-conclusions --run-id <id> [options]

Evaluate whether a completed run is ready for the higher-conclusion A5 boundary.

Options:
  --run-id <id>         Required run identifier whose canonical computation_result_v1 should be checked
  --note "..."          Optional operator note recorded if an A5 approval request is created

Behavior:
  Requires an initialized external project root (\`nullius init\`).
  Reads the canonical \`artifacts/computation_result_v1.json\` and its typed verification refs.
  The consumer currently supports exactly one canonical subject, verdict, and coverage artifact.
  Every current validation binding declares an incomplete dependency/import closure, so A5 currently returns \`unavailable\` and creates no approval request even when the checker self-reports pass.
  \`hold\`, \`block\`, and \`unavailable\` fail closed and do not create pending approval state.
  The generic A5 approval consumer remains implemented for a future complete-closure path; it is not reachable from current validation bindings.

Output:
  JSON readiness or approval-request result is written to stdout.
`;

export const REPORT_VALIDATE_HELP = `nullius report-validate

Validate the single promoted main research report for an external project.

Behavior:
  Reads the main-report registry in project_index.md and fails closed when no
  current report is promoted, a checkpoint/status summary is structurally
  incomplete, a historical report no longer matches its registered SHA-256,
  the supersession chain or current pointer is stale, human-readable evidence
  is replaced by machine references, authoring instructions remain in the
  researcher-facing report, or same implementation plus same input is labeled
  independent. Environment differences do not make that replay independent.
  Report and registry structure counts only when it is visible Markdown;
  fenced code and ordinary HTML comments cannot supply markers, fields,
  validation records, current pointers, or registry rows. Required report
  fields must occur exactly once in their authoritative section.
  The check is structural. A pass does not establish scientific sufficiency.

Output:
  main_research_report_v1 validation JSON is written to stdout.
`;
