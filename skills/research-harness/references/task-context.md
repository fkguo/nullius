# Task briefs and phase handoff

Use the host's normal agent loop and compaction. For a task spanning investigation,
implementation or sessions, keep a short authored brief in
`artifacts/runs/<run-id>/task_brief.md`. Small edits need no new ceremony.

Record the question and limits, selected source paths and locators, observed facts,
choices with reasons, unresolved questions, failures, next action and its acceptance
check. Keep facts separate from proposals. Before implementation, establish the
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
python /path/to/research-harness/scripts/task_brief.py check \
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

`check` is read-only. Exit 0 / `fresh` means the body and selected source bytes
match the capture. Exit 1 / `stale` means a changed body/source, missing source or
observed concurrent change; re-read the original, revise the brief and capture
again. Exit 2 / `invalid` means missing/malformed metadata, unsupported version,
invalid path or unreadable input. Invalid evidence cannot pass. An existing valid
capture may be refreshed; malformed metadata requires explicit human inspection
rather than silent replacement. Ordinary HTML comments in the body are allowed;
the opening `<!-- nullius-task-brief` prefix is reserved.

Freshness covers only explicitly selected files at a point in time. It proves
neither complete source selection nor factual accuracy, approvals, reproducibility
or scientific acceptance. Changed files after a check need another check. This is
not an OS sandbox or protection against a hostile same-account writer. Required
verification remains on complete original material and its existing gates.

## Resume from durable material

Before reset, persist a runnable next action, its inputs and actual result paths.
Record unavailable checks honestly. Process-local variables, tool memory and a
session handle do not guarantee that any bytes survived. On resume, restore status,
check the brief's binding, resolve changes against originals, and continue only
when the task's required evidence is present. Source pointers must remain usable;
never turn a missing source into a successful summary-based review.
