# Nullius

English | [中文](./docs/README_zh.md)

> **Nullius in verba** — "take nobody's word for it."
> The Royal Society's motto is both the source of this repo's name and its operating rule: no result stands on authority — a conclusion enters the durable record only after independent re-derivation, clean-room reproduction, and adversarial review.

Nullius is an evidence-first harness for agent-assisted research. It gives AI coding agents (Codex, Claude Code, OpenCode, and similar) a lifecycle and control plane for external research projects, plus checked-in skills that admit a durable result only after independent re-derivation, numerical convergence checks, source-grounded citation verification, and cross-model adversarial review; it is domain-neutral by construction. The repository is one pnpm workspace that combines the `nullius` CLI and control-plane package, research skills under `skills/`, local MCP provider packages, and workflow recipes consumed through `nullius workflow-plan` or agent clients. The root is that domain-neutral substrate and control plane; HEP is the most mature provider family and strongest end-to-end workflow example built on it.


Native computation binds an enabled A3 approval to the current manifest, scripts, declared input and dependency files, resolved executable bytes, production environment and approval policy. Missing packets, unbound historical approvals and changed inputs require fresh root approval before dispatch; a step-only A3 mismatch fails closed without creating a root request. A requested pause lets the current direct child return, preserves its step evidence and stops the run as paused, including after the last step. Native continuation in place is unsupported: same-run execution and `resume --force` refuse without changing the paused attempt; a new separately approved run is a distinct execution. `execution_status.json` persists one absolute deadline covering preflight, later direct children and local outcome publication; retries keep that deadline, and each child receives the smaller remaining or step limit. Hard CPU, memory and disk constraints are rejected during preparation. These limits do not supervise arbitrary descendants or remote jobs. Canonical state writes compare the caller's read snapshot under a short exclusive lock before appending combined events; stale snapshots refuse, and stale locks require quiescent manual repair. CLI and project transport share canonical external-root admission, including uncreated paths beneath existing symlink ancestors.

## 1. Surface Policy

