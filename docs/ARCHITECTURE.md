# Architecture Overview

This document explains the current front-door architecture of the monorepo. It is intentionally capability-first and workflow-first: the root is a domain-neutral research substrate and control plane, while concrete provider families live in leaf packages. HEP is the current most mature provider family and the strongest end-to-end example, but not the root identity.

---


Native computation binds an enabled A3 approval to the current manifest, scripts, declared input and dependency files, resolved executable bytes, production environment and approval policy. Missing packets, unbound historical approvals and changed inputs require fresh root approval before dispatch; a step-only A3 mismatch fails closed without creating a root request. A requested pause lets the current direct child return, preserves its step evidence and stops the run as paused, including after the last step. Native continuation in place is unsupported: same-run execution and `resume --force` refuse without changing the paused attempt; a new separately approved run is a distinct execution. `execution_status.json` persists one absolute deadline covering preflight, later direct children and local outcome publication; retries keep that deadline, and each child receives the smaller remaining or step limit. Hard CPU, memory and disk constraints are rejected during preparation. These limits do not supervise arbitrary descendants or remote jobs. Canonical state writes compare the caller's read snapshot under a short exclusive lock before appending combined events; stale snapshots refuse, and stale locks require quiescent manual repair. CLI and project transport share canonical external-root admission, including uncreated paths beneath existing symlink ancestors.

Moving or copying the runtime does not make a Nullius development checkout eligible as a real research project. This applies to the original checkout and other checkouts, including their descendants and filesystem aliases; explicit maintainer fixtures remain confined to `skills/research-team/.tmp`.

## 1. Stable Layer Model

| Layer | Current authority | Boundary |
| --- | --- | --- |
| Workflow authority | checked-in recipes consumed by `nullius workflow-plan` | High-level workflow meaning stays above provider packs |
| Stateful control plane | `nullius` plus `orch_*` | One shared authority for lifecycle state, approvals, bounded execution, verification, proposal and conversational decisions, and read models |
| Project transport leaf | `@nullius/project-mcp` | One externally bound project; reuses canonical `handleToolCall` and `runCli`, without acquiring control-plane authority |
| Agent project harness | `research-harness` skill | Thin host-client entrypoint for recovery, routing, verification, and handoff in external research project roots |
| Experimental runtime bridge | `@nullius/idea-engine`, `@nullius/idea-mcp` | Explicit runtime bridge, narrower than the full engine contract, search/eval runtime archived, not a root front door |
| Domain workflow pack | `@nullius/hep-mcp`, `hep_*` | Current strongest end-to-end example without becoming the root identity |
| Atomic provider operators | `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*` | Bounded schema-driven MCP atoms that stay MCP-first |
| Project-local reconnect truth | `.nullius/` plus durable memory files | The external project root, not the development repo, holds the long-lived truth |

## 2. Design Invariants

