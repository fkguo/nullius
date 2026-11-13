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
- Advance the current question: read the necessary originals, derive or compute,
  use bounded delegation where useful, verify the claims the answer depends on,
  then deliver the requested answer and its limits. Use the existing plan; a
  bounded question needs neither a new recipe nor a formal team cycle by default.

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

## Verification boundaries

- Apply the result-specific checks in the linked verification guidance before
  a result supports dependent work or a durable conclusion.
  Use `review-swarm` for applicable independent review and `research-team` when
  the project adopts its formal independent-member milestone and convergence
  workflow. Keep model-family, method and input independence separate.
- Missing, partial, unavailable or stale evidence stays unverified. A checklist,
  link, hash or successful process is not scientific acceptance. Apply the same
  requirements in engine and file mode; complete the current full-text notebook
  review and unscoped `nullius notebook check --json` before scientific closeout
  or a formal research handoff of adopted results. Saving unfinished work does
  not mark it complete, register it as current, or authorize downstream reliance.
- Completing a scoped answer is distinct from adopting project conclusions,
  registering results, promoting a main report or closing a milestone. The
  latter operations retain their full acceptance requirements, whatever the
  task is called. Scope limits never waive verification of load-bearing claims.

## Detailed instructions by operation

Read only the section relevant to the operation.

| Operation | Required project guidance |
| --- | --- |
| Start or continue a research question | [Research workflow](research_guidance.md#research-workflow "nullius-guidance") |
| A result appears, is displayed, folded or closed | [Verification triggers and result records](research_guidance.md#quick-rules "nullius-guidance") |
| Save unfinished work for another session | [Continuation checkpoints](research_guidance.md#continuation-checkpoints "nullius-guidance") |
| Write scientific explanations or literature notes | [Scientific writing and reading depth](research_guidance.md#scientific-writing-discipline "nullius-guidance") and [literature notes](research_guidance.md#literature-note-quality-and-reading-depth "nullius-guidance") |
| Repair recovery state or choose file/engine mode | [Session protocol](research_guidance.md#nullius-session-start-protocol "nullius-guidance") and [execution modes](research_guidance.md#execution-mode-engine-vs-file "nullius-guidance") |
| Write Markdown or choose host layers | [Formatting](research_guidance.md#markdown-and-links "nullius-guidance") and [host layers](research_guidance.md#optional-host-layers "nullius-guidance") |

Before project final conclusions, milestone closeout or a formal research handoff of adopted results, walk `research-integrity`
M1–M7 and follow the result-folding guidance above. Never replace existing custom
instructions with a generated template; compare a separately generated scaffold
and merge the applicable changes.
