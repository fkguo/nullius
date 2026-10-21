# project-contracts

Generic scaffold/contracts package for nullius project scaffolds, contract refresh, and project-root/output policy checks.

This package is intentionally narrow:

- one source of truth for scaffold template inventory and rendering,
- one source of truth for `research_notebook.md` -> `research_contract.md` sync,
- one source of truth for immutable main-report registration and structural validation,
- one source of truth for `real_project` root/output policy plus the lower-level internal maintainer-fixture guardrail.

Refresh mode (`ensure_project_scaffold(..., refresh=True)`, surfaced as `nullius init --refresh`) generates missing support guidance and preserves differing existing `AGENTS.md` bytes and mode. Render a scaffold in a temporary external root and merge changes explicitly to update existing instructions. The scaffold helper never writes the user-owned seed files (`research_plan.md`, `research_notebook.md`, `research_contract.md`, `project_charter.md`, `project_index.md`, `reports/main_research_report_template.md`, `.gitignore`). The public CLI may separately synchronize existing machine-managed notebook and index blocks, preserving user-owned content and not inserting missing blocks.

For the notebook-review guidance update, follow [updating existing project guidance](../../docs/QUICKSTART.md#updating-existing-project-guidance). Render the current template separately, compare the notebook-review paragraphs, and merge only the intended changes; preserve existing project and host instructions.

`nullius report-validate` delegates to this package. It checks the current-report
entry, immutable registered hashes, supersession relations, report structure,
human-readable evidence links, authoring-process leakage, and validation
classification. Implementation, input, and environment relations remain separate
fields; same implementation plus same input is replay regardless of environment
and cannot count as independent validation. Scientific sufficiency remains a
reviewer judgment rather than a structural check.

Report metadata, section fields, validation records, current pointers, and
registry rows count only as visible Markdown. Fenced code and ordinary HTML
comments cannot satisfy the contract; standard standalone marker comments only
delimit the authoritative regions. Every required report field occurs exactly
once in its assigned section.

For an existing project created before the main-report contract, `nullius init
--refresh` generates only missing support guidance and does not migrate the user-owned
`project_index.md` or report template. Checkpoint the project, render a current
scaffold in a separate temporary external root with `nullius init --project-root
<temporary-root>`, copy only a missing
`reports/main_research_report_template.md`, and manually merge the temporary
`project_index.md#Main research report` section and empty registry into the
existing index. Never overwrite an existing template or index. Before that merge,
`nullius report-validate` fails closed with `invalid_registry_markers`; after the
empty registry is present it continues to fail with `no_current_report` until a
complete report is registered and selected.

Implementation language is incidental here: scaffold authority lives on the checked-in contracts/templates this package ships, not on a separate Python-branded front door.

Retired provider packages should not regain project-scaffold authority.

All newly generated managed project runs use `artifacts/runs/<run_id>/`; team and draft executor payloads live in `research_team/` beneath that run. Origin stamps bind the parent run. Historical `team/runs/<run_id>/` remains read-only evidence: status, run listing, index links and export retain its original location, stamps, validity rulings and result references. Reads do not migrate or rewrite it, and `init --runtime-only` reconnects without moving evidence. Unreadable historical locations are reported as unavailable without blocking unrelated readable runs. Duplicate IDs are reported as ambiguous; bare-ID reads refuse ambiguity, and new execution cannot reuse any historical ID. Stamping, backfill, staging, execution and resume cannot write historical run payloads. Use a distinct ID under `artifacts/runs/` for new work. The `inventory_run_relocation.py --fixture-root <anonymous-fixture> --source-manifest <hash-manifest>` helper only inventories pinned fixture bytes, references, collisions and unresolved bindings; it has no apply mode. Independent reviewer snapshots omit every run's executor payload and all workspace trees, retain production artifacts, and allow only each member's own declared output prefix. Historical reports/adjudications remain coordinator evidence. `team/LATEST*.md` and `artifacts/LATEST.md` are navigation pointers.

The generic scaffold creates `project_index.md`; the team helper updates only executor-local latest pointers and requires `nullius init` when the root index is missing. Selected-result and derived-block writers share a short path lock, reread their inputs, and make at most three attempts when edits are detected while preserving human bytes, mode and EOL outside their marked region. Arbitrary writers that ignore the lock remain outside its guarantee. Generic run counts do not interpret execution round limits; the Python executor resolver and suffix gate own those settings.