- The root architecture is domain-neutral. Provider-specific worldview and workflow bias stay in provider packages or workflow recipes.
- Shared gate-result contracts express the gate's real lifecycle: convergence gates use `convergence_gate_result_v1`, while the domain-neutral pre-dispatch delegation-budget quality gate uses `delegation_budget_gate_result_v1` with `pass | fail | input_error`; preflight validation is not modeled as convergence.
- `nullius` remains the stateful CLI front door. `orch_*` remains the MCP/operator counterpart of that same control plane. Main-report structure is owned by `packages/project-contracts`; `nullius report-validate` is a thin CLI consumer.
- `research-harness` is the agent-client skill entrypoint for Codex / Claude Code / OpenCode project continuation. It does not own state or execution; it restores `.nullius/` plus durable project files, routes milestone work to `research-team`, routes Markdown note cleanup to `markdown-hygiene`, routes HEP evidence work to `hep-mcp`, and folds results back into `research_contract.md`, `research_plan.md#Current Status`, and `artifacts/runs/<run_id>/`.
- `nullius init` writes `.nullius/HARNESS` as the machine-readable project handshake. Agents should treat its presence as a mandatory `nullius status --json` receipt trigger before new work, milestone execution, closeout, or handoff. `nullius init --refresh` creates missing support guidance but the scaffold preserves differing existing `AGENTS.md` instructions and user-owned seed content. The CLI may synchronize existing machine-managed notebook and index blocks, without inserting missing blocks. Template changes do not automatically update existing projects. Update guidance by rendering a scaffold in an anonymous temporary external root and manually merging desired changes, including notebook review instructions, into existing user-owned files.
- Projects declare where their truth lives with `nullius init --mode=<engine|file>` (works on fresh and already-initialized roots): `engine` means the run/approve lifecycle drives the work; `file` means work is executed by hand or external runners, durable truth lives in the project files and dated run directories, and an idle `run_status` is normal (declared file-mode also drops the plan-focus reconnect warning). The declaration is descriptive, never enforcing — no command is disabled in either mode, and it can be re-declared at any time the same way. Human decisions made in conversation are recorded via `nullius decision record` / `nullius decision pending` into `.nullius/decisions.jsonl` (read back with `nullius decision list`); the status receipt carries `execution_mode`, the decision ledger, and a diagnostic-only hint when an undeclared project looks file-mode in practice. Decision identity has two phases because branch-time allocation and durable citation have different requirements: recording mints a six-character random Crockford-base32 handle with no timestamp, suitable for uncoordinated branch-local relations. The raw draw carries 30 unbiased random bits ($32^6 = 2^{30}$); candidates that also spell durable `D<n>` ids or collide with local identities are redrawn, so the exact pair-collision probability is context-dependent. With no local reservations it is $1/(2^{30}-90{,}000)\approx 9.314\times 10^{-10}$, slightly above $2^{-30}$: probabilistic, not structural, with merged collisions detected fail-closed. `--resolves` closes only an earlier open `pending` entry; `--relates` records non-closing context to an earlier readable `decided` or `pending` entry. On replay, an unrecognized persisted relation is ignored and reported under `decision_ledger.unrecognized_relations` while its containing record remains counted and addressable. A legacy or unknown non-empty string `kind` is normalized conservatively to current `decided` semantics, with the original value retained as `source_kind` and reported under `normalized_kinds`; only the exact persisted `pending` kind creates an open item, while an otherwise valid `resolves` on a normalized entry still closes its pending target. After branch tails are integrated on the authoritative trunk, `nullius decision land` atomically assigns the next permanent `D<n>` ids in trunk file order, rewrites handle-valued relations, and retains each mapping as `provisional_id`. Existing `D<n>` ledgers are valid with zero migration: their entries remain readable, counted, and resolvable by already-cited ids. Presentation order comes from the millisecond-precision `ts`, not from provisional identity. Local minting avoids current ids and retained mappings. Duplicate detection remains form-agnostic and fail-closed: `decision list` exits non-zero and names the lines for duplicate current ids or a provisional id that is not one-to-one, the receipt exposes `decision_ledger.duplicate_ids` and `decision_ledger.ambiguous_provisional_ids`, new relation writes refuse an ambiguous target, and `decision land` changes no bytes until the collision is repaired. Provisional entries are otherwise valid and remain in all status counts; `decision_ledger.unlanded_count` makes the trunk-side landing obligation explicit. A non-no-op landing refuses a ledger with no write permission bit. Its last-moment source check detects edits made while the replacement is prepared, but POSIX supplies no portable compare-and-swap rename against a non-cooperating writer. If rename succeeds but parent-directory durability cannot be confirmed, the CLI reports commit status uncertain; inspect with `decision list` using the same project root and rerun `decision land` there. A canonical no-op retry fsyncs the parent directory to confirm the visible entry durably.
- Provider MCP surfaces stay MCP-first. We do not mass-convert provider MCP into CLI because those surfaces are bounded atoms, not stateful workflow shells.
- `idea-mcp` remains experimental and must not reclaim root workflow authority; the idea-engine has been restarted into a probability-managed idea portfolio, and the idea-engine search/eval runtime is archived rather than a default capability-expansion lane, with contracts + store retained and scoring consuming an external belief-graph posterior (pinned tool, current pin gaia-lang==0.5.0a4).
- `research_brainstorm` is a lightweight planning-only durable harness recipe under `nullius workflow-plan`: it persists a brainstorm-to-handoff plan and emits a `next_contract` for optional heavier recipes, but it does not provide built-in runtime tools or invoke host-native thinking process, idea-engine, full research-team, broad retrieval, memory graph expansion, or a new front door.
- Large outputs are written to disk as artifacts; MCP results return compact summaries plus file or artifact pointers.
- The delegated agent runtime is a host-client execution harness inside the control plane, not a second scientific authority. Its versioned `manifest.json` durably records each tool attempt as `not_started`, `outcome_unknown`, or `committed`, including the exact committed MCP result. `outcome_unknown` stops for operator reconciliation and is never automatically retried or converted into model-visible retry advice.
- `AgentRunner` owns the non-optional permission view and whole-turn preflight. Approval-resolving tools stay at the host/operator boundary; a delegated tool result becomes a run-gate request only when a registered producer returns the complete hash-bound envelope for the root run. Team assignment state stores that gate only as a tagged projection and cannot grant it.
- Orchestrator-owned MCP subprocesses run in an explicit execution world: a declared working directory, isolated temporary `HOME`, allowlisted ambient baseline, separately declared configuration and credentials, and required-credential checks before spawn. POSIX launches use a dedicated process group led by a small anchor process that stays in the group until the client's final SIGKILL, so the group number cannot be reissued while the client may still signal it; if the client exits without stopping it, the anchor itself sends the group SIGTERM and, after the kill grace, SIGKILL. Initialization failure, unexpected parent exit, request timeout, and close thus terminate the descendant group. Reconnects have a lifetime budget; a timed-out client is unusable and cannot reconnect.
- Runtime diagnostics are projections of the durable runtime manifest and runtime projection. They are operational evidence only and are never accepted as research findings, verification results, or promoted conclusions.
- Runs belong only to the orchestrator (`<project_root>/artifacts/runs/<run_id>/`). `hep-mcp` keeps no run of its own: its research-output tools (search exports, identifier and Zotero mappings, LaTeX parses, conflict maps) write their files into a caller-chosen `output_dir` inside the project root and return project-relative paths; downloads made by `inspire_paper_source`, caches and PDG data stay in hep-mcp's data root (`<project_root>/artifacts/hep-mcp` or `HEP_DATA_DIR`). Source and output paths stay constrained under allowed roots.
- For initialized external project roots, `.nullius/HARNESS`, `.nullius/` state, `project_index.md`, project-local durable memory, and registered immutable reports remain the enduring reconnect truth.
- `research_plan.md#Current Status` is the human status entry for final target, current phase, completion state, blocker, next step, stop condition, and evidence pointers before the longer task board and log.
- `research_notebook.md` is the human-facing logical narrative, organized by problem, derivation, claims, and uncertainty rather than by run date or status tracking; important literature notes require full-text/source-first reading, auditable section/page/equation/figure coverage, and LaTeX math notation, while raw dated run logs and tool-use traces belong in `research_plan.md` or `artifacts/runs/<run_id>/`.
- `project_index.md#Main research report` is the single current report entry and supersession registry. Reports under `reports/` are immutable researcher-facing narratives; JSON, JSONL, hashes, and receipts bind provenance but never substitute for the report or its clickable human-readable evidence chain. `report-validate` checks structural promotion conditions and deliberately leaves scientific sufficiency to reviewer judgment.
- Project-local `run_id` values are human-facing research identities: prefer safe, sortable names such as `20260502T023000Z-m3-branch-scan-r1`. All newly generated managed project runs use `artifacts/runs/<run_id>/`; team and draft executor packets, checkpoints, logs and workspaces live in its `research_team/` namespace. The parent run carries its origin stamp. Executor receipts and navigation pointers do not grant lifecycle approval or scientific acceptance.
- Optional support surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` are created later by explicit project need or host-specific tooling rather than by the canonical generic scaffold.

## 3. Current Public Surfaces

| Surface | Current authority | Notes |
| --- | --- | --- |
| Stateful CLI front door | `nullius` | Generic lifecycle state, `workflow-plan`, bounded native TS computation, verification, higher-conclusion gating, main-report structural validation, proposal decisions, and `graph` dependency-map rendering (consumes the domain-neutral `@nullius/shared/graph-viz` engine: claims / progress / literature / roadmap) |
| Control-plane MCP/operator surface | `orch_*` | Canonical public MCP/operator counterpart of the same control plane |
| Stateful literature planning | `nullius workflow-plan` | Checked-in workflow authority resolved via `@nullius/literature-workflows`; persists `.nullius/state.json#/plan` and derives `.nullius/plan.md`. `research_brainstorm` is the lightweight planning-only recipe variant that emits a `next_contract` handoff without starting heavier workflows |
| Agent project harness skill | `research-harness` | Market-listed thin skill for Codex / Claude Code / OpenCode to recover project truth, route execution to `nullius` / `research-team` / `markdown-hygiene` / `hep-mcp`, and close out verification or handoff |
| Experimental runtime bridge | `idea-mcp` | `idea_campaign_*` on explicit external data roots; node posterior/lifecycle/grounding-audit/card-revision updates, generation-pack import (`node.import_generated`), and posterior-based `rank.compute` / `node.promote` stay inside the `idea-engine` runtime contract |
| Current most mature domain MCP front door | `@nullius/hep-mcp` | Literature search exports and identifier/Zotero mappings into a caller-chosen `output_dir`, and provider-local composition |
| Provider-local atoms | `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*` | Bounded provider operators that remain MCP-first |

