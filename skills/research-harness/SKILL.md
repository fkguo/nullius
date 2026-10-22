---
name: research-harness
description: Recover and continue an external Nullius research project, route its current task, maintain durable checkpoints, and close results through existing evidence gates. Use for reconnects, approvals, full-text notebook review, compute readiness and checkpointed jobs, result provenance/storage, optional reproduction, production-launch preflight and handoff.
---

# Research Harness

Use the external project as authority. `nullius` owns lifecycle, approvals and
state; the host owns its agent loop, tools and session compaction. This skill
routes work and records results, rather than replacing either runtime.

## Recover the current task

1. Work in the external project root. If `.nullius/HARNESS` exists, first obtain
   `./.nullius/bin/nullius status --json`; use `nullius status --json` if the local
   launcher is unavailable. A missing/broken handshake or launcher is repaired
   with `nullius init --runtime-only`, followed by the local status call.
2. Stop on a status error or failed machine gate. Carry out a reported repair
   and continue; advisory warnings become recorded work, not automatic blocks.
   If any A1-A5 approval is pending, stop at that boundary. Silence is not approval.
3. Read `research_plan.md#Current Status`, then use `project_index.md` to locate
   the current adopted result and the original files relevant to this task.
   Read applicable charter/contract constraints and relevant notebook sections.
   Reacquire complete source whenever a claim or verification depends on it.
4. Before restart, context reset or handoff, save required inputs, choices,
   failures, unknowns, next action and acceptance command in durable project
   material. Process-local stores are not checkpoints. A resumed session ID
   does not establish that needed bytes survived.

Read [recovery details](references/recovery.md "nullius-guidance") for anchor
freshness, status classifications, missing state, initialization or migration.
For task-scoped context and phase changes, use
[task briefs and handoff](references/task-context.md "nullius-guidance").

## Route only the work that applies

Ordinary bounded edits stay with the current owner. Use `research-team` for a
research milestone requiring execution and independent verification. Keep
lifecycle/status/approval/export operations on `nullius`; provider MCP tools are
capabilities, not a second project authority. For an unscoped question,
`nullius workflow-plan --recipe research_brainstorm` records planning only.

| Trigger | Required route |
| --- | --- |
| A derived formula, sign, branch, normalization or boundary choice will support later work | `derivation-verify` |
| A computed value will support a durable conclusion or displayed quantity | `numerical-reliability-gate` |
| A citation supports a durable claim; a bibliography is frozen | `claim-grounding`; `citation-triangulation` |
| A source survey is too thin or will support an introduction | `deep-literature-review` |
| A data/results figure or schematic is delivered | `figure-hygiene` or `physics-diagrams` |
| Julia package development or a performance claim | `julia-package`; `julia-perf` where applicable |
| A result-bearing surface needs independent review | `review-swarm` |
| Markdown math, links or note formatting need repair | `markdown-hygiene` |

An unavailable required skill leaves the result unverified. Tooling fixtures and
ordinary code tests do not become scientific results. Review identity, method
and input independence must be assessed separately. Read
[routing details](references/routing.md "nullius-guidance") when deciding the
scope or the required verification for a result.

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
| Fold results, close a milestone, prepare approval, export or hand off | [Closeout and result folding](references/closeout.md "nullius-guidance") |

## Durable conclusions

Engine and file mode owe the same result-specific evidence. Fold verified
reasoning into the human notebook, contract and immutable report with source
pointers. Structural links, status, hashes, receipts and reviewer agreement do
not by themselves prove scientific truth. Closeout requires the current
unscoped notebook structure check and accepted full-text content review;
selected-claim or delta reviews cannot replace it. Keep complete original
material available to verification even when the working context is brief.
Walk `research-integrity` M1–M7 before folding or requesting final approval.
Do not treat missing, partial, failed, unavailable, invalid or stale evidence as
accepted. Read the closeout reference before performing these operations.
