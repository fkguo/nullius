# Autoresearch Lab

English | [中文](./docs/README_zh.md)

Autoresearch Lab is a domain-neutral, evidence-first research monorepo. Today it combines a generic lifecycle/control-plane package, local MCP provider packages, and checked-in workflow recipes that can be consumed through `autoresearch workflow-plan` or internal agent clients. HEP is the current most mature provider family and the strongest end-to-end workflow example in the repo, but it is not the root product identity.

## 1. Surface Policy

- `autoresearch` remains the stateful CLI front door for initialized external project roots. Use it for lifecycle state, bounded execution, `workflow-plan`, verification, higher-conclusion gating, and proposal decisions.
- `orch_*` remains the MCP/operator counterpart of that same control plane. It is a host-facing bridge for the control plane, not a competing product identity and not a replacement for the CLI.
- `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, and `zotero_*` remain bounded atomic MCP operators. They stay MCP-first because they are schema-driven provider atoms, not stateful workflow shells that need mass CLI mirroring.
- `idea-mcp` remains an experimental runtime bridge. It is not a root front door, and its MCP surface is intentionally narrower than the full `idea-engine` runtime contract. The current idea-engine phase is closed; do not treat it as a default capability-expansion lane.
- `@autoresearch/hep-mcp` remains the current most mature domain pack and strongest end-to-end example, but HEP does not define the root product identity.
- `research-harness` is the thin Codex / Claude Code / OpenCode skill entrypoint for external research projects: it restores `autoresearch` project state, routes milestone execution to `research-team`, routes Markdown note cleanup to `markdown-hygiene`, routes HEP evidence work to `hep-mcp`, and folds durable results back into project files and artifacts. It is not a new CLI or a second control plane.
- `research_brainstorm` is a checked-in durable harness recipe under `autoresearch workflow-plan`, not a new top-level CLI command, not the idea-engine, not a full research-team workflow, and not a root front-door expansion.
- Strict fail-closed research quality remains in force. Project-local durable memory plus `.autoresearch/` state remain the reconnect truth. Optional support surfaces stay opt-in layers.

## 2. Current Public Surfaces

| Surface | Canonical entrypoint | What it is for |
| --- | --- | --- |
| Stateful CLI front door | `autoresearch` | External project-root lifecycle state, approvals, bounded native TS `run --workflow-id computation`, and stateful `workflow-plan` persistence |
| Control-plane MCP/operator counterpart | `orch_*` | Host-facing MCP/operator surface for the same lifecycle/control-plane authority |
| Stateful literature planning | `autoresearch workflow-plan` | Checked-in workflow authority resolved via `@autoresearch/literature-workflows`, persisted to `.autoresearch/state.json#/plan`, and rendered to `.autoresearch/plan.md` |
| Agent research project harness skill | `research-harness` | Thin client skill for Codex / Claude Code / OpenCode to recover external project state, route work to `autoresearch`, `research-team`, `markdown-hygiene`, and `hep-mcp`, and fold results back into durable project artifacts |
| Experimental idea runtime bridge | `node /absolute/path/to/autoresearch-lab/packages/idea-mcp/dist/server.js` | TS-hosted campaign runtime bridge for `idea_campaign_*`, `idea_search_step`, and `idea_eval_run` on explicit external data roots; post-search rank/promote and bounded negative failure-library reflection remain `idea-engine` runtime-contract truth, not a root front door |
| Current most mature domain MCP front door | `node /absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js` | HEP domain MCP server for research, evidence, writing, export, and provider-local composition |
| Bounded provider MCP operators | `@autoresearch/openalex-mcp`, `@autoresearch/arxiv-mcp`, `@autoresearch/hepdata-mcp`, `@autoresearch/pdg-mcp`, `@autoresearch/zotero-mcp` | Atomic literature, data, reference, and evidence operators that stay MCP-first |

The live HEP tool inventory is code-owned and mode-filtered by `HEP_TOOL_MODE`; keep exact counts in the generated category/status docs rather than this README.

## 3. Layer Model

| Layer | Current authority | Why it stays here |
| --- | --- | --- |
| Workflow authority | checked-in recipes consumed by `autoresearch workflow-plan` | High-level workflow meaning lives above provider packs |
| Stateful control plane | `autoresearch` plus `orch_*` | Persistent project/run state, approvals, bounded execution, verification, and read models belong to one shared control plane |
| Agent project harness | `research-harness` skill | Host-client guidance for recovery, routing, verification, and handoff; it delegates execution to the control plane and domain/executor layers |
| Experimental runtime bridge | `idea-mcp` | Runtime bridge stays explicit and narrower than the full engine contract |
| Domain workflow pack | `@autoresearch/hep-mcp`, `hep_*`, `hep://...` | Current strongest end-to-end example without becoming root identity |
| Provider atoms | `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*` | Bounded, schema-driven MCP operators are easier to compose than provider-local CLI mirrors |
| Project-local truth | `.autoresearch/` plus durable memory files | Reconnect truth stays with the external project root, not the development repo |