Front-door surface classification lives in `meta/front_door_authority_map_v1.json`; exact inventories remain owned by their source surfaces.

## 4. Why Provider MCP Stays MCP

- Provider surfaces are naturally schema-driven and agent-composable.
- Many provider calls produce structured local artifact output instead of becoming separate workflow front doors.
- A provider-local CLI mirror would add another surface to document and test without clarifying where workflow authority lives.
- Stateful workflow entry remains above provider packs: `nullius workflow-plan` owns checked-in workflow authority, and `nullius run` remains the only execution front door.
- This is also why HEP can stay the strongest end-to-end example without being rewritten into the root product identity.

## 5. State, files, and artifacts

### 5.1 `HEP_DATA_DIR`

`packages/hep-mcp/src/data/dataDir.ts` resolves the HEP data root in this order: explicit tool-call `project_root` for an initialized nullius project (`<project_root>/artifacts/hep-mcp`), then `HEP_DATA_DIR`, then scratch fallback `~/.nullius/hep-mcp`. A `project_root` is admitted in canonical, external form like every other front door; the project-local directories a call uses must be real directories (a symlink on `artifacts/`, `artifacts/hep-mcp/` or its `pdg/` directory is refused), and caller paths compared with the data root may spell the project through an alias of its root.

```text
<resolved HEP data root>/
  cache/
  downloads/
  pdg/
```

