import {
  getFrontDoorAuthoritySurface,
} from './front-door-authority-map.mjs';

const ORCHESTRATOR_MCP_TOOLS_SPEC_PATH = getFrontDoorAuthoritySurface('orchestrator_mcp_tools_spec').exact_inventory_source;

// Keep these assertions line-stable: the root checker and doc drift tests use
// exact substring matches so front-door wording drift fails closed.
export const FRONT_DOOR_SNIPPETS = [
  {
    relPath: 'packages/hep-autoresearch/README.md',
    snippets: [
      'HEP-oriented provider package and provider-local internal parser/toolkit residue inside the Autoresearch Lab monorepo.',
      '- generic lifecycle and bounded computation: `autoresearch`',
      '- high-level literature planning: `autoresearch workflow-plan`',
      '- current mature HEP MCP surface: `@autoresearch/hep-mcp`',
      'maintainer-only legacy docs, workflow notes, and examples are kept local rather than published as part of the public GitHub surface.',
    ],
    forbiddenSnippets: [
      'docs/INDEX.md',
      'docs/BEGINNER_TUTORIAL.md',
      'Exact installable public command inventory:',
    ],
  },
  {
    relPath: 'packages/hep-autoresearch/README.zh.md',
    snippets: [
      '这是 Autoresearch Lab monorepo 中偏 HEP 的 provider 包，以及 provider-local 的 internal parser/toolkit 残余实现面。',
      '- generic lifecycle 与 bounded computation：`autoresearch`',
      '- 高层 literature planning：`autoresearch workflow-plan`',
      '- 当前成熟的 HEP MCP 面：`@autoresearch/hep-mcp`',
      'maintainer-only 的 legacy 文档、workflow 说明和 examples 现在只保留在本地，不再作为 GitHub 公开内容发布。',
    ],
    forbiddenSnippets: [
      'docs/INDEX.md',
      '安装态 public shell 的精确命令清单是：',
    ],
  },
  {
    relPath: 'docs/QUICKSTART.md',
    snippets: [
      '本页面向当前最成熟的 domain pack 上手路径，而不是重新定义 root 产品身份。generic lifecycle + workflow-plan front door 仍是 `autoresearch`；这里的 `hep_*` 路径只是在此基础上进入当前最强的 HEP evidence/project/run workflow family。',
      '## Generic First-Touch（先走 generic front door）',
      '1) `autoresearch init --project-root /absolute/path/to/external-project`',
      '2) `autoresearch status --project-root /absolute/path/to/external-project`',
      '`autoresearch workflow-plan --recipe literature_to_evidence`',
      '这是一个公开的 stateful front door，会直接通过 `@autoresearch/literature-workflows` 解析 checked-in workflow authority，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。',
      '不要把它们当成新的 quickstart 默认入口。',
    ],
    orderedSnippets: [
      '## Generic First-Touch（先走 generic front door）',
      '1) `autoresearch init --project-root /absolute/path/to/external-project`',
      '2) `autoresearch status --project-root /absolute/path/to/external-project`',
      '3) `autoresearch workflow-plan --recipe literature_to_evidence`',
      '## Draft Path（最简路径）',
      '1) `hep_project_create`',
    ],
    forbiddenSnippets: [
      '`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 仍是较底层的并行 consumer。',
    ],
  },
  {
    relPath: 'README.md',
    snippets: [
      'Autoresearch Lab is a domain-neutral, evidence-first research monorepo.',
      '`autoresearch workflow-plan` is the recommended public stateful front door for literature workflows on an initialized external project root; it resolves checked-in workflow recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`.',
      '| Generic lifecycle + computation + workflow-plan front door | `autoresearch` | External project-root lifecycle state, approvals, bounded native TS `run --workflow-id computation`, and stateful workflow-plan persistence |',
      '| High-level literature workflow plan entrypoint | `autoresearch workflow-plan` | Recommended public stateful entrypoint for initialized external project roots; resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md` |',
      '- `autoresearch run --workflow-id computation` executes a prepared `computation/manifest.json` on an initialized external project root; approval handling stays on `autoresearch status/approve`.',
      '| Workflow shells | `workflow-plan` | Checked-in generic workflow authority consumed directly by `autoresearch workflow-plan` |',
      '- For stateful literature workflows, first initialize the target external project root with `autoresearch init`, then use `autoresearch workflow-plan` from that root or with `--project-root`. It resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`.',
      '- `autoresearch init/status/approve/pause/resume/export` for `.autoresearch/` project state outside the development repo.',
      'If you want the generic lifecycle/control-plane smoke path first:',
      '1. `autoresearch init --project-root /absolute/path/to/external-project`',
      '1. `autoresearch status --project-root /absolute/path/to/external-project`',
      '- the root product identity',
    ],
    orderedSnippets: [
      '1. Generic lifecycle workflow',
      '1. Stateful literature workflow family',
      '1. Native TS computation workflow',
      '1. Project/Run evidence workflow',
      '## 3. What Are the Main Current Entrypoints',
      '| Generic lifecycle + computation + workflow-plan front door | `autoresearch` | External project-root lifecycle state, approvals, bounded native TS `run --workflow-id computation`, and stateful workflow-plan persistence |',
      '| High-level literature workflow plan entrypoint | `autoresearch workflow-plan` | Recommended public stateful entrypoint for initialized external project roots; resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md` |',
      '| Current most mature domain MCP front door | `node /absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js` | HEP domain MCP server for research/navigation/evidence/export workflows `(72 std / 101)` |',
      'If you want the generic lifecycle/control-plane smoke path first:',
      'If you want the current strongest domain-pack smoke path next, connect your MCP client to `packages/hep-mcp/dist/index.js` and run:',
    ],
    forbiddenSnippets: [
      '`hepar literature-gap` is still live only as a legacy shell',
      '`hepar literature-gap` still exists in the legacy Pipeline A CLI surface',
      '`hepar literature-gap` remains only as a legacy wrapper',
    ],
  },
  {
    relPath: 'docs/README_zh.md',
    snippets: [
      'Autoresearch Lab 是一个面向理论研究的 domain-neutral、evidence-first monorepo。',
      '`autoresearch workflow-plan` 是推荐的公开 stateful 前门，面向已经初始化好的外部 project root；它会直接通过 `@autoresearch/literature-workflows` 解析 checked-in workflow recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。',
      '| 通用 lifecycle + computation + workflow-plan front door | `autoresearch` | 外部 project root 的 lifecycle state、审批、受限原生 TS `run --workflow-id computation`，以及 stateful workflow-plan 持久化 |',
      '| 高层文献工作流入口 | `autoresearch workflow-plan` | 推荐的公开 stateful 前门，面向已初始化的外部 project root；直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md` |',
      '- `autoresearch run --workflow-id computation` 会在已初始化的外部 project root 上执行准备好的 `computation/manifest.json`；审批仍通过 `autoresearch status/approve` 处理。',
      '| Workflow shells | `workflow-plan` | checked-in generic workflow authority，由 `autoresearch workflow-plan` 直接消费 |',
      '- 对 stateful 文献工作流，先用 `autoresearch init` 初始化目标外部 project root，再在该 root 内或通过 `--project-root` 调用 `autoresearch workflow-plan`。它会直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。',
      '- `autoresearch init/status/approve/pause/resume/export` 用于开发仓外 `.autoresearch/` project state。',
      '如果你想先走 generic lifecycle/control-plane 烟测路径：',
      '1. `autoresearch init --project-root /absolute/path/to/external-project`',
      '1. `autoresearch status --project-root /absolute/path/to/external-project`',
      '- root 产品身份本身',
    ],
    orderedSnippets: [
      '1. 通用 lifecycle 工作流',
      '1. Stateful 文献工作流家族',
      '1. 原生 TS computation 工作流',
      '1. Project/Run 证据工作流',
      '| 通用 lifecycle + computation + workflow-plan front door | `autoresearch` | 外部 project root 的 lifecycle state、审批、受限原生 TS `run --workflow-id computation`，以及 stateful workflow-plan 持久化 |',
      '| 高层文献工作流入口 | `autoresearch workflow-plan` | 推荐的公开 stateful 前门，面向已初始化的外部 project root；直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md` |',
      '| 当前最成熟的领域 MCP front door | `node /absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js` | 面向研究导航 / 证据 / 导出的 HEP 领域 MCP server `(72 std / 101)` |',
      '如果你想先走 generic lifecycle/control-plane 烟测路径：',
      '如果你接着想走当前最强的 domain-pack 烟测路径，再把 MCP client 接到 `packages/hep-mcp/dist/index.js` 并执行：',
    ],
    forbiddenSnippets: [
      '`hepar literature-gap` 仍然存在，但只作为 legacy shell',
      '`hepar literature-gap` 仍在旧的 Pipeline A CLI 面上存活',
      '`hepar literature-gap` 仅剩 legacy wrapper',
    ],
  },
  {
    relPath: 'docs/PROJECT_STATUS.md',
    snippets: [
      '**Root framing**: Domain-neutral substrate + control plane; HEP is the current most mature provider family, not the root identity',
      '**Main generic lifecycle + native TS computation + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state',
      '- **Recommended public stateful literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`)',
      '- **Native TS run slice**: `autoresearch run` (requires an initialized external project root; runs prepared `computation/manifest.json` natively for `--workflow-id computation`, and also consumes one dependency-satisfied persisted workflow-plan step through the same front door)',
      '- **Public stateful literature planning workflow**: `autoresearch workflow-plan` resolves literature recipes directly via `@autoresearch/literature-workflows` into bounded executable steps for an initialized external project root, persists the plan substrate into `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`',
      '**Native TS run workflow**: `autoresearch run` remains the only execution front door; `--workflow-id computation` executes a prepared `computation/manifest.json`, while persisted workflow-plan steps execute one dependency-satisfied step at a time',
      '**Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`',
      '**Project/Run evidence workflow**: `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> `hep_export_project`',
      '- `workflow-plan` 现在是公开的 stateful literature front door，且已把稳定的 typed `plan.execution` metadata 写入 `.autoresearch/state.json#/plan`。',
      '- `autoresearch run` 现在是该 seam 的 canonical minimal consumer：它会执行一个 dependency-satisfied persisted workflow step，并继续保持唯一 execution front door。',
      '- 当前 slice 仍未提供 canonical closed-loop literature execution runtime；这里还没有 full scheduler、多步自主编排或 end-to-end closed loop。',
    ],
    orderedSnippets: [
      '- **Main generic lifecycle + native TS computation + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state',
      '- **Recommended public stateful literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`)',
      '- **Native TS run slice**: `autoresearch run` (requires an initialized external project root; runs prepared `computation/manifest.json` natively for `--workflow-id computation`, and also consumes one dependency-satisfied persisted workflow-plan step through the same front door)',
      '- **Current most mature domain MCP front door**: `@autoresearch/hep-mcp` exposed through `packages/hep-mcp/dist/index.js`',
      '- **Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`',
      '- **Public stateful literature planning workflow**: `autoresearch workflow-plan` resolves literature recipes directly via `@autoresearch/literature-workflows` into bounded executable steps for an initialized external project root, persists the plan substrate into `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`',
      '- **Native TS run workflow**: `autoresearch run` remains the only execution front door; `--workflow-id computation` executes a prepared `computation/manifest.json`, while persisted workflow-plan steps execute one dependency-satisfied step at a time',
      '- **Project/Run evidence workflow**: `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> `hep_export_project`',
      '## Workflow-plan boundary',
      '- `workflow-plan` 现在是公开的 stateful literature front door，且已把稳定的 typed `plan.execution` metadata 写入 `.autoresearch/state.json#/plan`。',
    ],
    forbiddenSnippets: [
      '`hepar literature-gap` remains legacy-only',
      '`hepar literature-gap` is still live on the legacy Pipeline A CLI surface',
    ],
  },
  {
    relPath: 'docs/ARCHITECTURE.md',
    snippets: [
      '- The root architecture is domain-neutral.',
      '- checked-in workflow recipes that can be consumed by generic workflow-plan consumers or agent clients',
      '`literature_fetch.py workflow-plan` (lower-level consumer driven by `autoresearch workflow-plan`)',
      'The current user-facing generic lifecycle + computation + workflow-plan entrypoint is the `autoresearch` CLI, not the root MCP server.',
      'High-level literature workflows are meant to enter through the public stateful `autoresearch workflow-plan`, which requires an initialized external project root and resolves checked-in workflow authority directly via `@autoresearch/literature-workflows`:',
      '`autoresearch workflow-plan` → native TS front door using `@autoresearch/literature-workflows`, persisting `.autoresearch/state.json#/plan` and deriving `.autoresearch/plan.md`',
      'other checked-in consumers remain internal-only validation seams and do not define public workflow authority',
      'Current execution boundary:',
      '- `workflow-plan` is currently a public stateful literature front door with stable typed `plan.execution` metadata persisted in `.autoresearch/state.json#/plan`.',
      '- `autoresearch run` is now the canonical minimal consumer for that seam: it executes one dependency-satisfied persisted workflow step through the generic MCP tool-caller path while remaining the only execution front door.',
      '- This is still not a canonical closed-loop literature execution runtime: there is no full scheduler, autonomous multi-step orchestration layer, or end-to-end closed loop in this slice.',
      '`autoresearch run --workflow-id computation` is the native TS computation entrypoint in this slice.',
      `For the exact live \`orch_*\` inventory and semantics, read \`${ORCHESTRATOR_MCP_TOOLS_SPEC_PATH}\`.`,
      'Users who need generic lifecycle state should invoke `autoresearch` directly rather than expecting the root MCP server to own that surface today.',
    ],
    forbiddenSnippets: [
      '`hepar literature-gap` still exists on the legacy Pipeline A CLI surface as a wrapper',
    ],
  },
  {
    relPath: 'docs/TOOL_CATEGORIES.md',
    snippets: [
      '由公开的 stateful front door 解析后，再下沉到 `inspire_search` / provenance / network operators',
      '不再通过 provider-specific high-level MCP facade',
      '高层 literature workflow 现由公开的 stateful `autoresearch workflow-plan` 前门承载，需先 `autoresearch init` 并且会直接通过 `@autoresearch/literature-workflows` 解析后写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。',
    ],
    forbiddenSnippets: [
      '`hepar literature-gap` 仅剩 legacy shell',
      '`hepar literature-gap` 不再作为推荐主入口',
      '`hepar literature-gap` 仍是 legacy shell',
    ],
  },
  {
    relPath: 'docs/TESTING_GUIDE.md',
    snippets: [
      '本指南面向手工验收当前 front-door truth。`autoresearch` 是 generic lifecycle + workflow-plan front door；`@autoresearch/hep-mcp` 是当前最成熟的 domain MCP front door，提供 Project/Run、evidence、writing/export、literature/data、Zotero、PDG 能力。本页重点覆盖两者的衔接，而不是把 `hep-mcp` 重新写成 root 产品身份。',
      '本文所有 MCP 配置都以 `packages/hep-mcp/dist/index.js` 为当前 domain MCP front door，而不是 generic root front door。',
      '### 0.0 先确认 front-door 角色',
      '- `autoresearch` = generic lifecycle + workflow-plan front door',
      '- `@autoresearch/hep-mcp` = 当前最成熟的 domain MCP front door',
      '- legacy Python CLI 不再属于公开 front-door；如仍需覆盖，只作为 maintainer/eval/regression-only 内部路径测试',
      '### 5.4 stateful literature workflow consumers',
      '这部分不是 MCP 工具，而是当前真实存在的高层 workflow consumers：',
      '这个推荐的公开 stateful front door 会直接通过 `@autoresearch/literature-workflows` 解析 checked-in workflow authority，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。',
      'Maintainer / eval / regression only:',
      '旧的 internal parser `literature-gap` command 已删除；maintainer/eval/regression proof 现在改由 lower-level checked-in coverage 提供：',
      '`PYTHONPYCACHEPREFIX=/tmp/pycache python3 -m pytest -q packages/hep-autoresearch/tests/test_literature_gap_runner.py`',
      '`pnpm --filter @autoresearch/literature-workflows test -- tests/resolve.test.ts`',
      '`pnpm --filter @autoresearch/orchestrator test -- tests/autoresearch-cli.test.ts`',
      '- `autoresearch workflow-plan` 仍是唯一 installable public high-level literature entrypoint',
      '- lower-level checked-in runner / resolver / front-door coverage 仍能证明 `literature_gap_analysis` recipe、seed-search 解析、analyze-step wiring 与 live CLI truth',
    ],
    forbiddenSnippets: [
      'python -m hep_autoresearch.orchestrator_cli \\',
      '`hepar literature-gap` 仅剩 legacy shell',
    ],
  },
  {
    relPath: 'meta/protocols/session_protocol_v1.md',
    snippets: [
      '> This protocol is a checked-in workflow authority artifact for Stage 1-2 entry guidance and is executed through the package-local workflow recipes in `@autoresearch/literature-workflows`, with `autoresearch workflow-plan` as the installable public stateful front door. Other checked-in consumers remain internal-only validation seams of the same authority, not competing entrypoints.',
      '> The old `hepar literature-gap` shell path is deleted. High-level literature entry stays on checked-in workflow recipes plus `autoresearch workflow-plan`.',
    ],
    forbiddenSnippets: [
      '`research-team` and `hepar literature-gap`.',
    ],
  },
  {
    relPath: 'meta/docs/orchestrator-mcp-tools-spec.md',
    snippets: [
      '**Rule**: `orch_*` owns lifecycle state, approvals, queueing, and orchestration policy.',
      '5. `autoresearch` remains the generic front door for lifecycle / workflow-plan / bounded computation; `orch_*` is the MCP/operator counterpart of that control plane rather than a competing product identity.',
      '`hep://` and `orch://` are intentionally separate owned namespaces. Cross-scheme correlation must be carried explicitly by workflow metadata or operator context, not by implicit aliasing.',
      '2. `packages/hep-autoresearch` is now a provider-local internal parser/toolkit residue. The retired public `hepar` shell must not reclaim `orch_*` or `autoresearch` authority.',
    ],
  },
  {
    relPath: 'docs/URI_REGISTRY.md',
    snippets: [
      'Live scheme set for this monorepo is exactly `hep://`, `pdg://`, and `orch://`.',
      '`hep://` and `orch://` are separate owned namespaces.',
      'There is no implicit `hep://` <-> `orch://` aliasing layer in live authority.',
      '| `orch://` | `@autoresearch/orchestrator` | `packages/orchestrator/src/orch-tools/{approval,control,create-status-list,run-read-model}.ts` | Tool-return lifecycle/read-model identifiers | `orch://runs/{run_id}`; `orch://runs/{run_id}/approvals/{approval_dir}`; `orch://runs/export` | Orchestrator lifecycle/read-model/export summaries only. This is not the current MCP `resources/list` authority and it does not own research artifact payloads. |',
    ],
    forbiddenSnippets: [
      '`hep://corpora` | Live',
      '| `orch://runs/{run_id}/state` | Live',
      '| `orch://runs/{run_id}/ledger` | Live',
    ],
  },
];

export const REQUIRED_PACKAGE_DESCRIPTION_SNIPPETS = [
  'Autoresearch ecosystem monorepo',
  'control-plane',
  'provider packages',
];

export const FORBIDDEN_EXACT_PACKAGE_NAMES = new Set(['agent', 'autoresearch-agent']);
export const FORBIDDEN_PACKAGE_TOKENS = new Set(['shell', 'gateway', 'frontend']);
