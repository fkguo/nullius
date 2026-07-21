export const STATUS_HELP = `nullius status

Show the current lifecycle state for the nearest project root.

Options:
  --json   Emit machine-readable JSON.

Behavior:
  Includes current-run lifecycle truth plus a thin project-level recent digest for recent runs,
  latest final conclusions, latest proposals, and the latest active team summary when readable.
  When \`state.json#/plan\` exists but derived \`.nullius/plan.md\` is missing or stale, status rebuilds the plan view from state and reports a structured warning instead of showing an empty plan.
  Status JSON also includes the legacy-stable \`resume_context\`, the richer \`recovery_context\`,
  and \`current_run_workflow_outputs\` so a reconnecting agent can recover the current run,
  reuse bounded workflow outputs, and fall back to \`.nullius/bin/nullius status --json\`
  when the canonical \`nullius\` command is not available on PATH.
  Status JSON also includes \`project_surface_drift\`, a diagnostic-only warning block for stale legacy scaffold surfaces or optional host-local guidance noise in the current project root.
  Status JSON also includes \`execution_mode\` (declared via \`nullius init --mode=<engine|file>\`; null when never declared) and \`decision_ledger\`, the conversational-decision record with any still-open items.
  When durable workflow outputs are missing for an older run, status rebuilds a best-effort legacy workflow projection from ledger/artifact conventions and reports the projection source.
`;

export const APPROVE_HELP = `nullius approve <approval_id>

Approve the pending gate for the current project root.

Options:
  --note "..."   Record a ledger note with the approval.

Behavior:
  Non-A5 approvals resume the run as before.
  A generic A5 consumer exists for a future complete-dependency-closure path, but current validation bindings leave A5 unavailable and cannot create that pending approval.
`;

export const PAUSE_HELP = `nullius pause

Pause the current run for the current project root.

Options:
  --note "..."   Record a ledger note with the pause.
`;

export const RESUME_HELP = `nullius resume

Resume the current paused run for the current project root.

Options:
  --note "..."   Record a ledger note with the resume.
  --force        Allow resume from terminal states (idle/completed/failed).
`;