Important path helpers live in:

- `packages/hep-mcp/src/data/dataDir.ts`
- `packages/hep-mcp/src/core/outputDir.ts`

Tools that produce files (`hep_inspire_search_export`, `hep_inspire_resolve_identifiers`, `hep_import_from_zotero`, `inspire_parse_latex`, `inspire_theoretical_conflicts`, and `inspire_search` when given `output_dir`) take a caller-chosen `output_dir`. It requires `project_root`; it is relative to the project root or absolute (any spelling of the root); it is created if missing; it may not traverse a symbolic link below the project root, lie under `.nullius/`, `team/runs/` or `artifacts/hep-mcp/`, or be the project root itself (reserved areas are compared ignoring letter case). Output names are one file name, distinct within a call even ignoring case and Unicode normalization. A call never replaces an existing file: a call whose output files already exist is refused, so an earlier result keeps its bytes. A call that fails removes the files it had already published, so when that cleanup succeeds it leaves all of its files or none. If cleanup fails, the error says what is left: published files that could not be removed make it UNSAFE_FS, stating that the outputs are incomplete and listing them in `files_left` (with any remaining staging files in `staging_left`); staging files alone that could not be removed keep the original error, extended with `staging_left`; a staging file that could not even be identified is named in `staging_path`; and if the removals cannot be flushed to disk, the error is UNSAFE_FS saying the cleanup may not survive a crash, with `unflushed_directories`. Only a crash of the server process during publication can leave part of a set without such a report. Either way, a later call naming those files is refused until they are removed or a new `output_dir` is used. INSPIRE lookups made through the response cache (by `hep_inspire_search_export`, `hep_inspire_resolve_identifiers`, `inspire_search` with `output_dir`, and the INSPIRE resolution step of `hep_import_from_zotero`) are recorded request by request under `<output_dir>/external_api/` (a request repeated within one call is made and recorded once); other provider calls (the Zotero local API, the paper fetches of `inspire_theoretical_conflicts`, the source retrieval of `inspire_parse_latex`) are not recorded there. Historical `runs/<run_id>/` and `projects/<project_id>/` directories under a HEP data root (the latter holding paper/evidence projects and evidence catalogs), written by earlier versions, are read-only evidence: no tool creates or rewrites them, and `docs/URI_REGISTRY.md` gives the reading rules for historical `hep://runs/...` and `hep://projects/...` references.