- `nullius` remains the stateful CLI front door for initialized external project roots. Use it for lifecycle state, bounded execution, `workflow-plan`, verification, higher-conclusion gating, main-report structural validation, proposal decisions, and the conversational decision ledger.
- `orch_*` remains the MCP/operator counterpart of that same control plane. It is a host-facing bridge for the control plane, not a competing product identity and not a replacement for the CLI.
- `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, and `zotero_*` remain bounded atomic MCP operators. They stay MCP-first because they are schema-driven provider atoms, not stateful workflow shells that need mass CLI mirroring. `@nullius/hep-mcp` also surfaces these provider tools as entry points inside its own tool set (reusing the provider packages' `tooling`), so a HEP session reaches literature, data, reference, and Zotero access without wiring each provider MCP separately.
- `idea-mcp` remains an experimental runtime bridge onto the restarted, probability-managed `idea-engine` portfolio. It is not a root front door, and its MCP surface is intentionally narrower than the full `idea-engine` runtime contract. The idea-engine search/eval runtime is archived; contracts + store are retained, scoring consumes an external belief-graph posterior (pinned tool, current pin gaia-lang==0.5.0a4), and idea-engine is still not a default capability-expansion lane. The belief, decision, and generation layers around it live in four skills, not in the runtime: `idea-posterior` (decompose an idea into source-grounded sub-criteria, compute a Gaia posterior, write it back), `idea-pairwise-match` (criteria-committed cross-family judged comparison, one capped non-eliminating observation), `idea-allocation` (Thompson-sampling allocation plus activation monitoring), and `idea-generation` (derived idea nodes generated from research-progress evidence deltas — survey tensions, re-anchored gaps, failed-approach entries, and parent-bearing follow-on mutations of existing nodes — imported through the engine's `node.import_generated` as auditable generation packs; retrieval receipts before evidence URIs, mechanical dedup, novelty as a falsifiable closest-prior delta claim, no generator-side scoring).
- `@nullius/hep-mcp` is the current most mature domain pack and strongest end-to-end example built on the domain-neutral root.
- `research-harness` is the thin Codex / Claude Code / OpenCode skill entrypoint for external research projects: it restores `nullius` project state, routes milestone execution to `research-team`, routes Markdown note cleanup to `markdown-hygiene`, routes HEP evidence work to `hep-mcp`, and folds durable results back into project files and artifacts. It is not a new CLI or a second control plane.
- `research_brainstorm` is a checked-in durable harness recipe under `nullius workflow-plan`, not a new top-level CLI command, not the idea-engine, not a full research-team workflow, and not a root front-door expansion.
- `.nullius/HARNESS` is the machine-readable runtime handshake written by `nullius init`; when it is present, agents must obtain an `nullius status --json` receipt before new work, milestone execution, closeout, or handoff.
- Strict fail-closed research quality remains in force. `.nullius/HARNESS`, project-local durable memory, plus `.nullius/` state remain the reconnect truth. Optional support surfaces stay opt-in layers.

## 2. Current Public Surfaces

| Surface | Canonical entrypoint | What it is for |
| --- | --- | --- |
| Stateful CLI front door | `nullius` | External project-root lifecycle state, approvals, bounded native TS `run --workflow-id computation`, stateful `workflow-plan` persistence, main-report structural validation, and `graph` dependency-map rendering (claims / progress / literature / roadmap) |
| Control-plane MCP/operator counterpart | `orch_*` | Host-facing MCP/operator surface for the same lifecycle/control-plane authority |
| Project-bound MCP adapter | [`@nullius/project-mcp`](./packages/project-mcp/README.md) | Local stdio leaf adapter for canonical control-plane operations and bounded project-file transport, bound by `NULLIUS_PROJECT_ROOT` |
| Stateful literature planning | `nullius workflow-plan` | Checked-in workflow authority resolved via `@nullius/literature-workflows`, persisted to `.nullius/state.json#/plan`, and rendered to `.nullius/plan.md` |
| Agent research project harness skill | `research-harness` | Thin client skill for Codex / Claude Code / OpenCode to recover external project state, route work to `nullius`, `research-team`, `markdown-hygiene`, and `hep-mcp`, and fold results back into durable project artifacts |
| Experimental idea runtime bridge | `node /absolute/path/to/nullius/packages/idea-mcp/dist/server.js` | TS-hosted campaign lifecycle bridge for `idea_campaign_*` on explicit external data roots; posterior-based rank/promote, node posterior/lifecycle/grounding-audit/card-revision updates, provenance correction, and generation-pack import (`node.import_generated`) remain `idea-engine` runtime-contract truth, not a root front door |
| Current most mature domain MCP front door | `node /absolute/path/to/nullius/packages/hep-mcp/dist/index.js` | HEP domain MCP server for literature research and provider-local composition; its research-output tools write their files into a caller-chosen `output_dir` inside the project |
| Bounded provider MCP operators | `@nullius/openalex-mcp`, `@nullius/arxiv-mcp`, `@nullius/hepdata-mcp`, `@nullius/pdg-mcp`, `@nullius/zotero-mcp` | Atomic literature, data, reference, and evidence operators that stay MCP-first |

The live HEP tool inventory is code-owned and mode-filtered by `HEP_TOOL_MODE`; keep exact counts in the generated category/status docs rather than this README.

## 3. Layer Model

| Layer | Current authority | Why it stays here |
| --- | --- | --- |
| Workflow authority | checked-in recipes consumed by `nullius workflow-plan` | High-level workflow meaning lives above provider packs |
| Stateful control plane | `nullius` plus `orch_*` | Persistent project/run state, approvals, bounded execution, verification, and read models belong to one shared control plane |
| Agent project harness | `research-harness` skill | Host-client guidance for recovery, routing, verification, and handoff; it delegates execution to the control plane and domain/executor layers |
| Experimental runtime bridge | `idea-mcp` | Runtime bridge stays explicit and narrower than the full engine contract |
| Domain workflow pack | `@nullius/hep-mcp`, `hep_*` | Current strongest end-to-end example without becoming root identity |
| Provider atoms | `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*` | Bounded, schema-driven MCP operators are easier to compose than provider-local CLI mirrors |
| Project-local truth | `.nullius/` plus durable memory files | Reconnect truth stays with the external project root, not the development repo |

