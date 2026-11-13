---
name: research-harness
description: Lead research in an external Nullius project through source reading, analysis, delegation, verification and delivery. Use for research tasks, reconnects, checkpoints and formal closeout.
---

# Research Harness

Use the external project as authority. `nullius` owns lifecycle, approvals and
state; the host owns its agent loop, tools and compaction.

## Own the research

The primary agent retains the scientific judgment and central analysis. Use the
host's native reasoning, tools and subagents; isolated runners serve scoped tasks.
Delegate when it adds independent evidence or useful parallelism.
Give blind verification its neutral question and original inputs, not the answer
being checked. Keep routine routing and record maintenance with the agent; ask
the user when a scientific choice or authorization boundary actually needs them.
Report findings, uncertainty and the next step.

## Advance the current question

1. Recover the project; identify the question, requested output and scope. Use
   the existing plan. A bounded question needs no new recipe or team cycle.
2. Resolve the next important uncertainty through original-source reading,
   derivation, computation or a diagnostic. Use available host tools and existing
   Nullius capabilities. Survey literature when the question requires it.
3. Delegate useful parallel work or independent checks with a question, original
   inputs, expected output and stopping condition; integrate the findings yourself.
   Calling a subagent does not by itself require adopting the formal `research-team` cycle.
4. Inspect actual outputs, reconcile disagreement and verify load-bearing results.
   Fix the cause of a failed check or change approach; repeating review of
   unchanged material is not progress.
5. Deliver the answer with reasoning, evidence, checks and limits. Separate gaps
   preventing this answer from work needed only for a stronger claim. Preserve a
   concrete next action and reuse still-current evidence when continuing.

Completing a scoped answer is distinct from project acceptance. Adopting project
conclusions, registering or folding results into the accepted record, promoting a
main report or closing a milestone still requires [closeout](references/closeout.md "nullius-guidance"),
regardless of the task's size or name. Scope never waives checks of load-bearing claims.

## Recover the current task

1. Work in the external project root. If `.nullius/HARNESS` exists, first obtain
   `./.nullius/bin/nullius status --json`; use `nullius status --json` if the local
   launcher is unavailable. A missing/broken handshake or launcher is repaired
   with `nullius init --runtime-only`, followed by the local status call.
2. Stop on a status error or failed machine gate. Carry out a reported repair
   and continue; advisory warnings become recorded work, not automatic blocks.
   If any A1-A5 approval is pending, stop at that boundary. Silence is not approval.
3. Read `research_plan.md#Current Status`; use `project_index.md` for the current
   adopted result and relevant originals. Read applicable charter/contract and
   notebook sections. Obtain complete source wherever verification requires it.
4. Before restart or handoff, save required inputs, choices, failures, unknowns,
   next action and acceptance command. Process-local stores are not checkpoints.
   A continuation checkpoint may preserve explicitly unverified work even when
   a gate or approval is pending; saving neither accepts results nor clears it.

Read [recovery details](references/recovery.md "nullius-guidance") for missing state
or migration; for context and phase changes, use
[task briefs and continuation](references/task-context.md "nullius-guidance").

## Route only the work that applies

Use `research-team` when the project adopts its formal independent-member milestone
and convergence workflow. Keep lifecycle/status/approval/export on `nullius`;
provider MCPs supply capabilities. `nullius workflow-plan --recipe research_brainstorm`
records planning when needed; it is not required for every question.
Check a load-bearing result before dependent work relies on it; do not defer
verification until an expensive downstream calculation or final writeup.

Use the [result-specific routes](references/routing.md "nullius-guidance") when a
formula, number, citation, figure or code result needs verification.
Skills specify checks; the host supplies execution. When a skill is not installed
but its requirements are readable, available capabilities may perform the same
checks and retain their evidence. Unknown requirements or unavailable checks leave
results unverified. Required executable gates, evidence formats and approvals
cannot be replaced by a declaration of equivalence. Do not claim an unavailable
tool ran. Assess model, method and input independence separately.

## Load operational detail when triggered

| Current operation | Read before that operation |
| --- | --- |
| New/rebuilt environment, first real launch or a kill-prone job | [Readiness and checkpointed computation](references/compute-readiness.md "nullius-guidance") |
| Freeze inputs, append outputs, or set resource ceilings | [Run-record boundaries](references/run-records.md "nullius-guidance") |
| Adopt, replace, void or locate a result | [Current-result traceability](references/result-traceability.md "nullius-guidance") |
| Finished outputs need storage classification or a commit check | [Run storage](references/run-storage-workflow.md "nullius-guidance") |
| The project opts into a fresh-state reproduction | [Independent reproduction](references/reproduction-workflow.md "nullius-guidance") |
| Authorize a production computation under the adopted A3 preflight | [Production launch authorization](references/production-launch-workflow.md "nullius-guidance") |
| Scientific literature discovery and source admission | [Literature workflow](references/literature-workflow.md "nullius-guidance") |
| Save unfinished work for continuation | [Task briefs and checkpoints](references/task-context.md "nullius-guidance") |
| Fold results, close a milestone, prepare approval, export or hand off adopted results | [Closeout and result folding](references/closeout.md "nullius-guidance") |

## Durable conclusions

Engine and file mode owe the same evidence and acceptance requirements. Fold
verified reasoning into the notebook, contract and immutable report with sources.
Links, hashes, receipts and reviewer agreement do not prove scientific truth.
Closeout requires the current
unscoped notebook structure check and accepted full-text content review;
selected-claim or delta reviews cannot replace it. Keep complete original
material available to verification even when the working context is brief.
Walk `research-integrity` M1–M7 before folding or requesting final approval.
Missing, partial, failed, unavailable, invalid or stale evidence is not accepted.
