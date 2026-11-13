# Project MCP transport

`@nullius/project-mcp` connects an MCP client to one external Nullius project. It consumes the existing orchestrator tool dispatcher and CLI; lifecycle state, approvals, planning, execution and verification remain owned by `@nullius/orchestrator`. It does not aggregate provider servers or introduce a scheduler.

Build the workspace, then start the server with an explicit project:

```bash
pnpm -r build
NULLIUS_PROJECT_ROOT=/absolute/research/project node /absolute/nullius/packages/project-mcp/dist/index.js
```

The directory must exist, be outside the development checkout, and not be a parent of it. `NULLIUS_CONTROL_DIR` must be unset. The process uses the bound project as its working directory. The [personal plugin builder](../skills-market/docs/PERSONAL_PLUGIN.md) packages the existing skills and configures this server alongside HEP and idea MCP servers. Configure idea storage separately. Other clients may launch the same standard stdio server; their skill/plugin installation formats differ.

## Tools and project advancement

`project_capabilities` reports the connected runtime, limits, local Poppler availability and separate `sampling` / `sampling_tool_calls` support. The public inventory comes from `src/registry.ts` and a restricted view of the canonical orchestrator registry: eight project tools plus 16 selected `orch_*` operations, for 24 tools.

| Entry | Behavior |
| --- | --- |
| `project_capabilities` | Report all advertised tools, source-reading limits, PDF dependencies and host sampling availability. |
| `project_cli` | Typed init, status, current, notebook/index sync, report validation, result registration, run stamping and decision recording through the canonical CLI. No caller-supplied argv. |
| `project_file_read` | Project-relative file bytes, base64 encoded in chunks up to 64 KiB; whole-file SHA-256, size and next offset. Regular files up to 64 MiB. |
| `project_file_search` | Bounded literal UTF-8 search with source hashes, line/column locations, surrounding lines and explicit scanned/skipped/unavailable coverage. |
| `project_text_read` | Read source lines and Unicode columns with source SHA-256 and hash-bound continuation, including continuation within a long line. |
| `project_document_read` | Extract selected PDF pages through local Poppler and optionally return actual PNG image content. Source hash, page coverage and truncation are explicit; no OCR. |
| `project_file_write` | UTF-8 source/input/checker upload up to 1 MiB. `expected_sha256: null` creates a new file; replacing a file requires its current hash. |
| `project_delivery_read` | Read a persistent response for a submitted mutation. |
| Selected `orch_*` | Existing create/status/list, pause/resume/export, approval inspection, policy query, staging, computation, verification, final-conclusion evaluation and sampling-dependent delegation. |

An MCP-only client can initialize a project, upload a method handoff, stage and plan it, execute its manifest, upload and execute a checker, read the actual output, register a result, and refresh project projections. A successful tool response is not proof that a scientific claim is correct. Verification retains the canonical checker contract; A5 remains unavailable with the current incomplete dependency closure.

For source inspection and delegation examples, see the [research tools guide](../../docs/RESEARCH_TOOLS.md). Read-only source tools work without sampling. Search coverage describes a bounded scan; zero matches do not establish absence when that scan is incomplete. Pass the returned `next` object to continue text within a line or PDF text within a page using `start_character`. Its Unicode-character position advances only past the content actually returned, and its expected source hash rejects changed files. PDF extraction reads one regular-file snapshot and passes its bytes through stdin to `pdfinfo`, `pdftotext` and, when requested, `pdftoppm`. Missing programs return `unavailable`; absent extracted text does not establish a blank page. Limits are reported by `project_capabilities`, including at most five PDF pages per call, a 32 MiB source, 100,000 returned text characters and 4 MiB per PNG. Image edge length defaults to 1600 and accepts 256–2400 pixels.