Within project-local truth, `research_plan.md#Current Status` is the human status entry and should stay concise, while `research_notebook.md` is the living logical narrative. Neither is the immutable main research report. A promoted report is a complete researcher-facing account under `reports/`; `project_index.md#Main research report` is its single current entry point and supersession registry. At result granularity, `project_index.md#Current results` plays the same registry role for headline results: each current row names the run that produced the value and that run's exact code identity, runs bind to commits through origin stamps in the append-only validity ledger, and `nullius current` renders the whole answer — current results, producing revision, manuscript pointer, notebook-section staleness, and which runs are still valid versus superseded or voided — as prose a human reads directly. Machine JSON, hashes, and receipts bind provenance but never replace explanatory narrative or clickable human-readable evidence. Run `nullius report-validate` before promotion: it checks structure, immutable hashes, links, validation classification, and supersession consistency, but its pass does not establish scientific sufficiency. Literature notes for important sources must be full-text/source-first with auditable section/page/equation/figure coverage and LaTeX math notation. Keep dated run logs, raw workflow summaries, and tool-use traces in `research_plan.md` progress entries or `artifacts/runs/<run_id>/`, then fold durable insights back into the notebook.

Skill source and distribution are separate surfaces:

- `skills/` holds checked-in skill source and manuals.
- For Julia computational libraries, [`julia-package`](skills/julia-package/SKILL.md) covers APIs, numerical contracts and package lifecycle; [`julia-perf`](skills/julia-perf/SKILL.md) covers kernel discipline and reproducible performance evidence.
- `packages/skills-market` is the installer/distribution control plane; it does not mean those skills are preinstalled in a client runtime.
- `research-harness` is the market-listed thin entry skill for external research projects. Its market entry declares `research-team`, `markdown-hygiene` and other skill packs in `depends_on` (installed with it unless `--no-deps` is passed) and `hep-mcp` as a non-skill dependency that the installer only reports as a preflight warning (a hard failure only with `--strict-deps`); those remain separate capabilities that the host client may already provide or install independently.

For the project's non-surface guarantees — what Nullius is *not*, which agent failure modes it defends against (M1–M7 + long-conversation drift), how those guarantees are enforced by anti-drift CI, and which borrowed concepts were considered and rejected — see [`docs/POSITIONING.md`](./docs/POSITIONING.md).

## 4. Where Do Files, Artifacts, and State Live

### `hep-mcp` data root

`@nullius/hep-mcp` resolves its data root per tool call. If a tool call includes `project_root` for an initialized nullius project, HEP state is stored under `<project_root>/artifacts/hep-mcp`. Otherwise it uses `HEP_DATA_DIR` when set, then falls back to `~/.nullius/hep-mcp` for scratch/temporary checks.

```text
<resolved HEP data root>/
  cache/
  downloads/
  pdg/
```

- `hep-mcp` keeps no runs of its own: runs, approvals, and lifecycle belong to the orchestrator under `<project_root>/artifacts/runs/<run_id>/`. The HEP research-output tools (search exports, identifier mappings, Zotero mappings, LaTeX parses, conflict maps) write their files into a caller-chosen `output_dir` inside the project root, typically a subdirectory of the current run directory, and return project-relative paths. `output_dir` requires `project_root`, may not be the project root itself or traverse a symbolic link below it, and may not lie under `.nullius/`, `team/runs/`, or `artifacts/hep-mcp/` (compared ignoring letter case); a call never replaces an existing file. Downloads made by `inspire_paper_source`, caches and PDG data stay in hep-mcp's data root (`<project_root>/artifacts/hep-mcp` or `HEP_DATA_DIR`).
- Historical HEP run directories (`runs/<run_id>/` under the HEP data root) and paper/evidence project directories (`projects/<project_id>/`, including evidence catalogs) from earlier versions are evidence: they stay readable in place and no tool creates or rewrites them. [`docs/URI_REGISTRY.md`](./docs/URI_REGISTRY.md) gives the reading rules for historical `hep://runs/...` and `hep://projects/...` references.
- `PDG_DATA_DIR` is the PDG-local companion root. If unset, it follows the resolved HEP data root at `<resolved HEP data root>/pdg`.
- Text and binary artifacts remain on disk under package-owned artifact roots; tool results stay compact and point back to project artifacts instead of inlining large payloads.
- Paper originals, extracted text, arXiv source tarballs, and source trees are ordinary local files. If they are only needed during the current check, keep them in a local temporary directory; if later verification or continuation needs them, place them under the external project root in the appropriate project/run artifact directory.

