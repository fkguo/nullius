# Recovery First

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

## Recovery First

Work from the external project root, not from the `nullius` development repo.

1. If `.nullius/HARNESS` exists, treat it as the machine-readable runtime handshake: a status receipt is required before new work, milestone execution, closeout, or handoff.
2. Prefer the project-local CLI when it exists:
   ```bash
   ./.nullius/bin/nullius status --json
   ```
3. Otherwise use the installed CLI:
   ```bash
   nullius status --json
   ```

Session continuation restores only what the host durably recorded. Before a
handoff or restart, put required inputs, intermediate results and the next action
in project files or run evidence. Process-local tool variables and in-memory
stores are not checkpoints; a session ID or a successful resume cannot establish
that those values survived. Verify the needed bytes from durable material after
reconnecting, and report missing state rather than reconstructing it as fact.

A successful `status --json` call also refreshes the session-level anchor
marker at `.nullius/HARNESS_INVOCATION`. Every `*-mcp` dispatcher
(`arxiv-mcp`, `hep-mcp`, `hepdata-mcp`, `idea-mcp`, `openalex-mcp`,
`pdg-mcp`, `zotero-mcp`) verifies this marker for state-touching tool
calls and fails closed with `HARNESS_INVOCATION_REQUIRED` when the marker
is missing, malformed, or older than the most recent change to
`.nullius/state.json` or `.nullius/ledger.jsonl`. The check is
**event-driven, not clock-based**: once you anchor against current
project state, the anchor stays valid until project state actually
changes — long thinking / reading between tool calls does not invalidate
the anchor. Re-run `status --json` after any lifecycle event (own or
other-process `nullius run`/`approve`/`verify`/...) to re-anchor;
you do not need to invoke a separate "anchor" command. The same
event-driven economy applies to routine health re-verification inside a
review or work cycle, scoped to what the receipt actually witnessed: a
status receipt binds the state/ledger identities it was computed from, so
checks whose only inputs are `.nullius/state.json` and
`.nullius/ledger.jsonl` may cite the receipt while those files are
unchanged. Launcher and sentinel health have inputs outside that pair —
re-check them when their own identities (launcher target, sentinel
content) differ or cannot be established, and whenever any relevant
identity is unknown, re-run the full check rather than citing the
receipt. A re-check is owed on state change, never on cadence.

**What in a status receipt stops work, what asks for a repair, and what
is only advisory.** Three classes, machine-readable so nothing has to be
inferred from prose:

- **Stop and surface**: a non-null error field (for example
  `final_conclusions_error`, `project_surface_drift_error`) or a failed
  machine gate (a gate script exiting non-zero in the run evidence).
  These mean the receipt or a gate could not do its job.
- **Repair, then continue**: an invalid `HARNESS` sentinel or an
  unhealthy project-local launcher — authoritative surfaces
  `recovery_context.control_files.harness.valid` and
  `recovery_context.control_files.project_local_launcher.healthy`,
  echoed in the warning array with `severity: "repair"` and the exact
  `repair_command` (typically `nullius init --runtime-only`). The
  repair is cheap and self-contained: run it and keep going — neither
  condition is a reason to abandon the task or escalate.
- **Advisory**: every other entry under
  `recovery_context.derivation_warnings` and all of
  `project_surface_drift.issues`, marked `severity: "advisory"` —
  recoverable observations about auxiliary or derived state (missing
  optional manifests, plan-focus fallbacks, aging uncommitted work).
  Record them in the run evidence and keep working; treating an
  advisory-only receipt as a blocker halts real work over conditions the
  receipt itself classifies as non-blocking. A warning worth acting on
  becomes a task on the plan, not a reason to stop the current one.

The check is also skipped for:

- pure read-only provider queries (`arxiv_search`, `openalex_get`,
  `pdg_find_particle`, `inspire_resolve_citekey`, `hep_health`, etc.;
  full classification per dispatcher in each `*-mcp` package's
  `state-touch-classification.ts`);
- standalone use where `process.cwd()` has no `.nullius/`
  directory (no lifecycle context to drift from);
