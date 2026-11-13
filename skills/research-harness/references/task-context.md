# Task briefs and continuation checkpoints

Use the host's normal agent loop and compaction. For a task spanning investigation,
implementation or sessions, keep a short authored brief in
`artifacts/runs/<run-id>/task_brief.md`. Small edits need no new ceremony.

Record the question and limits, notation and assumptions, selected source paths
and locators, adopted results with their evidence, unverified candidates, choices
with reasons, unresolved questions, failed approaches and the next action with its
acceptance check. Keep facts separate from proposals. Before implementation, establish the
relevant source behavior and choose an executable bounded plan. At a phase change,
compare the phase's concrete output with its acceptance check; update the brief
before resetting context or handing off. The [optional template](../assets/task_brief_template.md)
is a writing aid, not a heading-based gate.

Select original inputs through `research_plan.md#Current Status` and
`project_index.md`, including applicable charter/contract constraints. Load only
instruction references triggered by the task. This changes context selection,
not verification scope: cited claims still require the original source, and
notebook closeout still requires its complete current full-text review. A summary
is a navigation aid and cannot certify an omitted source or replace a required gate.
No fixed percentage of the host's context window is a universal acceptance limit.

## Preserve work without accepting it

A continuation checkpoint saves enough work to resume investigation; scientific
acceptance adopts a result for downstream use. Saving does not require pretending
that verification is complete. Preserve unfinished derivations, tentative values,
failed checks and pending approvals with their actual status and original files,
including when a gate blocks the next action. Do not mark a milestone complete,
call `nullius result set-current`, or turn a candidate into an accepted premise
merely to save it. Recording a pending check does not discharge that check.

Keep a short pointer and the unresolved next step in Current Status so the next
session can find the brief. In its existing `Evidence pointers` cell, before
the first following heading, use an explicit inline link such as
`[Task brief](artifacts/runs/current-task/task_brief.md)`. Descendant sections such
as Milestone history are not current-task selections.
An existing project can add that link when it needs continuation; no new table is
required. Status exposes that selection in `resume_context.task_brief` and
`recovery_context.task_brief`, with `restore_argv` when usable. Discovery reports
`freshness: unchecked`: it does not read or validate the selected source bytes.
Missing or ambiguous navigation must be resolved from the project record, not
treated as scientific rejection or repaired by guessing a historical run.
The status entry may report that a candidate exists; it must not present that
candidate as an adopted conclusion. A checkpoint may refer to previously accepted
results and their still-current acceptance evidence to restore working context;
recovering that existing state does not itself require a new full-text review.
Newly adopting or revising the project's accepted conclusions, registering or
folding results into that record, or formally delivering or exporting adopted
results still owes the full [closeout requirements](closeout.md), including
result-specific verification and current full-text notebook review. A scoped
answer can finish without declaring project acceptance; all load-bearing claims
in that answer still need their applicable scientific checks. The operation's
content, not its label, determines the boundary. Run-storage rules still protect retained evidence;
never stow live output or make saving wait for scientific acceptance.

## Bind selected bytes

From the external project root, capture explicit project-relative source files
after authoring the brief. The helper requires an absolute `--project-root`;
`pwd -P` supplies it. Do not pass `.` as that argument:

```bash
project_root="$(pwd -P)"
python /path/to/research-harness/scripts/task_brief.py capture \
  --project-root "$project_root" \
  --brief artifacts/runs/current-task/task_brief.md \
  --source research_plan.md --source research_contract.md --source src/relevant-file.py
python /path/to/research-harness/scripts/task_brief.py restore \
  --project-root "$project_root" \
  --brief artifacts/runs/current-task/task_brief.md
```

`capture` adds a JSON metadata comment at the start of the existing UTF-8 Markdown
file; the authored body bytes and file mode are preserved. It never writes sources.
The brief must live under `artifacts/runs/<run-id>/`. Paths are relative, regular
files with no symlink components, traversal, duplicates or self-reference. File
identity also rejects aliases of the brief or an already selected source, including
hard links and case variants on case-insensitive filesystems. Identity is checked
locally, not stored in the portable metadata. Copying a project to another
absolute root preserves a valid relative binding.

`check` and `restore` are read-only. Exit 0 / `fresh` means the body and selected source bytes
match the capture. Exit 1 / `stale` means a changed body/source, missing source or
observed concurrent change; re-read the original, revise the brief and capture
again. Exit 2 / `invalid` means missing/malformed metadata, unsupported version,
invalid path or unreadable input. Invalid evidence cannot pass. An existing valid
capture may be refreshed; malformed metadata requires explicit human inspection
rather than silent replacement. Ordinary HTML comments in the body are allowed;
the opening `<!-- nullius-task-brief` prefix is reserved.

Use `restore` when continuing: it performs the same freshness and file-identity
checks and returns the authored body, recorded source references and changes.
Its `scope: continuity_only` and `scientific_acceptance: not_assessed` fields distinguish
that read from result acceptance. Use `check` when only freshness is needed;
running both consecutively is unnecessary. Stale material remains history to
reconcile against originals, not a current source of truth.

Freshness covers only explicitly selected files at a point in time. It proves
neither complete source selection nor factual accuracy, approvals, reproducibility
or scientific acceptance. Changed files after a check need another check. This is
not an OS sandbox or protection against a hostile same-account writer. Required
verification remains on complete original material and its existing gates.

## Resume from durable material

Before reset, persist a runnable next action, its inputs and actual result paths.
Record unavailable checks honestly. Process-local variables, tool memory and a
session handle do not guarantee that any bytes survived. On resume, restore status,
check the brief's binding, resolve changes against originals, and recover the
scientific question and next step rather than repeating completed work. Reuse
evidence only while its inputs and required acceptance remain current. Continue
only when the task's required evidence and authorization are present; a fresh
checkpoint cannot override a failed gate or pending approval. Source pointers must remain usable;
never turn a missing source into a successful summary-based review.
