// Keep these assertions line-stable: the root checker and doc drift tests use
// exact substring matches so front-door wording drift fails closed.
export const FRONT_DOOR_SNIPPETS = [
  {
    relPath: 'packages/hep-autoresearch/README.md',
    snippets: [
      'Need the current mainline front-door truth first? Start with the repo-root [README](../../README.md), [docs/QUICKSTART.md](../../docs/QUICKSTART.md), and [docs/TESTING_GUIDE.md](../../docs/TESTING_GUIDE.md). The package docs below are package-local legacy / maintainer-oriented docs around the residual Pipeline A surface, not the default product first touch.',
      'The installable public legacy surface now excludes public computation plus `doctor`, `bridge`, and `literature-gap`',
      'Transitional Pipeline A compatibility CLI (install aliases: `hep-autoresearch`, `hepar`, `hep-autopilot`) remains available, but it is not the generic front door.',
    ],
    forbiddenSnippets: [
      '## Start here\n',
    ],
  },
  {
    relPath: 'packages/hep-autoresearch/README.zh.md',
    snippets: [
      '如果你先想确认当前 mainline 的 front-door 真相，请先看仓库根级的 [README](../../README.md)、[docs/QUICKSTART.md](../../docs/QUICKSTART.md) 与 [docs/TESTING_GUIDE.md](../../docs/TESTING_GUIDE.md)。下面这些内容是 `packages/hep-autoresearch/` 的 package-local legacy / maintainer 文档链路，不是默认产品前门。',
      '安装入口的 public shell 已不再暴露 public computation、`doctor`、`bridge` 与 `literature-gap`。',
      '当前通过安装入口（`hep-autoresearch`/`hepar`/`hep-autopilot`）可见的 legacy CLI 公共命令面如下；这些命令用于兼容未完成退役的 Pipeline A 能力，不构成 generic authority：',
    ],
    forbiddenSnippets: [
      '## 你现在应该从哪里读起？\n',
    ],
  },
  {
    relPath: 'packages/hep-autoresearch/docs/INDEX.md',
    snippets: [
      'If you need the current mainline front-door truth, start with the repo-root `README.md`, `../../docs/QUICKSTART.md`, and `../../docs/TESTING_GUIDE.md`. This package index is for package-local legacy / maintainer docs around `hep-autoresearch` / `hepar`; it is not the default product front door.',
      '## Package-doc entry points (legacy / maintainer-oriented)',
      'The installable public shell no longer exposes public computation, `doctor`, `bridge`, or `literature-gap`; those retired command paths remain only on the internal full parser for maintainer/eval/regression coverage.',
    ],
    forbiddenSnippets: [
      '## Entry points',
      'unrepointed commands such as `run`, `doctor`, and `bridge`',
    ],
  },
  {
    relPath: 'packages/hep-autoresearch/docs/BEGINNER_TUTORIAL.md',
    snippets: [
      'For the current generic front door, start with the repo-root `../../docs/QUICKSTART.md` and `../../docs/TESTING_GUIDE.md`. This package tutorial is a legacy-surface / maintainer-oriented compatibility walkthrough for readers who intentionally need the narrowed Pipeline A shell around an external research project.',
      'The installable public shell no longer exposes public computation, `doctor`, `bridge`, or `literature-gap`.',
      'This is an optional compatibility smoke path, not the recommended first-touch path.',
      '- `computation`: `docs/COMPUTATION.md` via `autoresearch run --workflow-id computation` (native TS front door, not `hep-autoresearch run`)',
    ],
    forbiddenSnippets: [
      '# Beginner tutorial (English)',
      '- `computation`: `workflows/computation.md`',
    ],
  },
  {
    relPath: 'packages/hep-autoresearch/docs/BEGINNER_TUTORIAL.zh.md',
    snippets: [
      '如果你想先看当前 generic front door，请先读仓库根级 `../../docs/QUICKSTART.md` 与 `../../docs/TESTING_GUIDE.md`。本教程是一个 package-level 的 legacy / maintainer 兼容路径说明，只面向那些确实需要触碰收窄后 Pipeline A shell 的读者。',
      '安装态 public shell 已不再暴露 public computation、`doctor`、`bridge` 与 `literature-gap`。',
      '这是一条可选的兼容路径烟测，不是推荐的 first-touch 路径。',
      '- `computation`：`docs/COMPUTATION.md`，并通过 `autoresearch run --workflow-id computation` 进入（不是 `hep-autoresearch run`）',
    ],
    forbiddenSnippets: [
      '- `computation`：`workflows/computation.md`',
    ],
  },
  {
    relPath: 'packages/hep-autoresearch/docs/WORKFLOWS.md',
    snippets: [
      'The installable public shell no longer exposes public computation, `doctor`, `bridge`, or `literature-gap`; those retired command paths remain only on the internal full parser for maintainer/eval/regression coverage.',
      '### Internal full-parser compatibility only: `doctor` (maintainer/eval/regression)',
      'The installable public shell no longer exposes `hepar doctor`.',
    ],
    forbiddenSnippets: [
      'unrepointed commands such as `run`, `doctor`, and `bridge`',
      '### `hepar doctor` (entrypoints + MCP)',
    ],
  },
  {
    relPath: 'packages/hep-autoresearch/docs/ORCHESTRATOR_INTERACTION.zh.md',
    snippets: [
      'public computation、`doctor`、`bridge` 与 `literature-gap` 已从 installable shell 退役，仅保留在内部 full parser 供 maintainer/eval/regression 使用。',
      'computation 应走 `autoresearch run --workflow-id computation`；同意点仍按 `approval_policy.json` 自动触发：',
      '# computation 现在走 native TS front door，而不是 installable `hepar run`',
    ],
    forbiddenSnippets: [
      '用于尚未 repoint 的 workflow shell（例如 `run`、`logs`、`doctor`、`bridge`）',
      'hepar run --run-id M0-computation-demo-r1 --workflow-id computation --project-dir',
    ],
  },
  {
    relPath: 'docs/QUICKSTART.md',
    snippets: [
      '本页面向当前最成熟的 domain pack 上手路径，而不是重新定义 root 产品身份。generic lifecycle + workflow-plan front door 仍是 `autoresearch`；这里的 `hep_*` 路径只是在此基础上进入当前最强的 HEP evidence/project/run workflow family。',
      '`autoresearch workflow-plan --recipe literature_to_evidence`',
      '这是一个 stateful launcher-backed front door，会直接通过 `@autoresearch/literature-workflows` 解析 checked-in workflow authority，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。',
      '不要把它们当成新的 quickstart 默认入口。',
    ],
    forbiddenSnippets: [
      '`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 仍是较底层的并行 consumer。',
    ],
  },
  {
    relPath: 'README.md',
    snippets: [
      'Autoresearch Lab is a domain-neutral, evidence-first research monorepo.',
      '`autoresearch workflow-plan` is the recommended stateful launcher-backed front door for literature workflows on an initialized external project root; it resolves checked-in generic workflow recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`. The checked-in `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` remains a lower-level consumer of the same workflow authority. The installable legacy `hepar` public shell no longer exposes `computation` or `literature-gap`; any remaining public `run` surface is residual non-computation compatibility only.',
      '| Generic lifecycle + computation + workflow-plan front door | `autoresearch` | External project-root lifecycle state, approvals, bounded native TS `run --workflow-id computation`, and stateful workflow-plan persistence |',
      '| High-level literature workflow plan entrypoint | `autoresearch workflow-plan` | Recommended stateful launcher-backed entrypoint for initialized external project roots; resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`; `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` is the lower-level parallel consumer, and the installable legacy `hepar` public shell no longer exposes `computation` or `literature-gap` |',
      '- `autoresearch run --workflow-id computation` executes a prepared `computation/manifest.json` on an initialized external project root; approval handling stays on `autoresearch status/approve`.',
      'Legacy compatibility note: the installable `hepar` public shell no longer exposes `computation` or `literature-gap`; any remaining public `run` surface is residual non-computation compatibility only and is still headed toward retirement.',
      '| Workflow shells | `workflow-plan` | Checked-in generic workflow authority consumed directly by `autoresearch workflow-plan` and by the lower-level `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan`; no installable `hepar literature-gap` front door remains |',
      '- For launcher-backed literature workflows, first initialize the target external project root with `autoresearch init`, then use `autoresearch workflow-plan` from that root or with `--project-root`. It resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`, and leaves the checked-in Python `workflow-plan` script as the lower-level parallel consumer. Do not treat any internal `literature-gap` compatibility path as a new front-door shell.',
      '- `autoresearch init/status/approve/pause/resume/export` for `.autoresearch/` project state outside the development repo.',
      '- the root product identity',
    ],
    forbiddenSnippets: [
      '`hepar literature-gap` is still live only as a legacy compatibility shell pending retirement.',
      'Legacy compatibility note: `hepar literature-gap` still exists in the legacy Pipeline A CLI surface, but it is no longer a recommended mainline entrypoint and is headed toward retirement.',
      '| Workflow shells | `workflow-plan` | Checked-in generic workflow authority consumed directly by `autoresearch workflow-plan` and by the lower-level `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan`; `hepar literature-gap` remains only as a legacy compatibility wrapper pending retirement |',
    ],
  },
  {
    relPath: 'docs/README_zh.md',
    snippets: [
      'Autoresearch Lab 是一个面向理论研究的 domain-neutral、evidence-first monorepo。',
      '`autoresearch workflow-plan` 是推荐的 stateful launcher-backed 前门，面向已经初始化好的外部 project root；它会直接通过 `@autoresearch/literature-workflows` 解析 checked-in generic workflow recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。checked-in 的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 仍是同一 workflow authority 的较底层 consumer。安装态 legacy `hepar` public shell 已不再暴露 `computation` 或 `literature-gap`；任何残余的 public `run` 面都只剩 residual non-computation compatibility。',
      '| 通用 lifecycle + computation + workflow-plan front door | `autoresearch` | 外部 project root 的 lifecycle state、审批、受限原生 TS `run --workflow-id computation`，以及 stateful workflow-plan 持久化 |',
      '| 高层文献工作流入口 | `autoresearch workflow-plan` | 推荐的 stateful launcher-backed 前门，面向已初始化的外部 project root；直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 是较底层的并行 consumer，安装态 legacy `hepar` public shell 已不再暴露 `computation` 或 `literature-gap` |',
      '- `autoresearch run --workflow-id computation` 会在已初始化的外部 project root 上执行准备好的 `computation/manifest.json`；审批仍通过 `autoresearch status/approve` 处理。',
      'Legacy compatibility 说明：安装态 `hepar` public shell 已不再暴露 `computation` 或 `literature-gap`；任何残余 public `run` 面都只剩 residual non-computation compatibility，并继续朝退役方向推进。',
      '| Workflow shells | `workflow-plan` | checked-in generic workflow authority，由 `autoresearch workflow-plan` 直接消费，也由较底层的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 消费；不再保留 installable `hepar literature-gap` 前门 |',
      '- 对 launcher-backed 文献工作流，先用 `autoresearch init` 初始化目标外部 project root，再在该 root 内或通过 `--project-root` 调用 `autoresearch workflow-plan`。它会直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；checked-in 的 Python `workflow-plan` 脚本仍是较底层的并行 consumer；不要把任何 internal `literature-gap` compatibility path 当成新的前门 shell。',
      '- `autoresearch init/status/approve/pause/resume/export` 用于开发仓外 `.autoresearch/` project state。',
      '- root 产品身份本身',
    ],
    forbiddenSnippets: [
      '`hepar literature-gap` 仍然存在，但只作为待退役的 legacy compatibility shell。',
      'Legacy compatibility 说明：`hepar literature-gap` 仍在旧的 Pipeline A CLI 面上存活，但已不再是推荐的新入口，并且处于退役方向上。',
      '| Workflow shells | `workflow-plan` | checked-in generic workflow authority，由 `autoresearch workflow-plan` 直接消费，也由较底层的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 消费；`hepar literature-gap` 仅剩 legacy compatibility wrapper，等待退役 |',
    ],
  },
  {
    relPath: 'docs/PROJECT_STATUS.md',
    snippets: [
      '**Root framing**: Domain-neutral substrate + control plane; HEP is the current most mature provider family, not the root identity',
      '**Main generic lifecycle + native TS computation + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state',
      '- **Recommended launcher-backed literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`; the checked-in Python `workflow-plan` script remains a lower-level parallel consumer, and the installable legacy `hepar` public shell no longer exposes `computation` or `literature-gap`)',
      '- **Native TS computation run slice**: `autoresearch run --workflow-id computation` (requires an initialized external project root plus a prepared `computation/manifest.json`; still intentionally bounded to computation only)',
      'Legacy compatibility note: the installable `hepar` public shell no longer exposes `computation` or `literature-gap`; any remaining public `run` surface is residual non-computation compatibility only.',
      '**Native TS computation workflow**: `autoresearch run --workflow-id computation` executes a prepared `computation/manifest.json` on an initialized external project root; gate handling stays on `autoresearch status/approve`',
      '**Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`',
    ],
    forbiddenSnippets: [
      'the checked-in Python `workflow-plan` script remains a lower-level parallel consumer, and `hepar literature-gap` remains legacy compatibility-only)',
      'Legacy compatibility note: `hepar literature-gap` is still live on the legacy Pipeline A CLI surface, but it is no longer a recommended mainline entrypoint.',
    ],
  },
  {
    relPath: 'docs/ARCHITECTURE.md',
    snippets: [
      '- The root architecture is domain-neutral.',
      '- checked-in workflow recipes that can be consumed by generic workflow-plan consumers or agent clients',
      '`literature_fetch.py workflow-plan` (lower-level consumer driven by `autoresearch workflow-plan`; no installable `hepar literature-gap` front door remains)',
      'The current user-facing generic lifecycle + computation + workflow-plan entrypoint is the `autoresearch` CLI, not the root MCP server.',
      'High-level literature workflows are meant to enter through the stateful launcher-backed `autoresearch workflow-plan`, which requires an initialized external project root and resolves checked-in workflow authority directly via `@autoresearch/literature-workflows`:',
      '`autoresearch workflow-plan` → native TS front door using `@autoresearch/literature-workflows`, persisting `.autoresearch/state.json#/plan` and deriving `.autoresearch/plan.md`',
      '`autoresearch run --workflow-id computation` is the native TS computation entrypoint in this slice.',
      'The installable `hepar` public shell no longer exposes `computation` or `literature-gap`; any remaining public `run` surface is residual non-computation compatibility only and should keep moving toward retirement.',
      'Users who need generic lifecycle state should invoke `autoresearch` directly rather than expecting the root MCP server to own that surface today.',
    ],
    forbiddenSnippets: [
      '`hepar literature-gap` still exists on the legacy Pipeline A CLI surface as a compatibility wrapper, but it is not the recommended mainline entrypoint and should keep moving toward retirement.',
    ],
  },
  {
    relPath: 'docs/TOOL_CATEGORIES.md',
    snippets: [
      'launcher 解析后再下沉到 `inspire_search` / provenance / network operators；不再保留 installable `hepar literature-gap` 前门',
      '不再通过 provider-specific high-level MCP facade；installable `hepar` public shell 也不再暴露 `literature-gap`',
      '高层 literature workflow 现由 stateful launcher-backed `autoresearch workflow-plan` 前门承载，需先 `autoresearch init` 并且会直接通过 `@autoresearch/literature-workflows` 解析后写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；checked-in 的 Python `workflow-plan` 脚本是同一 authority 的较底层 consumer；installable `hepar` public shell 已不再暴露 `literature-gap`。',
    ],
    forbiddenSnippets: [
      'launcher 解析后再下沉到 `inspire_search` / provenance / network operators；`hepar literature-gap` 仅剩 legacy compatibility shell',
      '不再通过 provider-specific high-level MCP facade；`hepar literature-gap` 不再作为推荐主入口',
      '；`hepar literature-gap` 仍是 legacy compatibility shell，但不再是推荐的新入口。',
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
      '- 安装态 legacy `hepar` public shell 不再是默认测试入口；任何残余 Python compatibility path 都必须明确标成 maintainer/eval/regression-only',
      '### 5.4 launcher-backed literature workflow consumers',
      '这部分不是 MCP 工具，而是当前真实存在的高层 workflow consumers：',
      '这个推荐的 stateful launcher-backed front-door 会直接通过 `@autoresearch/literature-workflows` 解析 checked-in workflow authority，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 是较底层的并行 consumer。',
      'Maintainer / eval / regression only:',
      '这条 internal full-parser compatibility path 只用于覆盖未删净的 maintainer/eval/regression 场景；安装态 `hepar` public shell 已不再暴露 `literature-gap`。',
      '- `autoresearch workflow-plan` 仍是唯一 installable public high-level literature entrypoint',
      '- internal full-parser compatibility path 仍能解析 workflow plan or bundle 以供 regression coverage',
    ],
    forbiddenSnippets: [
      'python -m hep_autoresearch.orchestrator_cli \\',
      '`hepar literature-gap` 仅剩 legacy compatibility shell pending retirement。',
    ],
  },
  {
    relPath: 'meta/protocols/session_protocol_v1.md',
    snippets: [
      '> This protocol is a checked-in workflow authority artifact for Stage 1-2 entry guidance and is executed through the checked-in `packages/literature-workflows` launcher plus checked-in consumers such as `research-team`, `autoresearch workflow-plan`, and the internal full-parser `literature-gap` compatibility path used for maintainer/eval coverage.',
      '> The installable `hepar` public shell no longer exposes `literature-gap`; any remaining `literature-gap` consumer is internal full-parser compatibility only.',
    ],
    forbiddenSnippets: [
      '`research-team` and `hepar literature-gap`.',
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