### 5.2 `.nullius` external project roots

The generic lifecycle package writes to real external project roots:

```text
<project_root>/
  .nullius/
    HARNESS
    state.json
    ledger.jsonl
    decisions.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json
    fleet_workers.json
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
    delegated-runs/
      direct/<run_id>/
        manifest.json                # direct agent-runtime tool-attempt journal v2
        spans.jsonl
        runtime_diagnostics_bridge_v1.json
      team/<runtime_run_id>/
        manifest.json                # tuple-derived team-runtime tool-attempt journal v2
        spans.jsonl
        runtime_diagnostics_bridge_v1.json
```

Key files:

- `packages/orchestrator/src/state-manager.ts`
- `packages/orchestrator/src/orch-tools/run-read-model.ts`
- `packages/orchestrator/src/computation/approval.ts`

Persisted workflow-plan steps share `RunManifestManager` under `artifacts/runs/<run_id>/manifest.json`: dispatch intent precedes the tool call, raw response commit precedes state projection, and unknown outcomes require operator reconciliation. Pause and canonical approval are checked at dispatch boundaries; an approval envelope is not a completed research step. These boundaries do not provide a compare-and-swap guarantee against arbitrary concurrent external state writers.

Overflow recovery keeps a separate immutable snapshot of original user text and evicts complete tool-call/result groups. Evidence excerpts are explicitly incomplete; required source content must be reacquired. If the instruction capsule itself cannot fit, recovery stops instead of truncating user constraints.

### 5.3 Research material placement

Paper originals, extracted text, arXiv source tarballs, and source trees are filesystem materials, not product-level protocol surfaces.

- If a source is only needed for the current check, keep it in a local temporary directory.
- If future verification, review, or continuation needs it, write it under the external project root in a suitable project/run artifact subdirectory.
- README and quickstart flows should stay centered on tools, external project roots, durable files, and manifests rather than URI schemes.
- `docs/URI_REGISTRY.md` is implementation/debug bookkeeping for emitted identifiers, not workflow guidance for where research materials should live.

## 6. Code map for the current front door

| Path | Current responsibility |
| --- | --- |
| `packages/hep-mcp/src/tools/registry/shared.ts` | current tool exposure order and `standard`/`full` filtering |
| `packages/hep-mcp/src/data/dataDir.ts` | per-call HEP data root resolution and `project_root` admission |
| `packages/hep-mcp/src/core/paths.ts` | single-path-segment check for output and artifact names |
| `packages/hep-mcp/src/core/outputDir.ts` | admission of caller-chosen `output_dir` inside the project root and output file writes |
| `packages/hep-mcp/tests/core/*` | core front-door behavior tests |
| `packages/hep-mcp/tests/docs/docToolDrift.test.ts` | doc/tool-count/front-door drift guard |
| `packages/orchestrator/src/cli-help.ts` | current lifecycle CLI help and boundary wording |
| `packages/orchestrator/src/orch-tools/*` | generic lifecycle tool surfaces |

## 7. Connection model

### 7.1 MCP clients

The project transport and domain server have separate local stdio entrypoints:

```text
NULLIUS_PROJECT_ROOT=/absolute/path/to/external-project node /absolute/path/to/nullius/packages/project-mcp/dist/index.js
node /absolute/path/to/nullius/packages/hep-mcp/dist/index.js
```