The bound root fills `project_root` when omitted. A supplied root must match. Its filesystem identity is checked before calls, detached execution and response commits; replacing or moving the project requires local reconciliation. Run directories must be `artifacts/runs/<run_id>`. Explicit paths and implicit control metadata reject symlinks and traversal. Unreferenced data, environments and provider caches are not recursively inspected. File uploads protect hidden configuration, journals, generated results/receipts, `research_team_config.json` and managed project projections; use canonical commands for those. Research plan and contract prose remain editable source documents; edits do not grant approval or verify a result. Input/checker uploads are allowed under run `inputs/`, `verification/` (Python/JS source), and `computation/scripts/`, `computation/inputs/`, `computation/manifest.json`. Hash checks coordinate cooperating writers; they are not an OS-level transaction against arbitrary local processes.

For an initialized project, call `project_cli` with `action: "status"` or `orch_run_status` before reading or changing project state, and again after state or ledger changes. These commands refresh the canonical harness anchor. Calls reject a missing, stale or mismatched anchor before new work begins, including detached execution and delegated tool calls. Initial creation is allowed only while the project has no state file. Capabilities, status, delivery polling and exact delivery replays remain available for recovery.

## Long calls and reconnect

Stateful non-sampling tools require a client-generated `delivery_id`. Reuse that ID and identical arguments, including `timeout_seconds`, when reconnecting. `timeout_seconds` defaults to 300 and accepts 1–3600. A detached supervisor runs the canonical call in a child process, so closing the submitting stdio connection does not terminate a submitted local calculation. The supervisor enforces the deadline independently of synchronous computation by terminating that process group; it does not contain independently detached descendants of trusted scripts.

Delivery uses the existing `RunManifestManager` attempt contract under `artifacts/delegated-runs/project-mcp/`. It records transport inputs/responses, not a second research run or queue. A project lock serializes mutations submitted through this adapter, including file uploads. Other local tools retain their own concurrency rules.

| Delivery state | Client action |
| --- | --- |
| `outcome_unknown` | Poll the same ID. It may still be executing. After a crash/deadline, inspect canonical output locally; never retry under a new ID. |
| `finalizing` | The response has committed; poll until the worker releases the project lock. |
| `committed` | Inspect the original MCP `result`, including `isError`, approval requirements and unavailable/failed statuses. This means delivery completed, not research passed. |
| `not_started` | Preparation ended before dispatch. Resubmitting the same ID/input can finish this first dispatch if no lock remains; an actual crash may require local stale-lock reconciliation first. |

A timeout/crash retains the unknown attempt and execution lock. There is no remote “force retry” or “approve” switch. A local operator must establish that all writers have stopped, inspect canonical state and outputs, and reconcile them before removing `.nullius/project_mcp_execution.lock`. An unknown delivery ID remains non-replayable even after local lock removal. Pause/resume tools change canonical project state; they do not pause an already executing process.

Foreground sampling and file uploads can also leave a lock after process termination. Busy errors expose the lock owner, acquisition PID and creation time; these operations have no transport delivery ID to poll. The PID identifies the lock acquirer, not every possible writer, so an exited PID alone does not authorize removal. Local reconciliation is required before resuming a delegated journal or another write.

Responses larger than 64 KiB are transferred by `project_delivery_read` as `base64-json` chunks (`data`, `offset`, `next_offset`, `total_bytes`, `response_sha256`). Concatenate and hash the bytes before decoding the original MCP result envelope. `result_sha256` separately binds the orchestrator journal's normalized response record. Smaller responses are returned directly as `result`.

## Host capabilities and trust

Sampling-dependent delegation runs in the foreground through the client's MCP sampling callback and a bound, restricted tool loopback. It requires a connected host and uses the existing delegated journal for recovery. Missing sampling returns unavailable. Delegation with tools additionally requires the client's `sampling.tools` capability; basic sampling alone is insufficient and returns `unavailable` for such requests. Callers cannot grant team permissions, inject approval interventions, supply arbitrary executable tool definitions, or call operator approval resolvers. Provider tools remain separate servers. The loopback exposes the permitted control-plane tools and read-only project search/text/PDF tools using canonical schemas; delegated reads recheck project identity and the harness anchor. Sampling carries text only: PDF `include_images: true` returns `unavailable` through this bridge rather than dropping the images. A vision-capable host can call the PDF tool directly.

