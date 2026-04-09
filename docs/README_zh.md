# Autoresearch Lab

[English](../README.md) | 中文

Autoresearch Lab 是一个面向理论研究的 domain-neutral、evidence-first monorepo。当前仓库把通用 lifecycle/control-plane 包、本地 MCP provider 包，以及可被 agent client 或 shell 入口消费的 checked-in workflow recipes 放在同一个工作台里。HEP 是目前最成熟的 provider family，也是当前最强的端到端 workflow 示例，但它不是 root 产品身份本身。

## 1. 这个 Monorepo 今天能做什么

- 通过 `@autoresearch/orchestrator` 与 `autoresearch` CLI 管理真实外部 project root 的通用 lifecycle state。
- 通过 `autoresearch workflow-plan` 解析 checked-in workflow recipes，并把 plan state 持久化到 `.autoresearch/`。
- 运行本地优先的 MCP providers，覆盖文献、数据、参考资料与证据工作流。
- 创建可审计的 Project/Run 工作空间，把 artifacts 落盘，并通过 `hep://...` resources 暴露给客户端。
- 从 LaTeX、Zotero 附件以及受限网络 provider 构建证据，再把这些证据用于写作、回放与评审。
- 导出研究资产包与投稿脚手架，并把最终论文 bundle 回灌回 run artifacts。

## 2. 当前主要工作流是什么

1. 通用 lifecycle 工作流
   - `autoresearch init/status/approve/pause/resume/export` 用于开发仓外 `.autoresearch/` project state。
1. Launcher-backed 文献工作流家族
   - `autoresearch workflow-plan` 是推荐的 stateful launcher-backed 前门，面向已经初始化好的外部 project root；它会直接通过 `@autoresearch/literature-workflows` 解析 checked-in generic workflow recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。仓内保留的 Python consumer 只作为实现/回归验证证明，不是独立 public 入口。
1. 原生 TS computation 工作流
   - `autoresearch run --workflow-id computation` 会在已初始化的外部 project root 上执行准备好的 `computation/manifest.json`；审批仍通过 `autoresearch status/approve` 处理。
1. Project/Run 证据工作流
   - `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> export/import。
1. 文献与数据导航工作流
   - 直接使用 `inspire_*`、`openalex_*`、`arxiv_*`、`hepdata_*`、`pdg_*`、`zotero_*` 等 provider 工具。

## 3. 当前主要入口是什么

| Surface | 当前入口 | 用途 |
| --- | --- | --- |
| 通用 lifecycle + computation + workflow-plan front door | `autoresearch` | 外部 project root 的 lifecycle state、审批、受限原生 TS `run --workflow-id computation`，以及 stateful workflow-plan 持久化 |
| 高层文献工作流入口 | `autoresearch workflow-plan` | 推荐的 stateful launcher-backed 前门，面向已初始化的外部 project root；直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；仓内保留的 Python consumer 仅用于内部回归验证，不是第二前门 |
| 当前最成熟的领域 MCP front door | `node /absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js` | 面向研究导航 / 证据 / 导出的 HEP 领域 MCP server `(72 std / 101)` |
| 叶子 provider 包 | `@autoresearch/openalex-mcp`、`@autoresearch/arxiv-mcp`、`@autoresearch/hepdata-mcp`、`@autoresearch/pdg-mcp`、`@autoresearch/zotero-mcp` | 可组合进客户端工作流的 provider-specific capabilities |

工具数量：**`standard` 模式 72 个**（默认：收敛后的紧凑工具面）与 **`full` 模式 101 个**（额外暴露 advanced 工具）。

| 模式 | 工具数 | 适用场景 |
| --- | --- | --- |
| `standard` | 72 | 日常客户端使用的紧凑 front door |
| `full` | 101 | 额外暴露 advanced 与 lifecycle-adjacent slices |

按 capability 而不是按产品身份理解当前包面：

| 能力家族 | 当前 surface | 备注 |
| --- | --- | --- |
| 通用 lifecycle、computation 与 approvals | `@autoresearch/orchestrator`、`autoresearch` | 当前 front door 上覆盖 lifecycle state、审批，以及受限原生 TS computation run slice |
| Evidence-first Project/Run 工作流 | `@autoresearch/hep-mcp`、`hep_*`、`hep://...` | 当前最强的端到端 workflow family |
| 文献与数据 providers | `inspire_*`、`openalex_*`、`arxiv_*`、`hepdata_*` | 直接搜索、下载、导出、受限分析的组合面 |
| 本地参考 providers | `zotero_*`、`pdg_*` | 可选的本地输入与查验工具 |
| Workflow shells | `workflow-plan` | checked-in generic workflow authority，由 `autoresearch workflow-plan` 直接消费；任何剩余的 Python consumer 仅用于内部回归验证 |

## 4. Runs、Artifacts、Resources、State 在哪里

### `hep-mcp` 数据根目录

`@autoresearch/hep-mcp` 的本地状态位于 `HEP_DATA_DIR` 下，默认值是 `~/.hep-mcp`。

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