The current public MCP contract is intentionally narrow: local stdio process launch, tool `inputSchema`, compact JSON/text tool results, and no prompts. Research material placement remains filesystem-first: temporary files for one-off checks, project/run artifacts for durable verification and continuation. Remote MCP transports, OAuth, registry publishing, and a separately packaged generic root MCP server are future deployment surfaces, not current architecture. `orch_*` is the orchestrator-owned operator/tool inventory for the control plane rather than an independent root MCP server process.

[`project-mcp`](../packages/project-mcp/README.md) is a leaf adapter exposing a selected canonical `orch_*` subset plus five project-transport tools. The [personal plugin](../packages/skills-market/docs/PERSONAL_PLUGIN.md) composes it with HEP and idea servers and existing skills; project and idea launchers require an external project; HEP may run standalone. A bound project becomes the cwd. Skills are copied snapshots. Both the plugin and ordinary copied skills discover the destination installation through `nullius runtime path`; MCP manifests invoke `nullius runtime mcp <server>`, with relative entrypoints owned by `packages/skills-market/runtime-servers.json`. No builder-machine paths are stored in distribution metadata.

Background mutations carry a stable `delivery_id`. Delivery reuses `RunManifestManager` for intent and response records, with no second queue or research-state authority. `outcome_unknown` requires local reconciliation and must not trigger automatic replay; `finalizing` means the response is persisted but the worker has not released the project lock. `committed` means a transport response is available, including error or approval-request responses; it is not a successful research verdict. Canonical run state and artifacts remain authoritative.

Project-file reads return bounded chunks from permitted real files inside the bound project; provider caches outside that project are not exposed by this API. Path restrictions do not sandbox local scripts at OS level. Approval resolvers stay on the local host. Sampling-backed calls are foreground operations requiring client sampling support and a live connection; absent support returns `unavailable`, and no model authentication or background scheduler is supplied by the plugin. ChatGPT Chat/Work and Claude-host connections remain untested; required tunnel/app registration is separate user configuration.

Expected environment knobs at the front door:

- `project_root` tool argument for project-local durable artifacts
- `NULLIUS_RUNTIME_CONFIG` for a host-private server environment map (default: `${XDG_CONFIG_HOME:-$HOME/.config}/nullius/runtime.json`), kept outside plugin/skill payloads
- `NULLIUS_PROJECT_ROOT` for project/idea binding and optional HEP binding
- `IDEA_MCP_DATA_DIR` for explicit external idea storage
- `HEP_DATA_DIR`
- `HEP_TOOL_MODE`
- `ZOTERO_BASE_URL`
- `ZOTERO_DATA_DIR`
- `PDG_DB_PATH`

These path-like knobs configure local filesystem roots and caches, not URI/protocol authority. Keep durable research inputs and artifacts under the external project root by passing `project_root` to HEP tools; use `HEP_DATA_DIR` / local temp roots only for one-off checks, CI, migrations, or source files that are not needed later.

### 7.2 Agent/tool namespacing

Some clients expose namespaced tool names such as `mcp__<serverAlias>__<toolName>`. The correct authority is always the exact tool name shown by the client UI.

### 7.3 CLI users

Users can invoke `nullius` directly or use the project-bound `project-mcp` leaf adapter; both reuse the same canonical lifecycle authority.

## 8. Related docs

- [`README.md`](../README.md)
- [`docs/README_zh.md`](./README_zh.md)
- [`docs/TESTING_GUIDE.md`](./TESTING_GUIDE.md)
- [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)
- [`docs/TOOL_CATEGORIES.md`](./TOOL_CATEGORIES.md)