### Generic lifecycle state

`nullius init` bootstraps a real external project root and creates `.nullius/HARNESS` plus `.nullius/` there. The current lifecycle package reads and writes:

```text
<project_root>/
  .nullius/
    HARNESS
    state.json
    ledger.jsonl
    decisions.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json          # when fleet features are in use
    fleet_workers.json        # when fleet features are in use
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
```

Approval packets are materialized under the run's `artifacts/runs/<run_id>/approvals/<approval_id>/approval_packet_v1.json` path and consumed through lifecycle commands.

The durable truth here should be understood as two layers that hold together:

- lifecycle / plan / approval state under `.nullius/`
- project-local durable memory such as `research_plan.md`, `research_contract.md`, `research_notebook.md` once it has substantive content, and immutable registered reports under `reports/`

Surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` are opt-in support layers, created later by explicit project need or host-specific tooling rather than the default working front door.

## 5. How Does a User Connect from MCP Clients / Agent Clients

The current MCP connection story is local stdio. [`project-mcp`](./packages/project-mcp/README.md) is a leaf adapter bound to one external project by `NULLIUS_PROJECT_ROOT`; it delegates to the canonical orchestrator tool dispatcher and CLI. There is still no single monolithic generic root MCP server: `nullius` remains the stateful front door, and HEP and idea servers retain their separate responsibilities.

Current public MCP contract: local stdio process launch, tool `inputSchema`, compact JSON/text tool results, and no prompts. Research material placement is filesystem-first: transient fetches stay in local temp, while material needed for verification or continuation becomes a project/run artifact. `orch_*` is an operator/tool inventory exposed by the orchestrator package; it is not a separately packaged root MCP server. Remote MCP transports, OAuth, and registry publishing remain future deployment work outside the current local-stdio contract.

The [local personal-plugin builder](./packages/skills-market/docs/PERSONAL_PLUGIN.md) copies the existing skills and generates Codex and Claude Code manifests with `project-mcp`, `hep-mcp`, and `idea-mcp`; it does not register the atomic providers again. Both ordinary installation and the plugin resolve runtime packages through the installed `nullius` CLI. Generated manifests and skill metadata contain no build-machine paths. Configure project, provider and data paths in the host environment or private `${XDG_CONFIG_HOME:-$HOME/.config}/nullius/runtime.json`; `NULLIUS_RUNTIME_CONFIG` can select another absolute file outside the distribution. Project and idea servers require an external project, and idea also requires `IDEA_MCP_DATA_DIR`; HEP can run standalone. A configured project becomes the server working directory. External tools remain local dependencies. Project-file access is bounded, while executed local scripts remain trusted code without an OS sandbox. Approval decisions stay on the local host; model sampling requires a supporting client and a live foreground connection, otherwise it is `unavailable`. Local execution and composition are tested; ChatGPT Chat/Work and Claude-host connections remain untested, with any required tunnel and app ID left for user configuration. No app connection or marketplace publication is created by the builder.

Universal MCP config pattern:

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/nullius/packages/hep-mcp/dist/index.js"
      ],
      "env": {
        "HEP_DATA_DIR": "~/.nullius/hep-mcp",
        "HEP_TOOL_MODE": "standard",
        "ZOTERO_BASE_URL": "http://127.0.0.1:23119"
      }
    }
  }
}
```

Notes:

