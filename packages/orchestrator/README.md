# @nullius/orchestrator

Generic lifecycle control plane and bounded workflow CLI for the nullius ecosystem. Exposes both:

- the **`nullius` CLI** — stateful front door for external project roots (init — including the `--mode=<engine|file>` execution-mode declaration —, status, workflow-plan, verify, final-conclusions, report-validate, approve, decision, graph, trace, current, notebook, result, release);
- the **`orch_*` MCP/operator surface** — the canonical operator/tool counterpart of the same control plane, documented in [meta/docs/orchestrator-mcp-tools-spec.md](../../meta/docs/orchestrator-mcp-tools-spec.md).

The [`@nullius/project-mcp`](../project-mcp/README.md) leaf package provides a local
stdio transport bound by `NULLIUS_PROJECT_ROOT`. It delegates to this package's
canonical `handleToolCall` and `runCli`; it does not replace `nullius` or introduce
another lifecycle authority. Its background delivery reuses `RunManifestManager`:
stable `delivery_id` values recover responses, `outcome_unknown` stops for local
reconciliation, and `finalizing` waits for the project lock to be released.
`committed` records a response, including errors or approval requests, rather
than scientific success. Approval resolution remains on the local host; sampling
requires client support and a live foreground connection. See the
[personal-plugin guide](../skills-market/docs/PERSONAL_PLUGIN.md) for local composition.


Native computation binds an enabled A3 approval to the current manifest, scripts, declared input and dependency files, resolved executable bytes, production environment and approval policy. Missing packets, unbound historical approvals and changed inputs require fresh root approval before dispatch; a step-only A3 mismatch fails closed without creating a root request. A requested pause lets the current direct child return, preserves its step evidence and stops the run as paused, including after the last step. Native continuation in place is unsupported: same-run execution and `resume --force` refuse without changing the paused attempt; a new separately approved run is a distinct execution. `execution_status.json` persists one absolute deadline covering preflight, later direct children and local outcome publication; retries keep that deadline, and each child receives the smaller remaining or step limit. Hard CPU, memory and disk constraints are rejected during preparation. These limits do not supervise arbitrary descendants or remote jobs. Canonical state writes compare the caller's read snapshot under a short exclusive lock before appending combined events; stale snapshots refuse, and stale locks require quiescent manual repair. CLI and project transport share canonical external-root admission, including uncreated paths beneath existing symlink ancestors.

Executable idea-to-computation planning requires a supplied `method_spec` with `files` and `run_card`. Missing methods are refused before executable artifacts are written; planning never substitutes a result-writing runner for the requested operation.

## Layer

Stateful control plane. One shared authority for lifecycle state, approvals, bounded execution, verification, proposal decisions, conversational-decision recording (`nullius decision record|pending` append to `.nullius/decisions.jsonl`; `decision list` reads it back; trunk-side `decision land` assigns durable ids), and read models. A new decision first carries a six-character random Crockford-base32 handle drawn from 30 unbiased random bits ($32^6 = 2^{30}$). Candidates that also spell durable `D<n>` ids or collide with local identities are redrawn, so the exact pair-collision probability is context-dependent; with no local reservations it is $1/(2^{30}-90{,}000)\approx 9.314\times 10^{-10}$, slightly above $2^{-30}$. The guarantee is probabilistic, not structural, so merged collisions fail closed. The handle is machine-facing branch identity for local relations, with chronological presentation taken from millisecond-precision `ts`. `--resolves` closes only an earlier open `pending` entry; `--relates` records non-closing context to an earlier readable `decided` or `pending` entry. On replay, an unrecognized persisted relation is ignored and reported under `decision_ledger.unrecognized_relations` while its containing record remains admitted; a legacy or unknown non-blank string `kind` is retained under current `decided` semantics, exposing the original `source_kind` and a `normalized_kinds` diagnostic. Only exact `pending` creates an open item, while an otherwise valid `resolves` on a normalized entry still closes its pending target. After branch tails reach the authoritative trunk, `decision land` atomically assigns the next permanent `D<n>` values in trunk file order, rewrites handle-valued relations, and retains the mapping in each landed entry as `provisional_id`. Existing `D<n>` ledgers remain valid, counted, and resolvable without migration. Duplicate detection stays form-agnostic and fail-closed: `decision list` exits non-zero with offending lines for a repeated current id or a retained provisional id that is not one-to-one, the status receipt carries `decision_ledger.duplicate_ids` and `decision_ledger.ambiguous_provisional_ids`, new relation writes refuse an ambiguous target, and landing changes no bytes until the collision is repaired; normal provisional entries remain visible under `decision_ledger.unlanded_count`. A non-no-op landing refuses a ledger with no write permission bit; its last-moment source check detects edits made while the replacement is prepared, while POSIX provides no portable compare-and-swap rename against a non-cooperating writer. If rename succeeds but parent-directory durability cannot be confirmed, the CLI reports commit status uncertain; inspect with `decision list` using the same project root and rerun `decision land` there. A canonical no-op retry fsyncs the parent directory to confirm the visible entry durably. `nullius report-validate` delegates to `packages/project-contracts` for immutable main-report registration, supersession, human-evidence, and structural validation; it does not decide scientific sufficiency. Verification records adjacent production snapshots, absolute declared external refs, runtime/checker identity, process evidence, and checker self-reported matching output observations. A recorded pass does not prove that the checker actually read an output, executed a named negative control, or used an independent implementation. Dependency closure is literally incomplete: it is not syscall traced and does not bind installed bytes, dynamic imports, shared libraries, or an isolated image. The exactly-one-subject A5 consumer therefore currently returns `unavailable`; the generic approve consumer is not reachable from current validation receipts. Not a competing product identity with the MCP surface — both are facets of the same control plane.