Within project-local truth, `research_plan.md#Current Status` is the human status entry: keep the final target, current phase, completion state, blocker, next step, stop condition, and evidence pointers readable before the longer task board and log. `research_notebook.md` is the human-facing logical narrative: organize it by the evolving research problem, derivations, claims, and uncertainties, not by status tracking. Literature notes for important sources must be full-text/source-first with auditable section/page/equation/figure coverage and LaTeX math notation. Keep dated run logs, raw workflow summaries, and tool-use traces in `research_plan.md` progress entries or `artifacts/runs/<run_id>/`, then fold durable insights back into the notebook. Human-facing `run_id` values should be safe, sortable, readable research identifiers such as `20260502T023000Z-m3-branch-scan-r1`; provider UUIDs or `run_<uuid>` values are machine/provider provenance, not recommended project artifact roots.

Skill source and distribution are separate surfaces:

- `skills/` holds checked-in skill source and manuals.
- `packages/skills-market` is the installer/distribution control plane; it does not mean those skills are preinstalled in a client runtime.
- `research-harness` is the market-listed thin entry skill for external research projects. It intentionally has no hard package dependency on `research-team`, `markdown-hygiene`, or `hep-mcp`; those remain separate capabilities that the host client may already provide or install independently.

## 4. Where Do Artifacts, Resources, and State Live

### `hep-mcp` data root

`@autoresearch/hep-mcp` stores local state under `HEP_DATA_DIR`, which defaults to `~/.hep-mcp`.

```text
<HEP_DATA_DIR>/
  cache/
  downloads/
  projects/<project_id>/
    project.json
    artifacts/
    papers/<paper_id>/
      paper.json
      evidence/
  runs/<run_id>/
    manifest.json
    artifacts/
```

- Project roots are created under `projects/<project_id>/...`.
- Run state lives under `runs/<run_id>/manifest.json` and `runs/<run_id>/artifacts/...`.
- `PDG_DATA_DIR` is the PDG-local companion root and commonly sits at `<HEP_DATA_DIR>/pdg`.
- Text artifacts are read directly through MCP resources; binary artifacts return metadata by default so the client does not inline large payloads.

### Current resource schemes

`@autoresearch/hep-mcp` currently exposes a small "iceberg" resource list plus templates:

- `hep://projects`
- `hep://runs`
- `hep://projects/{project_id}`
- `hep://projects/{project_id}/papers`
- `hep://projects/{project_id}/artifact/{artifact_name}`
- `hep://projects/{project_id}/papers/{paper_id}`
- `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog`
- `hep://runs/{run_id}/manifest`
- `hep://runs/{run_id}/artifact/{artifact_name}`
- `pdg://info`
- `pdg://artifacts`
- `pdg://artifacts/{artifact_name}`

### Generic lifecycle state

`autoresearch init` bootstraps a real external project root and creates `.autoresearch/` there. The current lifecycle package reads and writes:

```text
<project_root>/
  .autoresearch/
    state.json
    ledger.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json          # when fleet features are in use
    fleet_workers.json        # when fleet features are in use
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
```

The orchestrator read model also surfaces approval packet URIs such as `orch://runs/{run_id}/approvals/{approval_id}`.

## 5. How Does a User Connect from MCP Clients / Agent Clients

The current MCP connection story is local stdio only. There is not yet a single monolithic generic root MCP server binary; today the most mature domain MCP entrypoint is `hep-mcp`, while the generic control plane is split across the `autoresearch` CLI and the canonical public `orch_*` MCP/operator surface described in [`meta/docs/orchestrator-mcp-tools-spec.md`](./meta/docs/orchestrator-mcp-tools-spec.md). In other words, generic lifecycle/control-plane work is no longer CLI-only even though it does not ship as a separate root MCP server process.

Current public MCP contract: local stdio process launch, tool `inputSchema`, compact JSON/text tool results, selected package-owned resources, and no prompts. `orch_*` is an operator/tool inventory exposed by the orchestrator package; it is not a separately packaged root MCP server. Remote MCP transports, OAuth, and registry publishing remain future deployment work outside the current local-stdio contract.