- Build first: `pnpm -r build`.
- MCP environment paths are filesystem roots, not URI/protocol settings. For durable nullius project work, pass the initialized `project_root` in HEP tool calls so hep-mcp's downloads, caches and PDG data go under `<project_root>/artifacts/hep-mcp` and file outputs go into the `output_dir` you name inside the project. Keep `HEP_DATA_DIR` as a scratch fallback or explicit override for one-off checks, CI, and migrations.
- If `nullius` is not on `PATH`, create a local wrapper after building:

```bash
mkdir -p "$HOME/.local/bin"
ln -sf /absolute/path/to/nullius/packages/orchestrator/dist/cli.js "$HOME/.local/bin/nullius"
chmod +x "$HOME/.local/bin/nullius"
nullius --help
```

  This repository is currently a local workspace, not a published global npm CLI. The wrapper above is the normal source-checkout install path for agent clients that can execute shell commands. A project-local launcher is also written during `nullius init`, so already-initialized research folders can continue with `./.nullius/bin/nullius status --json` even when the global wrapper is absent.
- GUI apps sometimes need an absolute Node path instead of bare `node`.
- Some clients namespace tool names as `mcp__<serverAlias>__<toolName>`. Always call the exact tool name shown by the client.
- Typical MCP-compatible clients include Cursor, Claude Desktop, Claude Code CLI, Chatbox, Cherry Studio, Continue, Cline, and Zed.
- The lifecycle CLI is separate from MCP client setup:

```bash
nullius init --project-root /absolute/path/to/external-project
nullius status --project-root /absolute/path/to/external-project
```

- For Codex, Claude Code, OpenCode, Cursor, Kimi-code, or similar agent clients, use one idempotent startup instruction for both first use and later recovery:

```text
You are in a folder that should be managed by nullius.
First determine whether it is already initialized.

If .nullius/HARNESS exists, obtain a status receipt before doing any work:
./.nullius/bin/nullius status --json
If the project-local launcher is unavailable, run:
nullius status --json

If .nullius/ exists but .nullius/HARNESS is missing, run status first if possible,
then repair the runtime handshake with:
nullius init --runtime-only

If AGENTS.md and .nullius/HARNESS are both missing, initialize the project:
nullius init
Then read the generated AGENTS.md and run:
./.nullius/bin/nullius status --json

To restore a missing AGENTS.md while preserving existing project instructions,
preview then apply:
nullius init --refresh --dry-run
nullius init --refresh

Refresh preserves an existing AGENTS.md byte-for-byte when it differs from the current template. Template changes do not automatically update existing projects. To update guidance, render a current scaffold in an anonymous temporary external root and manually merge the desired changes, including notebook review instructions, into the existing user-owned files. Refresh may synchronize existing machine-managed notebook and index blocks, while preserving user-owned content and not inserting missing blocks. It does not migrate user-owned report files. For a project that predates
the main-report registry, checkpoint it, render a current scaffold in a separate
temporary external root with `nullius init --project-root <temporary-root>`, copy
only a missing reports/main_research_report_template.md, and manually merge the
temporary project_index.md#Main research report section into the existing index.
report-validate fails closed with invalid_registry_markers before that merge and
with no_current_report until a complete current report is registered.

If `nullius` is not available, first prepare the CLI from the source checkout
as described in this README, then retry the same startup sequence.

Use research-harness if your agent supports it. Treat nullius as the lifecycle
authority, research-team as the milestone executor, and fold stable results back into
research_contract.md, research_plan.md#Current Status, and artifacts/runs/<run_id>/.
Promote a complete immutable report through project_index.md#Main research report,
then run: nullius report-validate
Stamp each run's code origin at creation with: nullius trace stamp <run_dir>
Retry a resultless crash under the same run id with: nullius trace retry <run_dir>
Record replacements with: nullius trace supersede <old> --by <new> --reason "..."
Register headline results with: nullius result set-current <result-id> --run <run_id> --artifact <path>
Read the whole current-version answer as prose with: nullius current
Keep the notebook's machine-maintained current-state block fresh with: nullius notebook sync
Keep the project's machine-maintained run index fresh with: nullius index sync
Export a public code snapshot (excluding run products and internal notes) with: nullius release <target-dir>
Declare (or re-declare) where project truth lives with: nullius init --mode=engine|file
(file mode: work executed by hand or external runners; run_status staying idle is normal)
Record decisions made in conversation with: nullius decision record "<what was decided>"
Log open questions with: nullius decision pending "<question>"
Close an open question with: nullius decision record "<answer>" --resolves <id>
Link non-closing context with: nullius decision record "<what was decided>" --relates <id>
After branch entries reach the authoritative trunk, assign durable D<n> ids with:
nullius decision land
Open questions stay counted in every status receipt (oldest ten itemized; the rest
via: nullius decision list) until resolved.
```

  New decision entries use six-character branch-local handles drawn from 30 unbiased random bits ($32^6 = 2^{30}$). Candidates that also spell durable `D<n>` ids, plus locally known ids and retained mappings, are redrawn; the exact pair-collision probability is therefore context-dependent. With no local reservations it is $1/(2^{30}-90{,}000)\approx 9.314\times 10^{-10}$, slightly above $2^{-30}$. This is probabilistic, not structural; collisions fail closed. `--resolves` is the closing relation and accepts only an open `pending` target; `--relates` records non-closing context and may point to an earlier readable `decided` or `pending` entry. A malformed persisted relation is reported under `unrecognized_relations` and ignored without voiding its record. A legacy or unknown non-empty string `kind` remains readable under current `decided` semantics, with its original spelling exposed through `source_kind` and `normalized_kinds`; only the exact persisted `pending` kind creates an open item, while an otherwise valid `resolves` on a normalized entry still closes its pending target. `decision land` atomically assigns the next durable `D<n>` values, rewrites handle-valued relations, and retains each mapping as `provisional_id`. Existing `D<n>` ledgers remain valid and resolvable without migration. If one retained provisional id maps to multiple entries or is reused as a current id, list/status name the conflicting lines and landing fails without changing the ledger. Once initialized, reconnect is local-first: `.nullius/HARNESS`, `.nullius/bin/nullius`, `AGENTS.md`, `project_index.md`, `research_plan.md`, `research_contract.md`, registered reports, and `artifacts/runs/<run_id>/` are enough for an agent to recover the project state after a closed session or a network outage. Network access is only needed for tasks that actually fetch external sources.

