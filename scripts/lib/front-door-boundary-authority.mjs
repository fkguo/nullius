// Keep these assertions line-stable: both the root checker and the doc drift
// test use exact substring matches so front-door wording drift fails closed.
export const FRONT_DOOR_SNIPPETS = [
  {
    relPath: 'README.md',
    snippets: [
      'Autoresearch Lab is a domain-neutral, evidence-first research monorepo.',
      '`autoresearch workflow-plan` is the recommended stateful launcher-backed front door for literature workflows on an initialized external project root; it resolves checked-in generic workflow recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`. The checked-in `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` remains a lower-level consumer of the same workflow authority. The installable legacy `hepar` public shell no longer exposes `literature-gap`; any remaining `literature-gap` path is internal full-parser compatibility only.',
      '| Generic lifecycle + computation + workflow-plan front door | `autoresearch` | External project-root lifecycle state, approvals, bounded native TS `run --workflow-id computation`, and stateful workflow-plan persistence |',
      '| High-level literature workflow plan entrypoint | `autoresearch workflow-plan` | Recommended stateful launcher-backed entrypoint for initialized external project roots; resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`; `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` is the lower-level parallel consumer, and the installable legacy `hepar` public shell no longer exposes `literature-gap` |',
      '- `autoresearch run --workflow-id computation` executes a prepared `computation/manifest.json` on an initialized external project root; approval handling stays on `autoresearch status/approve`.',
      'Legacy compatibility note: the installable `hepar` public shell no longer exposes `literature-gap`; any remaining `literature-gap` path is internal full-parser compatibility only and is still headed toward retirement.',
      '| Workflow shells | `workflow-plan` | Checked-in generic workflow authority consumed directly by `autoresearch workflow-plan` and by the lower-level `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan`; no installable `hepar literature-gap` front door remains |',
      '- For launcher-backed literature workflows, first initialize the target external project root with `autoresearch init`, then use `autoresearch workflow-plan` from that root or with `--project-root`. It resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`, and leaves the checked-in Python `workflow-plan` script as the lower-level parallel consumer. Do not treat any internal `literature-gap` compatibility path as a new front-door shell.',
      '- `autoresearch init/status/approve/pause/resume/export` for `.autoresearch/` project state outside the development repo.',
      '- the root product identity',
    ],
  },
  {
    relPath: 'docs/README_zh.md',
    snippets: [
      'Autoresearch Lab 是一个面向理论研究的 domain-neutral、evidence-first monorepo。',
      '`autoresearch workflow-plan` 是推荐的 stateful launcher-backed 前门，面向已经初始化好的外部 project root；它会直接通过 `@autoresearch/literature-workflows` 解析 checked-in generic workflow recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。checked-in 的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 仍是同一 workflow authority 的较底层 consumer。安装态 legacy `hepar` public shell 已不再暴露 `literature-gap`；任何残余 `literature-gap` 路径都只剩 internal full-parser compatibility。`,
      '| 通用 lifecycle + computation + workflow-plan front door | `autoresearch` | 外部 project root 的 lifecycle state、审批、受限原生 TS `run --workflow-id computation`，以及 stateful workflow-plan 持久化 |',
      '| 高层文献工作流入口 | `autoresearch workflow-plan` | 推荐的 stateful launcher-backed 前门，面向已初始化的外部 project root；直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 是较底层的并行 consumer，安装态 legacy `hepar` public shell 已不再暴露 `literature-gap` |',
      '- `autoresearch run --workflow-id computation` 会在已初始化的外部 project root 上执行准备好的 `computation/manifest.json`；审批仍通过 `autoresearch status/approve` 处理。',
      'Legacy compatibility 说明：安装态 `hepar` public shell 已不再暴露 `literature-gap`；任何残余 `literature-gap` 路径都只剩 internal full-parser compatibility，并继续朝退役方向推进。',
      '| Workflow shells | `workflow-plan` | checked-in generic workflow authority，由 `autoresearch workflow-plan` 直接消费，也由较底层的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 消费；不再保留 installable `hepar literature-gap` 前门 |',
      '- 对 launcher-backed 文献工作流，先用 `autoresearch init` 初始化目标外部 project root，再在该 root 内或通过 `--project-root` 调用 `autoresearch workflow-plan`。它会直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；checked-in 的 Python `workflow-plan` 脚本仍是较底层的并行 consumer；不要把任何 internal `literature-gap` compatibility path 当成新的前门 shell。',
      '- `autoresearch init/status/approve/pause/resume/export` 用于开发仓外 `.autoresearch/` project state。',
      '- root 产品身份本身',
    ],
  },
  {
    relPath: 'docs/PROJECT_STATUS.md',
    snippets: [
      '**Root framing**: Domain-neutral substrate + control plane; HEP is the current most mature provider family, not the root identity',
      '**Main generic lifecycle + native TS computation + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state',
      '- **Recommended launcher-backed literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`; the checked-in Python `workflow-plan` script remains a lower-level parallel consumer, and the installable legacy `hepar` public shell no longer exposes `literature-gap`)',
      '- **Native TS computation run slice**: `autoresearch run --workflow-id computation` (requires an initialized external project root plus a prepared `computation/manifest.json`; still intentionally bounded to computation only)',
      'Legacy compatibility note: the installable `hepar` public shell no longer exposes `literature-gap`; any remaining `literature-gap` path is internal full-parser compatibility only.',
      '**Native TS computation workflow**: `autoresearch run --workflow-id computation` executes a prepared `computation/manifest.json` on an initialized external project root; gate handling stays on `autoresearch status/approve`',
      '**Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`',
    ],
  },
  {
    relPath: 'docs/ARCHITECTURE.md',
    snippets: [
      '- The root architecture is domain-neutral.',
      '- checked-in workflow recipes that can be consumed by generic workflow-plan consumers or agent clients',
      'The current user-facing generic lifecycle + computation + workflow-plan entrypoint is the `autoresearch` CLI, not the root MCP server.',
      'High-level literature workflows are meant to enter through the stateful launcher-backed `autoresearch workflow-plan`, which requires an initialized external project root and resolves checked-in workflow authority directly via `@autoresearch/literature-workflows`:',
      '`autoresearch workflow-plan` → native TS front door using `@autoresearch/literature-workflows`, persisting `.autoresearch/state.json#/plan` and deriving `.autoresearch/plan.md`',
      '`autoresearch run --workflow-id computation` is the native TS computation entrypoint in this slice.',
      'The installable `hepar` public shell no longer exposes `literature-gap`; any remaining `literature-gap` path is internal full-parser compatibility only and should keep moving toward retirement.',
      'Users who need generic lifecycle state should invoke `autoresearch` directly rather than expecting the root MCP server to own that surface today.',
    ],
  },
  {
    relPath: 'docs/TOOL_CATEGORIES.md',
    snippets: [
      'launcher 解析后再下沉到 `inspire_search` / provenance / network operators；不再保留 installable `hepar literature-gap` 前门',
      '不再通过 provider-specific high-level MCP facade；installable `hepar` public shell 也不再暴露 `literature-gap`',
      '高层 literature workflow 现由 stateful launcher-backed `autoresearch workflow-plan` 前门承载，需先 `autoresearch init` 并且会直接通过 `@autoresearch/literature-workflows` 解析后写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；checked-in 的 Python `workflow-plan` 脚本是同一 authority 的较底层 consumer；installable `hepar` public shell 已不再暴露 `literature-gap`。',
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
