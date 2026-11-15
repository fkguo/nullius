export const INIT_HELP = `nullius init

Bootstrap a real external project root and initialize .nullius state.

Behavior:
  Always writes the project-local fallback launcher at \`.nullius/bin/nullius\`.
  That wrapper keeps \`nullius status --json\` as the canonical recovery command even when
  \`nullius\` is unavailable on PATH for a fresh external project.
  nullius init --refresh generates missing support guidance (AGENTS.md). Pair with --dry-run to preview.
  Scaffold refresh preserves user-owned seed content (research_plan.md, research_notebook.md,
  research_contract.md, project_charter.md, project_index.md,
  reports/main_research_report_template.md, .gitignore).
  An existing machine-managed run index may synchronize; all notebook bytes are preserved.
  Existing differing instructions are preserved byte-for-byte; refresh creates no backups.
  To update existing guidance, render a scaffold in a separate temporary external root
  and explicitly merge desired changes.

Existing-project main-report migration:
  Checkpoint the project first, then render a fresh scaffold
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
  --no-git         Decline the git bootstrap on a non-repository root. The
                   decline is recorded, and the status/current traceability
                   surface reports the code-revision clause as unanswerable
                   on every reconnect — the opt-out is never silent.
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