- For stateful literature workflows, first initialize the target external project root with `nullius init`, then use `nullius workflow-plan` from that root or with `--project-root`. It resolves recipes directly via `@nullius/literature-workflows`, persists `.nullius/state.json#/plan`, and derives `.nullius/plan.md`. Pass an explicit `--run-id` for meaningful external research runs; if omitted, the derived `<recipe>-<phase>` id is only a planning placeholder. `research_brainstorm` is the lightweight planning-only durable harness form: `nullius workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"` records brainstorm context, candidate angles, screening, one recommendation, and a `next_contract` handoff. `.nullius/plan.md` is a human read model rather than machine orchestration SSOT. The contract may suggest a heavier follow-up recipe such as `literature_landscape` or `literature_gap_analysis`, but it does not start that recipe automatically and it does not depend on any host-native thinking process. The persisted `research_brainstorm.*` step tools are handoff authority, not built-in runtime tools, unless a future external tool caller explicitly implements them. Any checked-in Python workflow consumers remain maintainer/eval proof only and are not a second front-door shell.
- Delegated agent execution is now durable at the tool boundary: attempts are recorded as `not_started`, `outcome_unknown`, or `committed`, unknown side effects stop for operator reconciliation, and exact committed MCP results are replayed without re-dispatch. Its journals live in structurally separate `artifacts/delegated-runs/direct/<run_id>/` and `artifacts/delegated-runs/team/<runtime_run_id>/` namespaces, so caller-chosen root or direct run ids cannot alias team checkpoints. Approval resolvers remain host/operator-only. When `nullius run` launches a configured stdio MCP server, non-secret settings use `NULLIUS_RUN_MCP_ENV_JSON`, secrets use `NULLIUS_RUN_MCP_CREDENTIALS_JSON`, and mandatory names may be declared with `NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON`; missing required values fail before spawn.

