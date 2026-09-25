# Project MCP transport

`@nullius/project-mcp` connects an MCP client to one external Nullius project. It consumes the existing orchestrator tool dispatcher and CLI; lifecycle state, approvals, planning, execution and verification remain owned by `@nullius/orchestrator`. It does not aggregate provider servers or introduce a scheduler.

Build the workspace, then start the server with an explicit project:

```bash
pnpm -r build
NULLIUS_PROJECT_ROOT=/absolute/research/project node /absolute/nullius/packages/project-mcp/dist/index.js
```

The directory must exist, be outside the development checkout, and not be a parent of it. `NULLIUS_CONTROL_DIR` must be unset. The process uses the bound project as its working directory. The [personal plugin builder](../skills-market/docs/PERSONAL_PLUGIN.md) packages the existing skills and configures this server alongside HEP and idea MCP servers. Configure idea storage separately. Other clients may launch the same standard stdio server; their skill/plugin installation formats differ.

## Tools and project advancement

`project_capabilities` reports the connected runtime, limits and sampling availability. The public inventory comes from `src/registry.ts` and a restricted view of the canonical orchestrator registry.

| Entry | Behavior |
| --- | --- |
| `project_cli` | Typed init, status, current, notebook/index sync, report validation, result registration, run stamping and decision recording through the canonical CLI. No caller-supplied argv. |
| `project_file_read` | Project-relative file bytes, base64 encoded in chunks up to 64 KiB; whole-file SHA-256, size and next offset. Regular files up to 64 MiB. |
| `project_file_write` | UTF-8 source/input/checker upload up to 1 MiB. `expected_sha256: null` creates a new file; replacing a file requires its current hash. |
| `project_delivery_read` | Read a persistent response for a submitted mutation. |
| Selected `orch_*` | Existing create/status/list, pause/resume/export, approval inspection, policy query, staging, computation, verification, final-conclusion evaluation and sampling-dependent delegation. |

An MCP-only client can initialize a project, upload a method handoff, stage and plan it, execute its manifest, upload and execute a checker, read the actual output, register a result, and refresh project projections. A successful tool response is not proof that a scientific claim is correct. Verification retains the canonical checker contract; A5 remains unavailable with the current incomplete dependency closure.

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

Sampling-dependent delegation runs in the foreground through the client's MCP sampling callback and a bound, restricted tool loopback. It requires a connected host and uses the existing delegated journal for recovery. Missing sampling returns unavailable. Callers cannot grant team permissions, inject approval interventions, supply arbitrary executable tool definitions, or call operator approval resolvers. Provider tools remain separate servers; this loopback exposes only the listed control-plane tools. Native hosts may use the existing research-team/review-swarm skills and their authenticated runners directly.

The file API and tool parameters are project-bound. Uploaded methods and checkers execute as trusted code under the local user's account, using existing Nullius runtime checks. This is **not an OS sandbox**; scripts can access resources available to that user. HEP and idea servers retain their own trust and confirmation contracts. A provider URI or external cache path is not automatically readable through this project's file API.

Local SDK integration tests cover real planning/computation/checker execution, deliberate wrong outputs, result projections and delivery replay. They do not certify host sampling quality, external model authentication, provider network access, ChatGPT Chat/Work connections or Claude-host integration. Those need the actual configured clients. No tunnel, remote app registration, app ID or credentials are created by this package.

## Tests

```bash
pnpm --filter @nullius/project-mcp test
python3 -m pytest packages/skills-market/tests/test_personal_plugin.py packages/skills-market/tests/test_personal_plugin_live.py
```
