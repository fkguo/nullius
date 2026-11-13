# AGENTS.md

Keep project-specific scientific conventions and authorization boundaries.

## Lead the research

- The primary agent retains the scientific judgment: develop the central
  argument, choose useful computations and checks, and reconcile evidence.
  Use the current host's native reasoning and tools. Delegate bounded work
  when it adds independent evidence or useful parallelism; isolated runners
  remain tools for scoped execution and review, not a second research authority.
- Handle routine routing, recovery and records. Report findings, uncertainty
  and the next scientific step; ask the user only for scientific choices or
  authorization requiring their decision.

## Recover and select context

- Work from this external project root. If `.nullius/HARNESS` exists, obtain
  `./.nullius/bin/nullius status --json` before new work, reconnect, recovery,
  context reset, milestone start or closeout; use `nullius status --json` if the
  local launcher is unavailable. Repair a missing/broken runtime with
  `nullius init --runtime-only`, then retry the local status call.
- Use the host's `research-harness` skill when available. `nullius` is the
  lifecycle/state authority; provider tools and optional host layers are
  capabilities, not replacement authorities. Stop on a status error or failed
  machine gate; perform reported repairs and record advisory work. If any A1-A5
  approval is pending, stop at that boundary. Silence never grants approval.
- Start with [Current Status](research_plan.md#current-status) and use
  [project_index.md](project_index.md) for navigation. Read applicable
  [charter constraints](project_charter.md), [contract](research_contract.md)
  sections and the notebook/source material relevant to the current question.
  Acquire complete original material wherever verification requires it.
- Treat a task brief as a working view of those sources. Keep facts with source
  locators separate from proposed choices, unknowns and the next action. Save
  necessary inputs and intermediate results in project files before a phase
  change or restart; temporary tool variables are not durable checkpoints.
  A continuation checkpoint may save explicitly unverified work while a gate
  or approval is pending; it cannot accept results or clear that boundary.
- Ordinary bounded work stays with its owner. For complex tasks, separate
  investigation, choices and executable steps with observable outputs and
  acceptance checks. Authorized subagents return concise findings and source locators.

## Verification boundaries

- Apply result-specific verification before a result supports dependent work
  or a durable conclusion: `derivation-verify` for formulas; `numerical-reliability-gate` for
  computed values; `claim-grounding` and `citation-triangulation` for claims and
  references; `figure-hygiene`/`physics-diagrams` for displayed material;
  `julia-package`/`julia-perf` for the corresponding package/performance work.
  Use `research-team` and `review-swarm` for milestone execution and independent
  review. Keep model-family, method and input independence separate.
- Missing, partial, unavailable or stale evidence stays unverified. A checklist,
  link, hash or successful process is not scientific acceptance. Apply the same
  requirements in engine and file mode; complete the current full-text notebook
  review and unscoped `nullius notebook check --json` before scientific closeout
  or a formal research handoff of adopted results. Saving unfinished work does
  not mark it complete, register it as current, or authorize downstream reliance.
- Keep scientific reasoning in [research_notebook.md](research_notebook.md),
  machine-facing assumptions/evidence in [research_contract.md](research_contract.md),
  concise status and next actions in [research_plan.md](research_plan.md), and
  run evidence under `artifacts/runs/<run_id>/`. Main reports are immutable and
  registered through `project_index.md#Main research report`.

## Detailed instructions by operation

Read only the section relevant to the operation.

| Operation | Required project guidance |
| --- | --- |
| A result appears, is displayed, folded or closed | [Verification triggers and result records](research_guidance.md#quick-rules "nullius-guidance") |
| Save unfinished work for another session | [Continuation checkpoints](research_guidance.md#continuation-checkpoints "nullius-guidance") |
| Write scientific explanations or literature notes | [Scientific writing and reading depth](research_guidance.md#scientific-writing-discipline "nullius-guidance") and [literature notes](research_guidance.md#literature-note-quality-and-reading-depth "nullius-guidance") |
| Repair recovery state or choose file/engine mode | [Session protocol](research_guidance.md#nullius-session-start-protocol "nullius-guidance") and [execution modes](research_guidance.md#execution-mode-engine-vs-file "nullius-guidance") |
| Write Markdown or choose host layers | [Formatting](research_guidance.md#markdown-and-links "nullius-guidance") and [host layers](research_guidance.md#optional-host-layers "nullius-guidance") |

Before final conclusions, milestone closeout or a formal research handoff, walk `research-integrity`
M1–M7 and follow the result-folding guidance above. Never replace existing custom
instructions with a generated template; compare a separately generated scaffold
and merge the applicable changes.
