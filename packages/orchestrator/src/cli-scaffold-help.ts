export const INIT_HELP = `nullius init

Bootstrap a real external project root and initialize .nullius state.

Behavior:
  Always writes the project-local fallback launcher at \`.nullius/bin/nullius\`.
  That wrapper keeps \`nullius status --json\` as the canonical recovery command even when
  \`nullius\` is unavailable on PATH for a fresh external project.
  --refresh re-applies the current managed scaffold doc (AGENTS.md),
  backing up any changed file under \`.nullius/backups/<timestamp>/\` before overwriting it.
  Refresh never writes user-owned files (research_plan.md, research_notebook.md,
  research_contract.md, project_charter.md, project_index.md,
  reports/main_research_report_template.md). Pair with --dry-run to preview.

Existing-project main-report migration:
  Checkpoint the project first. Refresh AGENTS.md, then render a fresh scaffold
  in a separate temporary external root with \`nullius init --project-root <temporary-root>\`.
  Copy only a missing reports/main_research_report_template.md from that root;
  never overwrite an existing copy. Manually merge the temporary
  project_index.md#Main research report section and empty registry into the
  existing user-owned project_index.md. Refresh does not perform either step.
  Until the registry exists and points to a populated current report,
  \`nullius report-validate\` fails closed with invalid_registry_markers or
  no_current_report.

Pass-through options:
  --force
  --refresh
  --dry-run        With --refresh: preview what would change without writing.
  --allow-nested
  --runtime-only
  --checkpoint-interval-seconds <seconds>
  --mode <engine|file>   Declare where project truth lives. engine: the nullius
                         run/approve lifecycle drives the project. file: work is
                         executed by hand or external runners, durable truth lives in
                         research_plan.md / research_contract.md and dated run
                         directories, and run_status legitimately stays idle.
                         Works on an already-initialized root (including with
                         --runtime-only) to declare or change the mode; recorded in
                         .nullius/state.json and surfaced by the status receipt.
                         Without --mode the project stays undeclared and status may
                         hint when the evidence looks file-mode.

Use --project-root <path> to target a root explicitly.
`;
