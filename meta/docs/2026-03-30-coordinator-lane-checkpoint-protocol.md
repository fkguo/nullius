# Coordinator-Lane Checkpoint Protocol

> **Date**: 2026-03-30
> **Status**: Active operating protocol
> **Scope**: Root `main` coordinator thread ↔ implementation lane collaboration
> **Document role**: Operational workflow and packet contract. Root normative hard rules remain in `AGENTS.md`.

## Why This Exists

The previous lane workflow optimized for traceability, but still forced the human coordinator to relay many intermediate messages that did not require substantive judgment. In practice, the human wants to review:

- the real implementation plan
- authority / framework / process-boundary decisions
- out-of-scope boundaries
- rare blocker exceptions
- version-control and merge decisions

The human does **not** want to spend attention on routine status normalization, ordinary rerun decisions, or the difference between "dirty but converged" and "committed and merge-ready".

This protocol narrows lane ↔ coordinator interaction to a small set of checkpoints while keeping the workflow auditable.

## Preferred Execution Mode

When the tooling path is available and the human has approved the plan, the preferred execution mode is:

- coordinator thread drafts the lane plan
- human reviews and approves the plan
- coordinator launches a sub-agent / worker for that lane
- the sub-agent executes autonomously until the next required checkpoint

Manually relayed external lane chats remain a fallback path, not the preferred default.

## Protocol Summary

Each lane should follow this default state machine:

1. `LAUNCH`
2. `PLAN_PACKET`
3. `PLAN_APPROVED`
4. `EXECUTE`
5. `VERIFY`
6. `REVIEW`
7. `SYNC`
8. `STATUS_NORMALIZE`
9. one of:
   - `BLOCKER_DECISION_NEEDED`
   - `VERSION_CONTROL_AUTHORIZATION_NEEDED`
   - `MERGE_DECISION_NEEDED`
   - back to `EXECUTE` when a bounded in-lane fix is required

The lane should not return to the coordinator for routine bookkeeping between `PLAN_APPROVED` and the next real checkpoint.

## Plan First, Then Spawn

For sub-agent-driven lanes, the coordinator should not start the worker first and negotiate the real scope later. The required order is:

1. draft the substantive lane plan in the coordinator thread
2. present that plan for human review
3. revise/narrow if needed
4. obtain explicit human approval
5. only then launch the sub-agent / worker against the approved plan

This keeps the human review focused on the real implementation content rather than on post hoc summaries from an already-running lane.

## Where The Plan Should Live

Not every plan needs the same persistence level.

### Checked-in canonical prompt under `meta/docs/prompts/`

Use a checked-in prompt doc by default when the lane is a real implementation lane and any of the following is true:

- it touches multiple packages
- it touches governance, workflow, or process boundaries
- it touches public/front-door surface
- it is likely to require later rereview, rebase, or reuse
- it carries important out-of-scope or authority-boundary constraints that should remain auditable

In those cases, the approved plan should usually be written as a canonical `meta/docs/prompts/prompt-*.md` artifact before launching the sub-agent.

### Planning-only document under `meta/docs/plans/`

Use `meta/docs/plans/*.md` when the artifact is primarily:

- lane sequencing
- queueing / parallelization strategy
- worktree ownership planning
- launch-order planning

These documents help coordinate future work but are not themselves the implementation charter for a single lane.

### Coordinator-thread-only `plan_packet`

Only use a non-checked-in plan packet when the work is extremely small, bounded, and disposable, such as:

- a narrow hotfix
- a tiny one-package repair
- no governance/process boundary change
- no expectation of later reuse as a durable implementation authority

If the work stops being tiny or starts accumulating durable scope assumptions, promote the plan into a checked-in prompt before continuing.

## What The Coordinator Reviews

The coordinator's substantive review should focus on:

- the proposed implementation slice
- why the slice is the smallest truthful next deliverable
- authority boundaries
- framework / process implications
- touched package boundaries
- acceptance and formal review coverage
- out-of-scope and defer/decline reasoning

The coordinator should **not** need to re-evaluate routine internal lane bookkeeping such as:

- status label normalization
- whether a same-model rerun is the normal next step
- whether an unchanged uncommitted diff is not yet `merge_ready`
- whether a clean conflict-free rebase allows review carry-forward under current repo rules