The delegated runtime persists each tool attempt before dispatch and classifies it as `not_started`, `outcome_unknown`, or `committed`. Unknown side effects stop for operator reconciliation; committed MCP results replay exactly; permission checks cover the full assistant turn before any transport call; and run-gate approvals remain host/operator authority. Direct and team journals use separate `artifacts/delegated-runs/direct/` and `artifacts/delegated-runs/team/` roots, themselves structurally separate from caller-named root runs. Orchestrator-owned stdio servers use explicit cwd/config/credential inputs, an isolated `HOME`, required-credential preflight, and process-group cleanup on POSIX.

Persisted workflow-plan tool attempts use the same journal under `artifacts/runs/<run_id>/manifest.json`. A transport interruption stops uncertain replay; committed responses can recover state without another dispatch. Pause gates the next step, and canonical run-gate approval must precede retry of an approval-blocked step. Overflow compaction retains original user instructions verbatim and never separates a tool call from its results; older exchanges are dropped whole, and long results in the kept exchanges are cut to marked incomplete excerpts.

Completed workflow execution returns a separate `workflow_acceptance` view. Workflow packages select checks; the control plane executes them with bounded time and captures structured verdicts, exact input hashes and checker identities in immutable per-attempt receipts. Required nonpasses return a nonzero exit code and `ok: false`, while `run_status` continues to describe execution. Read-only status revalidates freshness, and rerunning a completed plan rechecks acceptance without tool redispatch. No declared checks means `not_required`, not scientific approval. See [the literature contract](../literature-workflows/README.md#workflow-evidence-acceptance).

## Binary

Build first, then point your `$PATH` at the workspace CLI:

```bash
pnpm -r build
mkdir -p "$HOME/.local/bin"
ln -sf "$(pwd)/packages/orchestrator/dist/cli.js" "$HOME/.local/bin/nullius"
chmod +x "$HOME/.local/bin/nullius"
export PATH="$HOME/.local/bin:$PATH"
nullius --help
nullius runtime path
```

`nullius runtime path` reports the running installation, and `nullius runtime mcp <server>` starts a registered stdio server. The package registry owns relative entrypoints; the generic CLI owns discovery and configuration validation. Host-private `servers.<server>.env` settings are read from `${XDG_CONFIG_HOME:-$HOME/.config}/nullius/runtime.json`, or an absolute `NULLIUS_RUNTIME_CONFIG`. They override ambient settings. Explicitly missing/invalid configuration fails closed. Project/data roots required by a server must be outside this installation. These installation commands add no research execution or approval authority. After moving a checkout, rebind the PATH entry above; copied skills and plugins need no source-path edits.

A project-local launcher (`./.nullius/bin/nullius`) is also written during `nullius init` so already-initialized research roots can reconnect without the global wrapper. `nullius init --refresh` generates missing support guidance (`AGENTS.md`) and preserves differing existing instructions byte-for-byte, without backups or scaffold replacement of user-owned seed content. The CLI may synchronize existing machine-managed notebook and index blocks, without inserting missing blocks. To update existing guidance, render a current scaffold in a separate temporary external root and explicitly merge desired changes. For an existing project that predates the main-report registry, checkpoint it and render a current scaffold in a separate temporary external root; copy only a missing report template and manually merge the `project_index.md#Main research report` section. Refresh never performs that user-owned migration. `report-validate` returns `invalid_registry_markers` before the registry merge and `no_current_report` until a populated current report is registered.

## State and artifacts

Writes to **external project roots only**:

```text
<project_root>/
  .nullius/
    HARNESS              # machine-readable handshake
    state.json
    ledger.jsonl
    decisions.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json     # if fleet features used
    fleet_workers.json   # if fleet features used
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
```

Development repo paths are not real project roots — see [AGENTS.md](../../AGENTS.md) §Stable Public Invariants.

## Build & test

```bash
pnpm -C packages/orchestrator build
pnpm -C packages/orchestrator test
pnpm -C packages/orchestrator test tests/nullius-cli.test.ts   # front-door drift lock
```

## See also

- Root [README.md](../../README.md) — full surface policy, layer model, and external project lifecycle smoke path
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — control plane internals
- [meta/docs/orchestrator-mcp-tools-spec.md](../../meta/docs/orchestrator-mcp-tools-spec.md) — `orch_*` tool inventory (fail-closed drift-locked)

All newly generated managed project runs use `artifacts/runs/<run_id>/`; team and draft executor payloads live in `research_team/` beneath that run. Origin stamps bind the parent run. Historical `team/runs/<run_id>/` remains read-only evidence: status, run listing, index links and export retain its original location, stamps, validity rulings and result references. Reads do not migrate or rewrite it, and `init --runtime-only` reconnects without moving evidence. Unreadable historical locations are reported as unavailable without blocking unrelated readable runs. Duplicate IDs are reported as ambiguous; bare-ID reads refuse ambiguity, and new execution cannot reuse any historical ID. Stamping, backfill, staging, execution and resume cannot write historical run payloads. Use a distinct ID under `artifacts/runs/` for new work. The `inventory_run_relocation.py --fixture-root <anonymous-fixture> --source-manifest <hash-manifest>` helper only inventories pinned fixture bytes, references, collisions and unresolved bindings; it has no apply mode. Independent reviewer snapshots omit every run's executor payload and all workspace trees, retain production artifacts, and allow only each member's own declared output prefix. Historical reports/adjudications remain coordinator evidence. `team/LATEST*.md` and `artifacts/LATEST.md` are navigation pointers.

The generic scaffold creates `project_index.md`; the team helper updates only executor-local latest pointers and requires `nullius init` when the root index is missing. Selected-result and derived-block writers share a short path lock, reread their inputs, and make at most three attempts when edits are detected while preserving human bytes, mode and EOL outside their marked region. Arbitrary writers that ignore the lock remain outside its guarantee. Generic run counts do not interpret execution round limits; the Python executor resolver and suffix gate own those settings.

Existing `PROJECT_INDEX_AUTO` blocks are historical, unmaintained observations; the team helper neither parses nor updates them. Current `RUN_INDEX` navigation and curated result/report registries have separate owners. Do not silently rewrite or delete an old block.

### Human notebook integration

`nullius current` and `nullius status --json` expose `notebook.result_links`
(under `traceability` in status): current result artifacts without a direct link
in a human `##` section are reported as `missing_links`; an unreadable notebook
is `unavailable`. Inline and explicit reference links are recognized; recursive
notes, HTML, shortcut references and indented link lines are not scanned. Automatic tables, comments
and code examples cannot supply the link. `linked` establishes navigation only,
not explanation quality, derivation completeness or scientific correctness.
CommonMark parsing excludes raw HTML and code even inside quotes or lists.
Markdown destinations are decoded as URIs; registered artifact filenames remain
literal paths, including any `%` or `?` characters.

At a scientific result fold, rewrite the relevant sections with assumptions,
reasoning, interpretation and limitations, and cite the registered artifact.
This applies in file mode as well as engine mode. The team convergence gate
requires the declared headline in a declared rewritten section. Retired history
remains readable; all current results participate in the final unscoped check. `nullius notebook sync` only refreshes the automatic table.

Notebook closeout has two separate requirements: structural navigation and a
current full-text content review. Run the review after finishing the notebook
and refreshing its automatic block:

```bash
nullius notebook review --model <SPEC> [--dependency <project-relative-path> ...] [--timeout-secs <N>] [--json]
nullius notebook check [--result <id>] [--structure-only] [--json]
```

`notebook review` executes a real reviewer through the existing `review-swarm`
launcher. Its default hard timeout is 1200 seconds across at most 64 bounded
calls, with one attempt per call and no automatic reviewer retry. The reviewed input freezes the
complete UTF-8 notebook, including its automatic block, and required declared
dependencies with SHA-256 digests of their actual bytes. Uncommitted edits are
included; a commit or section version stamp alone cannot establish identity.

Valid UTF-8 text remains text regardless of size; Markdown links are discovered
recursively. Binary or invalid UTF-8 linked files are immutable `opaque_links`
snapshots and hash locators, not read evidence. Every opaque path/hash needs a
specific `opaque_sources` assessment; a required unread source prevents acceptance.
Notebook and explicit dependencies require strict UTF-8 and LF or CRLF endings. Linked text with unsupported bare-CR endings remains pending and prevents acceptance until a supported original is provided.

The complete material is frozen before review. Storage (`--snapshot-bytes`,
default 512 MiB; `--max-files`, default 256) is separate from each request's
`--context-bytes` and configured backend `--context-tokens` window (default
200,000 tokens, with instruction/output reserves). Default request bytes use a
conservative token upper bound. A larger explicit byte packet requires captured
backend token usage when that bound exceeds the window; missing capacity evidence,
observed backend compaction or delivery failure supplies no acceptance.

Larger materials use original UTF-8 intervals with adjacent original context,
followed by a joint audit receiving the COMPLETE original notebook and text
dependencies. All intervals and the joint audit must be complete and fresh;
selected quotations or summaries cannot replace this original input. The default
execution budget is 1200 seconds and 64 calls (`--timeout-secs`, `--max-batches`),
with one attempt per call and no automatic retry. Shortfalls expose total frozen
material, pending intervals and joint scope, the reason and a resumable command.
An unfinished intake reports discovered material and incomplete dependency
enumeration. `--resume <run-id>` creates a new run, revalidates original receipts
and material identity, retains explicit dependencies and storage budgets, and
never rewrites old evidence. If the full joint input does not fit the backend,
raise an available backend's request budget or leave the review incomplete.
Compaction detection currently uses captured Claude system events; other routes have no equivalent event witness and use the conservative configured byte bound when token usage is absent. The configured token window is a caller constraint, not automatic backend-capability discovery. Only tool mode `none` is accepted. Multiple batches are one semantic review;
they do not establish independent confirmations or a cross-family quorum.

Any change to those bytes makes the previous review stale. Historical reports
remain readable and retain their original input identity.

Canonical verification records reflect the admissibility of the executed review,
including its trace, tool mode and pre/post freshness, rather than PASS alone.
Later edits can make a historically verified review stale. Moving a project leaves
its frozen evidence readable but current execution freshness unavailable; review
again in its new location. A setup failure records the failed attempt and its prior
run, withdraws current acceptance, and reports unavailable. Reviewed text requires
LF or CRLF line endings; bare CR is refused.
A review is admitted when its immutable start record is durably stored. That
record blocks reuse of the prior review even if control-pointer writes fail.
Failure before durable admission produces no new review verdict.
Start records are published atomically; a malformed managed start makes current
admission unavailable. Concurrent writers preserve their separate execution
histories and clear only their own pending marker under the shared control lock.
Admission order is recorded under that lock. Only the latest admitted review
can publish current acceptance or failure; an older execution finishing later
cannot replace a newer rejection or bypass an unavailable later attempt.

The reviewer reads the entire notebook and records coverage for every section,
with source anchors and reasons addressing derivation completeness, logical
consistency, notation, definitions, assumptions, and conventions. Partial
reading, unavailable dependencies, failed execution, invalid output, or stale
inputs cannot satisfy this requirement. Links, automatic tables, formula counts,
completed checklists, and the writer's own assessment cannot supply a content
verdict. The reviewer receives the frozen material and review question without
an expected verdict or the writer's initial judgment.

`notebook check` is read-only and returns `structure` (the `result_links` report)
and `content_review` separately. Default unscoped exit 0 requires both structural
success and an accepted full-text review of the current notebook and dependencies. Exit 1
means acceptance is incomplete, including invalid review evidence; exit 2 means
invalid command/setup input or unavailable execution/runtime.
`--result` narrows only the structural result-link scope: content review always
covers the entire notebook, and scoped success reports `diagnostic_passed`.
Diagnostic success can return exit 0; it does not establish whole-project closeout.
Default structural acceptance requires a present, valid result registry. Registry
validation covers every row, including superseded rows; only current rows create
the human-link obligation. An absent or defective registry is unavailable and
must be repaired before closeout. Ordinary state and history remain readable.
`--structure-only` checks navigation alone, so its
exit 0 does not establish notebook closeout, even when there are no adopted
results. The same current-version contract applies in file and engine mode.

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

`nullius current` and `nullius status --json` expose `notebook.content_review`
without launching a reviewer or blocking ordinary state and historical reads.
Review evidence uses the existing verification subject, check-run, verdict,
coverage, and `ArtifactRef` contracts. This is a supporting semantic check, not
decisive computation validation or proof of scientific truth. A single reviewer
also leaves explicit limits on model, method, and input independence; load-bearing
claims still need their applicable derivation, numerical, and source checks.

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.

Research output preservation, path classification, read-only inventory, commit checks and automatic origin-snapshot admission are described in [Research output storage](../../docs/RUN_STORAGE.md). No storage command deletes data, rewrites history or expires recovery records.