Persisted workflow-plan execution also journals each dispatch under `artifacts/runs/<run_id>/manifest.json`. An interrupted unknown outcome requires reconciliation; a committed response is replayed without another tool call. Pause is checked at dispatch boundaries, and an approval request keeps its step unfinished until canonical approval permits execution. Overflow recovery retains original user instructions verbatim and complete tool exchanges; an instruction that alone exceeds the window is not silently truncated.

## 6. Where Are Deeper Architecture / Governance Docs

- [Architecture Overview](./docs/ARCHITECTURE.md)
- [Testing Guide](./docs/TESTING_GUIDE.md)
- [Project Status](./docs/PROJECT_STATUS.md)
- [Tool Categories](./docs/TOOL_CATEGORIES.md)
- [Chinese README](./docs/README_zh.md)
- [Repo Governance](./AGENTS.md)
- [Development Contract](./meta/ECOSYSTEM_DEV_CONTRACT.md)

Maintainer-only redesign plans, remediation trackers, execution prompts, and local legacy workflow notes are intentionally kept out of the public repository surface.

## Quick Start

```bash
pnpm install
pnpm -r build
pnpm --filter @nullius/hep-mcp docs:tool-counts:check
```

If you want the generic lifecycle/control-plane smoke path first:

1. `nullius init --project-root /absolute/path/to/external-project`
1. `nullius status --project-root /absolute/path/to/external-project`
1. After a completed run has declared evidence and a decisive checker, run the complete verification command (repeat the evidence/reference/dimension/control flags when needed):

   ```bash
   nullius verify --project-root /absolute/path/to/external-project --run-id <run_id> --status passed --summary "operator expectation note" --evidence-path computation/outputs/result.json --checker-path verification/decisive_checker.py --checker-runtime python3 --quantity-id quantity:declared-result --layer-id layer:production-output --reference-provenance-json '{"reference_id":"reference:oracle-v1","uri":"rep://runs/<run_id>/artifact/references%2Foracle.json","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}' --disputed-dimension normalization --required-negative-control-id negative-control:zero-input
   ```

   Replace the 64-zero example with the actual lowercase SHA-256 of the declared reference; run `nullius verify --help` for the complete flag contract. The CLI status is an expectation that must match the checker verdict; the CLI summary is a non-authoritative note; the matching checker-emitted status, summary, and check kind are recorded. Nullius stores adjacent production snapshots and checks that the checker self-reports observations matching internally held output hashes. A recorded pass does not prove that the checker actually read an output or executed a named negative control. The dependency/import closure is literally incomplete (not syscall traced and not installed-byte or isolated-image bound).
1. Run `nullius final-conclusions --project-root /absolute/path/to/external-project --run-id <run_id>` to inspect the fail-closed boundary. It currently supports exactly one canonical subject and returns `unavailable` because every current validation binding declares incomplete dependency closure. No A5 approval is created or unlockable on this path.

If you want the current strongest domain-pack smoke path next, connect your MCP client to `packages/hep-mcp/dist/index.js` and run:

1. Call `hep_health`.
1. For durable project work, pass `project_root=/absolute/path/to/external-project` on each HEP tool call.
1. Call `hep_inspire_search_export` with `project_root` and an `output_dir` such as `artifacts/runs/<run_id>/literature`; inspect the returned project-relative `export_path` / `meta_path` and the per-call external API records under `<output_dir>/external_api/`.

Runs, generic lifecycle, and approval remain orchestrator-owned. `hep-mcp` provides no project or evidence catalog, draft rendering, project export, or paper bundling tools; read paper sources with `arxiv_paper_source` / `inspire_paper_source` and record what you check against them in the project's own notes.

## Documentation

- [Feature Testing Guide](./docs/TESTING_GUIDE.md)
- [Project Status](./docs/PROJECT_STATUS.md)
- [Architecture Overview](./docs/ARCHITECTURE.md)
- [pdg-mcp Docs](./packages/pdg-mcp/README.md)

## Development

For front-door drift, start with:

- `packages/hep-mcp/tests/docs/docToolDrift.test.ts`
- `pnpm --filter @nullius/hep-mcp docs:tool-counts:check`
- `pnpm --filter @nullius/hep-mcp test -- tests/docs/docToolDrift.test.ts`