The primary host agent can use its native tools and bounded delegation for the
[research workflow](../../skills/research-harness/SKILL.md#advance-the-current-question).
This MCP delegation transport does not automatically select a formal
`research-team` cycle or supply its independent-member execution evidence.
Projects that adopt that cycle retain its configured gates and supported runner
requirements. Scoped answers retain result-specific verification; result
registration, notebook folding, report promotion and milestone closeout retain
the full project acceptance requirements.

`orch_run_execute_agent` accepts a structured `team.handoff_payload` and per-assignment payloads. Omission inherits the team context, an object overrides it, and `null` clears it. The nested payload is preserved in the delegated transcript and existing task state. `team.max_parallel` defaults to 4 and accepts 1–16 for parallel or stage-gated execution. Queued assignments stay pending without a session until a slot is available; `timeout_at` is checked again before launch. Queue time consumes that absolute deadline, but this setting does not terminate an already-running external operation. Sequential execution remains one assignment at a time, and failed or blocked outcomes do not grant scientific acceptance.

The file API and tool parameters are project-bound. Uploaded methods and checkers execute as trusted code under the local user's account, using existing Nullius runtime checks. This is **not an OS sandbox**; scripts can access resources available to that user. HEP and idea servers retain their own trust and confirmation contracts. A provider URI or external cache path is not automatically readable through this project's file API.

Local SDK integration tests cover real source files and processes, planning/computation/checker execution, deliberate wrong outputs, result projections and delivery replay. PDF tests use real Poppler when installed; unavailable-dependency cases remain explicit. Model sampling in these tests uses deterministic fixtures. They do not certify host sampling quality, external model authentication, provider network access, ChatGPT Chat/Work connections or Claude-host integration. Those need the actual configured clients. No tunnel, remote app registration, app ID or credentials are created by this package.

## Tests

```bash
pnpm --filter @nullius/project-mcp test
python3 -m pytest packages/skills-market/tests/test_personal_plugin.py packages/skills-market/tests/test_personal_plugin_live.py
```

All newly generated managed project runs use `artifacts/runs/<run_id>/`; team and draft executor payloads live in `research_team/` beneath that run. Origin stamps bind the parent run. Historical `team/runs/<run_id>/` remains read-only evidence: status, run listing, index links and export retain its original location, stamps, validity rulings and result references. Reads do not migrate or rewrite it, and `init --runtime-only` reconnects without moving evidence. Unreadable historical locations are reported as unavailable without blocking unrelated readable runs. Duplicate IDs are reported as ambiguous; bare-ID reads refuse ambiguity, and new execution cannot reuse any historical ID. Stamping, backfill, staging, execution and resume cannot write historical run payloads. Use a distinct ID under `artifacts/runs/` for new work. The `inventory_run_relocation.py --fixture-root <anonymous-fixture> --source-manifest <hash-manifest>` helper only inventories pinned fixture bytes, references, collisions and unresolved bindings; it has no apply mode. Independent reviewer snapshots omit every run's executor payload and all workspace trees, retain production artifacts, and allow only each member's own declared output prefix. Historical reports/adjudications remain coordinator evidence. `team/LATEST*.md` and `artifacts/LATEST.md` are navigation pointers.

The generic scaffold creates `project_index.md`; the team helper updates only executor-local latest pointers and requires `nullius init` when the root index is missing. Selected-result and derived-block writers share a short path lock, reread their inputs, and make at most three attempts when edits are detected while preserving human bytes, mode and EOL outside their marked region. Arbitrary writers that ignore the lock remain outside its guarantee. Generic run counts do not interpret execution round limits; the Python executor resolver and suffix gate own those settings.