Those judgments should be made inside the lane and only surfaced as part of a checkpoint packet.

## Required Checkpoints

Only the following four checkpoint types should normally reach the coordinator.

### 1. `plan approval needed`

This is the default first return from a new implementation lane.

The lane should provide a substantive `plan_packet` that includes at least:

- `lane`, `branch`, `worktree`, `head`, `target_main`
- `goal`
- `why_now`
- `smallest_truthful_deliverable`
- `authority_before`
- `intended_authority_after`
- `touched_surfaces`
- `out_of_scope`
- `acceptance_plan`
- `review_plan`
- `risks`
- `report_back`

If the lane is substantial enough for a checked-in implementation charter, the `plan_packet` should point to that checked-in prompt as the execution authority that the sub-agent will follow after approval.

The coordinator should approve, reject, or narrow the plan. Once approved, the lane should continue autonomously.

### 2. `blocker decision needed`

This checkpoint is only for cases where the lane cannot safely continue without a substantive human decision, for example:

- reviewer fallback / exception authorization
- architecture ambiguity with non-obvious consequences
- unexpected overlapping user changes that affect the same scope
- scope expansion that would change the lane charter

Routine reruns, packet reshaping, or ordinary rebase judgments are not blocker checkpoints unless repo policy truly requires human approval.

### 3. `version control authorization needed`

This is the checkpoint reached after the lane has:

- finished implementation
- passed acceptance
- passed formal review / self-review as required
- synced tracker / `REDESIGN_PLAN.md` / related governance files
- normalized status against the actual git state

If the payload is still an uncommitted worktree diff, the lane should report:

- `status: done_pending_version_control_authorization`

If the lane is waiting on commit authorization, it should **not** report `merge_ready`.

### 4. `merge decision needed`

This is the checkpoint reached only after the accepted payload is committed and the lane is actually merge-candidate material.

The lane should only report:

- `status: merge_ready`

when the payload is committed, the worktree is clean, and the applicable review / rebase / acceptance gates for that committed head are satisfied.

## Sub-Agent Responsibilities After Approval

Once the approved plan exists and the sub-agent is launched, the sub-agent should handle the rest of the routine lane flow without unnecessary coordinator interrupts:

- implementation
- acceptance execution
- formal review execution and routine same-model reruns
- self-review
- tracker / `REDESIGN_PLAN.md` / related governance sync
- status normalization against actual git state
- ordinary rebase / carry-forward judgment under current repo policy

The sub-agent should only surface back to the coordinator when one of the required checkpoints is reached.

## Status Normalization Rules

The lane should normalize status from actual repository state rather than self-reported optimism.

### `in_progress`

Use when the lane is still actively implementing, verifying, reviewing, or performing bounded in-lane follow-up.

### `blocked`

Use when the lane cannot safely proceed without a human decision or an unavailable external prerequisite.

### `done_pending_version_control_authorization`

Use when:

- the bounded implementation is substantively accepted inside the lane
- acceptance and required reviews are complete
- no further implementation changes are needed
- the payload is still not committed because version-control authorization is pending

### `merge_ready`

Use only when:

- the payload is already committed
- the worktree is clean
- the target/main alignment and review validity have been checked for that committed head
- no further human decision is needed other than merge

## Copy-Paste UX Rule

When a coordinator needs to send instructions to a lane, the output should be one single forwardable fenced code block. Do not split the task, checklist, and `report_back` template across multiple separate snippets unless the human explicitly asks for that.

## Relationship To Other Governance

- `AGENTS.md` remains the root SSOT for stable coordinator/lane hard rules.
- This document is the fuller operating protocol for how to apply those rules in day-to-day work.
- Lane-specific execution details should continue to live in checked-in canonical prompts under `meta/docs/prompts/` when a lane needs a durable implementation charter.

## Intended Next Automation Boundary

Automation should target the checkpoints above rather than raw message templating.

The most useful automation surfaces are:

- generate the initial lane launch packet
- validate that a lane returned a proper `plan_packet`
- ingest checkpoint packets and normalize status from git/review facts
- emit a single coordinator decision packet for the next checkpoint

The goal is not to remove the coordinator's substantive judgment. The goal is to remove unnecessary relay traffic between those judgments.