Universal MCP config pattern:

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js"
      ],
      "env": {
        "HEP_DATA_DIR": "/absolute/path/to/hep-data",
        "HEP_TOOL_MODE": "standard",
        "ZOTERO_BASE_URL": "http://127.0.0.1:23119"
      }
    }
  }
}
```

Notes:

- Build first: `pnpm -r build`.
- GUI apps sometimes need an absolute Node path instead of bare `node`.
- Some clients namespace tool names as `mcp__<serverAlias>__<toolName>`. Always call the exact tool name shown by the client.
- Typical MCP-compatible clients include Cursor, Claude Desktop, Claude Code CLI, Chatbox, Cherry Studio, Continue, Cline, and Zed.
- The lifecycle CLI is separate from MCP client setup:

```bash
autoresearch init --project-root /absolute/path/to/external-project
autoresearch status --project-root /absolute/path/to/external-project
```

- For stateful literature workflows, first initialize the target external project root with `autoresearch init`, then use `autoresearch workflow-plan` from that root or with `--project-root`. It resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`. Pass an explicit `--run-id` for meaningful external research runs; if omitted, the derived `<recipe>-<phase>` id is only a planning placeholder. `research_brainstorm` is the lightweight planning-only durable harness form: `autoresearch workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"` records brainstorm context, candidate angles, screening, one recommendation, and a `next_contract` handoff. `.autoresearch/plan.md` is a human read model rather than machine orchestration SSOT. The contract may suggest a heavier follow-up recipe such as `literature_landscape`, `literature_gap_analysis`, `derivation_cycle`, or `review_cycle`, but it does not start that recipe automatically and it does not depend on any host-native thinking process. The persisted `research_brainstorm.*` step tools are handoff authority, not built-in runtime tools, unless a future external tool caller explicitly implements them. Any checked-in Python workflow consumers remain maintainer/eval proof only and are not a second front-door shell.

## 6. Where Are Deeper Architecture / Governance Docs

- [Architecture Overview](./docs/ARCHITECTURE.md)
- [Testing Guide](./docs/TESTING_GUIDE.md)
- [Project Status](./docs/PROJECT_STATUS.md)
- [Tool Categories](./docs/TOOL_CATEGORIES.md)
- [URI Registry](./docs/URI_REGISTRY.md)
- [Chinese README](./docs/README_zh.md)
- [Repo Governance](./AGENTS.md)
- [Development Contract](./meta/ECOSYSTEM_DEV_CONTRACT.md)

Maintainer-only redesign plans, remediation trackers, execution prompts, and local legacy workflow notes are intentionally kept out of the public repository surface.

## Quick Start

```bash
pnpm install
pnpm -r build
pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check
```

If you want the generic lifecycle/control-plane smoke path first:

1. `autoresearch init --project-root /absolute/path/to/external-project`
1. `autoresearch status --project-root /absolute/path/to/external-project`
1. After a completed run has evidence, `autoresearch verify --project-root /absolute/path/to/external-project --run-id <run_id> --status passed --summary "..." --evidence-path <path>`
1. Then `autoresearch final-conclusions --project-root /absolute/path/to/external-project --run-id <run_id>`
1. Resolve the pending A5 with `autoresearch approve <approval_id>` to write `artifacts/runs/<run_id>/final_conclusions_v1.json`

If you want the current strongest domain-pack smoke path next, connect your MCP client to `packages/hep-mcp/dist/index.js` and run:

1. Call `hep_health`.
1. Call `hep_project_create`.
1. Call `hep_run_create`.
1. Read `hep://runs/{run_id}/manifest`.

If you want the current strongest end-to-end workflow family, continue with:

1. `hep_run_build_citation_mapping`
1. `hep_run_build_writing_evidence` or `hep_project_build_evidence`
1. `hep_render_latex`
1. `hep_export_project`

## Current HEP Framing

HEP belongs in the root docs today as:

- the current most mature provider family
- the current strongest end-to-end workflow family
- the current provider example for evidence-first Project/Run flows

HEP does not define the root docs as:

- the only intended domain
- the only meaningful way to understand the repo
- the root product identity

## Documentation

- [Feature Testing Guide](./docs/TESTING_GUIDE.md)
- [Project Status](./docs/PROJECT_STATUS.md)
- [Architecture Overview](./docs/ARCHITECTURE.md)
- [pdg-mcp Docs](./packages/pdg-mcp/README.md)

## Development

For front-door drift, start with:

- `packages/hep-mcp/tests/docs/docToolDrift.test.ts`
- `pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check`
- `pnpm --filter @autoresearch/hep-mcp test -- tests/docs/docToolDrift.test.ts`

## License

MIT