All newly generated managed project runs use `artifacts/runs/<run_id>/`; team and draft executor payloads live in `research_team/` beneath that run. Origin stamps bind the parent run. Historical `team/runs/<run_id>/` remains read-only evidence: status, run listing, index links and export retain its original location, stamps, validity rulings and result references. Reads do not migrate or rewrite it, and `init --runtime-only` reconnects without moving evidence. Unreadable historical locations are reported as unavailable without blocking unrelated readable runs. Duplicate IDs are reported as ambiguous; bare-ID reads refuse ambiguity, and new execution cannot reuse any historical ID. Stamping, backfill, staging, execution and resume cannot write historical run payloads. Use a distinct ID under `artifacts/runs/` for new work. The `inventory_run_relocation.py --fixture-root <anonymous-fixture> --source-manifest <hash-manifest>` helper only inventories pinned fixture bytes, references, collisions and unresolved bindings; it has no apply mode. Independent reviewer snapshots omit every run's executor payload and all workspace trees, retain production artifacts, and allow only each member's own declared output prefix. Historical reports/adjudications remain coordinator evidence. `team/LATEST*.md` and `artifacts/LATEST.md` are navigation pointers.

The generic scaffold creates `project_index.md`; the team helper updates only executor-local latest pointers and requires `nullius init` when the root index is missing. Selected-result and derived-block writers share a short path lock, reread their inputs, and make at most three attempts when edits are detected while preserving human bytes, mode and EOL outside their marked region. Arbitrary writers that ignore the lock remain outside its guarantee. Generic run counts do not interpret execution round limits; the Python executor resolver and suffix gate own those settings.

Existing `PROJECT_INDEX_AUTO` blocks are historical, unmaintained observations; the team helper neither parses nor updates them. Current `RUN_INDEX` navigation and curated result/report registries have separate owners. Do not silently rewrite or delete an old block.

The shared traceability read model exposes `notebook.result_links` for structural
navigation and `notebook.content_review` for current full-text semantic review.
`notebook review --model <SPEC>` executes the existing review-swarm launcher in bounded calls,
with a default hard 1200-second budget and one attempt per call without automatic retry. It
freezes the complete UTF-8 notebook, including the automatic block, and declared
required dependencies by SHA-256 of their actual bytes, including uncommitted
edits. Review reports retain that identity and per-section full-text coverage,
with source-anchored reasons for derivation completeness, logic, notation,
definitions, assumptions, and conventions. Changed bytes make prior acceptance
stale; historical reports stay readable.

`notebook check` returns `structure` and `content_review` separately and succeeds
only when structural navigation passes and the current full-text review is
accepted. `--result` narrows only the structural scope; `--structure-only`
establishes navigation alone. Missing, partial, failed, unavailable, invalid, or
stale reviews never satisfy closeout. File and engine convergence consume the
same current-version contract. Status/current read the reports without executing
a reviewer or blocking ordinary state or historical reads.

Review evidence reuses verification subject/check-run/verdict/coverage and
`ArtifactRef` contracts as a supporting semantic check, never as decisive
computation validation. Links, automatic tables, formula counts, checklists and
author self-assessment cannot determine the content verdict. Semantic acceptance
is bounded by the reviewer's coverage and independence and does not prove
scientific truth or replace result-specific verification.

Valid UTF-8 text remains text regardless of size; Markdown links are discovered
recursively. Binary or invalid UTF-8 linked files are immutable `opaque_links`
snapshots and hash locators, not read evidence. Every opaque path/hash needs a
specific `opaque_sources` assessment; a required unread source prevents acceptance.
Notebook and explicit dependencies require strict UTF-8 and LF or CRLF endings.

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
Only tool mode `none` is accepted. Multiple batches are one semantic review;
they do not establish independent confirmations or a cross-family quorum.

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

Full-access team reproduction uses an explicit separate neutral packet (`--reproduction-packet` or `independent_reproduction.blind_packet`) for both member stages and appends a reproduction-stage system instruction. The full candidate packet remains a coordinator/review input. Source writes are exact model-origin UTF-8 requests within each member's own prefix. Complete original requests, outputs, source dependencies and successful execution receipts feed a new source-assessor invocation. This route does not hide later reads or certify blindness: the assessor must reject contaminated inputs. The consumer requires two genuine independent constructions, not two families or different method labels; declared shared-failure risks require source-grounded method evidence.

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.

Research output preservation, path classification, read-only inventory, commit checks and automatic origin-snapshot admission are described in [Research output storage](RUN_STORAGE.md). No storage command deletes data, rewrites history or expires recovery records.