- Project 根位于 `projects/<project_id>/...`。
- Run 状态位于 `runs/<run_id>/manifest.json` 与 `runs/<run_id>/artifacts/...`。
- `PDG_DATA_DIR` 是 PDG 的本地 companion root，常见布局是 `<HEP_DATA_DIR>/pdg`。
- 文本 artifacts 会通过 MCP resources 直接返回，二进制 artifacts 默认返回 metadata，避免客户端把大 payload 内联进上下文。

### 当前资源 schemes

`@autoresearch/hep-mcp` 当前暴露的是一个精简的 “iceberg” resources 列表，加上若干 templates：

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

### 通用 lifecycle state

`autoresearch init` 会在真实外部 project root 中初始化 `.autoresearch/`。当前 lifecycle 包会读写：

```text
<project_root>/
  .autoresearch/
    state.json
    ledger.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json          # 使用 fleet 功能时
    fleet_workers.json        # 使用 fleet 功能时
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
```

编排器的 read model 还会暴露形如 `orch://runs/{run_id}/approvals/{approval_id}` 的 approval packet URI。

## 5. 用户如何从 MCP clients / agent clients 接入

当前的 MCP 接入模型是本地 stdio only。仓库目前还没有单一的 generic root MCP server；今天最成熟的领域 MCP 入口是 `hep-mcp`，而通用 `autoresearch` surface 现在主要承担 lifecycle/control-plane CLI、原生 TS computation `run`，以及 stateful `workflow-plan`。

通用 MCP 配置模式：

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

说明：

- 先构建：`pnpm -r build`。
- GUI 客户端有时需要把 `node` 换成绝对路径。
- 有些客户端会把工具名 namespacing 成 `mcp__<serverAlias>__<toolName>`；务必以客户端实际显示的名字为准调用。
- 常见的 MCP-compatible client 包括 Cursor、Claude Desktop、Claude Code CLI、Chatbox、Cherry Studio、Continue、Cline、Zed。
- lifecycle CLI 与 MCP 配置分离，直接在 shell 中调用：

```bash
autoresearch init --project-root /absolute/path/to/external-project
autoresearch status --project-root /absolute/path/to/external-project
```

- 对 launcher-backed 文献工作流，先用 `autoresearch init` 初始化目标外部 project root，再在该 root 内或通过 `--project-root` 调用 `autoresearch workflow-plan`。它会直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。任何 checked-in 的 Python workflow consumer 都只用于 maintainer/eval 验证，不应被当成新的前门 shell。

## 6. 更深的架构 / 治理文档在哪里

- [架构总览](./ARCHITECTURE.md)
- [测试指南](./TESTING_GUIDE.md)
- [项目状态](./PROJECT_STATUS.md)
- [工具分类](./TOOL_CATEGORIES.md)
- [URI 注册表](./URI_REGISTRY.md)
- [英文 README](../README.md)
- [仓库治理规则](../AGENTS.md)
- [开发契约](../meta/ECOSYSTEM_DEV_CONTRACT.md)

面向维护者的重构计划、remediation tracker、执行 prompt，以及本地 legacy workflow 说明不再作为公开仓库内容发布。

## Quick Start

```bash
pnpm install
pnpm -r build
pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check
```

如果你想先走 generic lifecycle/control-plane 烟测路径：

1. `autoresearch init --project-root /absolute/path/to/external-project`
1. `autoresearch status --project-root /absolute/path/to/external-project`

如果你接着想走当前最强的 domain-pack 烟测路径，再把 MCP client 接到 `packages/hep-mcp/dist/index.js` 并执行：

1. 调用 `hep_health`
1. 调用 `hep_project_create`
1. 调用 `hep_run_create`
1. 读取 `hep://runs/{run_id}/manifest`

如果你想直接走当前最强的端到端 workflow family，再继续：

1. `hep_run_build_citation_mapping`
1. `hep_run_build_writing_evidence` 或 `hep_project_build_evidence`
1. `hep_render_latex`
1. `hep_export_project`

## 当前 HEP 应如何出现在 Root 文档中

HEP 在 root docs 中今天应被表述为：

- 当前最成熟的 provider family
- 当前最强的端到端 workflow family
- evidence-first Project/Run 流程的当前 provider 示例

HEP 不应被表述为：

- 唯一目标领域
- 理解仓库的唯一方式
- root 产品身份本身

## 文档

- [功能测试指南](./TESTING_GUIDE.md)
- [项目状态](./PROJECT_STATUS.md)
- [架构总览](./ARCHITECTURE.md)
- [pdg-mcp 文档](../packages/pdg-mcp/README_zh.md)

## Development

检查 front-door drift 时，优先看：

- `packages/hep-mcp/tests/docs/docToolDrift.test.ts`
- `pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check`
- `pnpm --filter @autoresearch/hep-mcp test -- tests/docs/docToolDrift.test.ts`

## License

MIT