## Citation

If Nullius contributed to your work, please cite the version you used. Every GitHub release is archived on Zenodo and receives its own DOI; the DOI for the current release is recorded in [`CITATION.cff`](./CITATION.cff) (GitHub renders it under "Cite this repository"). Until the first archived release is published, cite the repository directly:

```bibtex
@software{nullius,
  author  = {Guo, Feng-Kun},
  title   = {Nullius: an evidence-first harness for agent-assisted research},
  year    = {2026},
  version = {0.6.0},
  url     = {https://github.com/fkguo/nullius}
}
```

## License

MIT

All newly generated managed project runs use `artifacts/runs/<run_id>/`; team and draft executor payloads live in `research_team/` beneath that run. Origin stamps bind the parent run. Historical `team/runs/<run_id>/` remains read-only evidence: status, run listing, index links and export retain its original location, stamps, validity rulings and result references. Reads do not migrate or rewrite it, and `init --runtime-only` reconnects without moving evidence. Unreadable historical locations are reported as unavailable without blocking unrelated readable runs. Duplicate IDs are reported as ambiguous; bare-ID reads refuse ambiguity, and new execution cannot reuse any historical ID. Stamping, backfill, staging, execution and resume cannot write historical run payloads. Use a distinct ID under `artifacts/runs/` for new work. The `inventory_run_relocation.py --fixture-root <anonymous-fixture> --source-manifest <hash-manifest>` helper only inventories pinned fixture bytes, references, collisions and unresolved bindings; it has no apply mode. Independent reviewer snapshots omit every run's executor payload and all workspace trees, retain production artifacts, and allow only each member's own declared output prefix. Historical reports/adjudications remain coordinator evidence. `team/LATEST*.md` and `artifacts/LATEST.md` are navigation pointers.

The generic scaffold creates `project_index.md`; the team helper updates only executor-local latest pointers and requires `nullius init` when the root index is missing. Selected-result and derived-block writers share a short path lock, reread their inputs, and make at most three attempts when edits are detected while preserving human bytes, mode and EOL outside their marked region. Arbitrary writers that ignore the lock remain outside its guarantee. Generic run counts do not interpret execution round limits; the Python executor resolver and suffix gate own those settings.

Existing `PROJECT_INDEX_AUTO` blocks are historical, unmaintained observations; the team helper neither parses nor updates them. Current `RUN_INDEX` navigation and curated result/report registries have separate owners. Do not silently rewrite or delete an old block.

At scientific result closeout, update the human notebook, run
`nullius notebook review --model claude/opus` with its required dependencies, then
`nullius notebook check --json`. The check reports structural
links and current full-text content review separately; `--result` scopes only
the links. File and engine mode require the same accepted current review.
Automatic tables, links, formula counts, checklists, and writing self-assessment
cannot supply that verdict. `--structure-only` establishes navigation alone;
semantic acceptance does not prove scientific truth. See
[human notebook integration](packages/orchestrator/README.md#human-notebook-integration)
for frozen-input, coverage, execution, and independence requirements.

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.
The default structural check requires a present, valid result registry and
validates every registered row, including superseded rows. Only current results
create human-section link obligations. Ordinary status and history reads remain
available when the closeout check fails.

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

An enabled full-access team reproduction gate requires a separate neutral question and original inputs through `--reproduction-packet` or `independent_reproduction.blind_packet` in `research_team_config.json`. Both member stages use the frozen neutral packet and reproduction instructions; the full candidate packet remains available to the coordinator. Members construct complete source through audited `files_written` requests. A fresh source assessor checks all actual inputs, construction, execution, applicability and diagnostic limits. Two sound independent constructions may use the same method and model family; diversity is recorded separately. Imported assessments, author checkboxes, polluted inputs and original-code reruns cannot supply current confirmations.

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.

Research output preservation, path classification, read-only inventory, commit checks and automatic origin-snapshot admission are described in [Research output storage](docs/RUN_STORAGE.md). No storage command deletes data, rewrites history or expires recovery records.