- `process.cwd()` being the home directory, which is never a project root
  (the CLI's project-root search skips it too; `~/.nullius/` there holds
  user-level data such as the agent roster);
- `NULLIUS_HARNESS_VERIFY=skip` env override (escape hatch) and
  `NODE_ENV=test` default.
4. If `.nullius/` exists but `.nullius/HARNESS` is missing, or if both entrypoints are unavailable, repair only the runtime handshake and launcher, then retry the project-local CLI:
   ```bash
   nullius init --runtime-only
   ./.nullius/bin/nullius status --json
   ```
   If `nullius` is not on `PATH`, run the same one-time repair through your nullius checkout (substitute its absolute path):
   ```bash
   node /absolute/path/to/nullius/packages/orchestrator/dist/cli.js init --runtime-only
   ```
5. Read and align the durable project surfaces:
   - `research_plan.md`, especially `# Current Status`
   - `research_contract.md`
   - `research_notebook.md`: read the human sections as well as the automatic table; inspect `traceability.notebook.result_links` for navigation gaps and `traceability.notebook.content_review` for full-text review identity, coverage and current acceptance; missing acceptance does not prevent ordinary recovery reads
   - the relevant `artifacts/runs/<run_id>/` and `artifacts/runs/` directories
   - the current main research report linked from
     `project_index.md#Main research report`, when one is promoted

**Anchor on the final adopted version — never build on a superseded one.** A long project accumulates earlier fits, methods, grids, and exploratory scripts; a *newer* adopted result (a better minimum, a more robust method, a finer grid) can silently coexist in the repo with the deprecated ones it replaced. Where the project has a nullius launcher, the machine-readable answer comes first: `nullius current` renders the results registry (which result rows are current, produced by which run at which commit) and the validity ledger (which runs are still active, which are superseded or voided and why) — consult it before any manual archaeology, and keep it authoritative by recording supersessions there when you replace a run. Where that surface is absent or silent on the question, resolve from the durable record (`research_plan.md#Current Status`, `research_contract.md`, the latest dated `artifacts/runs/<run_id>/`, and any explicit `superseded` / `voided` markers) **which** parameters, method, and configuration are the *current adopted* version — not the first script you happen to open or the most-cited earlier draft. Then **regression-anchor**: run that adopted reference configuration and assert it reproduces its known result (the published χ²/value/pole) *before* trusting any variation built on it. This is the project-state half of the [`numerical-reliability-gate`](../../numerical-reliability-gate/SKILL.md) G4 anchor; skipping it is how work silently gets rebuilt on a stale fit or a retired method.

Use `nullius init --refresh` to generate missing `AGENTS.md` support guidance (preview with `--dry-run`). Scaffold refresh preserves differing instructions and user-owned seed content (`research_plan.md`, `research_notebook.md`, `research_contract.md`, `project_charter.md`, `project_index.md`, `reports/main_research_report_template.md`, `.gitignore`). The CLI may still synchronize existing machine-managed blocks in the notebook and project index; it does not insert missing blocks during refresh. Template changes do not automatically update existing projects. For updated guidance, render a scaffold in an anonymous temporary external root and manually merge the desired changes, including notebook review instructions, into existing user-owned files.

For an existing project that predates the main-report registry, checkpoint the
project before migration. Render the current scaffold in a separate temporary
external root with `nullius init --project-root <temporary-root>`. Copy only a
missing `reports/main_research_report_template.md`; never overwrite an existing
copy. Manually merge the temporary `project_index.md#Main research report`
section and empty registry into the existing user-owned index. Refresh does not
perform those steps. `nullius report-validate` fails closed with
`invalid_registry_markers` before the registry exists and with
`no_current_report` until a complete current report is registered.

If no project state exists and the user is in a real external research root, initialize with:

```bash
nullius init
```

If `nullius` is unavailable on `PATH`, run the same one-time setup through your
nullius checkout (substitute its absolute path) to create the project-local fallback:

```bash
node /absolute/path/to/nullius/packages/orchestrator/dist/cli.js init --runtime-only
```
