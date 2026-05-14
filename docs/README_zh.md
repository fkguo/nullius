# Autoresearch Lab

[English](../README.md) | 中文

Autoresearch Lab 是一个面向理论研究的 domain-neutral、evidence-first monorepo。当前仓库把通用 lifecycle/control-plane 包、本地 MCP provider 包，以及可被 agent client 或 shell 入口消费的 checked-in workflow recipes 放在同一个工作台里。HEP 是目前最成熟的 provider family，也是当前最强的端到端 workflow 示例，但它不是 root 产品身份本身。

## 1. Surface Policy

- `autoresearch` 继续作为已初始化外部 project root 的 stateful CLI front door。lifecycle state、bounded execution、`workflow-plan`、verification、更高结论 gate，以及 proposal decisions 都从这里进入。
- `orch_*` 继续作为同一 control plane 的 MCP/operator counterpart。它是 control plane 的 host-facing bridge，不是另一个产品身份，也不是对 CLI 的替代。
- `openalex_*`、`arxiv_*`、`hepdata_*`、`pdg_*`、`zotero_*` 继续作为 bounded atomic MCP operators。它们保持 MCP-first，因为这些 surface 是 schema-driven provider atoms，而不是需要整套 CLI 镜像的 stateful workflow shell。
- `idea-mcp` 继续是实验性的 runtime bridge。它不是 root front door，而且当前 MCP surface 也故意比完整 `idea-engine` runtime contract 更窄。当前 idea-engine phase 已关闭，不应把它当作默认 capability expansion lane。
- `@autoresearch/hep-mcp` 继续是当前最成熟的 domain pack 与最强的端到端示例，但 HEP 不定义 root 产品身份。
- `research-harness` 是面向 Codex / Claude Code / OpenCode 的薄 external research project 入口 skill：它恢复 `autoresearch` 项目状态，把里程碑执行路由给 `research-team`，把 Markdown 笔记清理路由给 `markdown-hygiene`，把 HEP 证据工作路由给 `hep-mcp`，并把长期结论折回项目文件与 artifacts。它不是新的 CLI，也不是第二套 control plane。
- `research_brainstorm` 是 `autoresearch workflow-plan` 下的 checked-in durable harness recipe，不是新的顶层 CLI 命令，不是 idea-engine，不是 full research-team workflow，也不是 root front-door expansion。
- strict fail-closed research quality 继续成立。project-local durable memory 加 `.autoresearch/` state 仍是 reconnect truth；可选 support surfaces 继续只是 opt-in layers。

## 2. 当前公开 Surface

| Surface | Canonical 入口 | 用途 |
| --- | --- | --- |
| Stateful CLI front door | `autoresearch` | 外部 project-root lifecycle state、审批、受限原生 TS `run --workflow-id computation`，以及 stateful `workflow-plan` 持久化 |
| Control-plane MCP/operator counterpart | `orch_*` | 面向 host 的 MCP/operator surface，承载同一套 lifecycle/control-plane authority |
| Stateful 文献规划入口 | `autoresearch workflow-plan` | 通过 `@autoresearch/literature-workflows` 解析 checked-in workflow authority，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md` |
| Agent research project harness skill | `research-harness` | 面向 Codex / Claude Code / OpenCode 的薄客户端 skill，用于恢复外部项目状态、把工作路由到 `autoresearch` / `research-team` / `markdown-hygiene` / `hep-mcp`，并把结果折回长期 artifacts |
| 实验性 idea runtime bridge | `node /absolute/path/to/autoresearch-lab/packages/idea-mcp/dist/server.js` | 面向显式外部数据根的 TS hosted campaign runtime bridge，覆盖 `idea_campaign_*`、`idea_search_step`、`idea_eval_run`；post-search rank/promote 与 bounded negative failure-library reflection 属于 `idea-engine` runtime-contract truth，不是 root front door |
| 当前最成熟的领域 MCP front door | `node /absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js` | 面向研究、证据、写作、导出与 provider-local 组合的 HEP 领域 MCP server |
| Bounded provider MCP operators | `@autoresearch/openalex-mcp`、`@autoresearch/arxiv-mcp`、`@autoresearch/hepdata-mcp`、`@autoresearch/pdg-mcp`、`@autoresearch/zotero-mcp` | 保持 MCP-first 的原子化文献、数据、参考与证据 operators |

HEP 工具清单由代码拥有，并由 `HEP_TOOL_MODE` 做模式过滤；精确工具数量只保留在生成的分类/状态文档里，不写入本 README。

## 3. Layer Model

| 层 | 当前 authority | 为什么留在这里 |
| --- | --- | --- |
| Workflow authority | 由 `autoresearch workflow-plan` 消费的 checked-in recipes | 高层 workflow 语义继续位于 provider packs 之上 |
| Stateful control plane | `autoresearch` 加 `orch_*` | 持久 project/run state、审批、bounded execution、verification 与 read models 继续归于同一个 control plane |
| Agent project harness | `research-harness` skill | 面向 host client 的恢复、路由、验证、交接说明；执行仍委托给 control plane 与 domain/executor layers |
| Experimental runtime bridge | `idea-mcp` | runtime bridge 继续显式存在，并保持比完整 engine contract 更窄 |
| Domain workflow pack | `@autoresearch/hep-mcp`、`hep_*`、`hep://...` | 当前最强的端到端示例，但不升级成 root identity |
| Provider atoms | `openalex_*`、`arxiv_*`、`hepdata_*`、`pdg_*`、`zotero_*` | bounded、schema-driven MCP operators 比 provider-local CLI mirrors 更易组合 |
| Project-local truth | `.autoresearch/` 加 durable memory 文件 | reconnect truth 继续位于外部 project root，而不是开发仓本身 |

在 project-local truth 里，`research_plan.md#Current Status` 是给人看的状态入口：最终目标、当前阶段、完成状态、阻塞、下一步、停止条件和证据指针必须在长 task board / log 之前保持可扫读。`research_notebook.md` 是给人读的问题逻辑主线：按研究问题、推导、claim 与不确定性组织，不承载状态追踪，也不是按日期堆 run log。重要文献 note 必须全文/source-first 阅读，记录可审查的 section/page/equation/figure 覆盖，并用 LaTeX math 写科学记号。带日期的执行记录、原始 workflow 摘要和工具调用过程应放在 `research_plan.md` progress log 或 `artifacts/runs/<run_id>/`，再把长期有效的理解折回 notebook。给人看的 `run_id` 应是 safe、sortable、readable 的研究标识，例如 `20260502T023000Z-m3-branch-scan-r1`；provider UUID 或 `run_<uuid>` 只属于机器/provider provenance，不推荐作为 project artifact root。

Skill 源码面与分发面是分离的：

- `skills/` 存放 checked-in 的 skill 源码与手册。
- `packages/skills-market` 是 installer / distribution control plane；它不意味着这些 skill 已经预装到某个 client runtime 中。
- `research-harness` 是已进入 market 的 external research project 薄入口 skill。它故意不对 `research-team`、`markdown-hygiene` 或 `hep-mcp` 声明硬 package 依赖；这些能力仍由 host client 独立提供或安装。

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

这里的长期真相应理解为两层一起成立：

- `.autoresearch/` 中的 lifecycle / plan / approval state
- project-local durable memory，例如 `research_plan.md`、`research_contract.md`，以及已经有实质内容的 `research_notebook.md`

像 `prompts/`、`team/`、`research_team_config.json`、`.mcp.template.json`、根级 `specs/plan.schema.json` 这类 surface 都是 opt-in support layers，只应由明确项目需要或 host-specific tooling 后续创建，不是默认工作前门。

## 5. 用户如何从 MCP clients / agent clients 接入

当前的 MCP 接入模型是本地 stdio only。仓库目前还没有“单体的” generic root MCP server 可执行入口；今天最成熟的领域 MCP 入口仍是 `hep-mcp`，而 generic control plane 已经由 `autoresearch` CLI 与公开的 `orch_*` MCP/operator surface 共同构成，后者的 live truth 记录在 [`meta/docs/orchestrator-mcp-tools-spec.md`](../meta/docs/orchestrator-mcp-tools-spec.md)。换句话说，generic lifecycle/control-plane 已经不再是“只有 CLI”，只是还没有独立打包成一个 root MCP server 进程。

当前公开 MCP contract 是：本地 stdio 进程启动、tool `inputSchema`、紧凑 JSON/text tool result、少量 package-owned resources、没有 prompts。`orch_*` 是 orchestrator package 暴露的 operator/tool inventory，不是单独打包的 root MCP server。Remote MCP transports、OAuth 与 registry publishing 都仍是未来部署面，不属于当前 local-stdio contract。

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

- 对 stateful 文献工作流，先用 `autoresearch init` 初始化目标外部 project root，再在该 root 内或通过 `--project-root` 调用 `autoresearch workflow-plan`。它会直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。有意义的外部研究运行应显式传 `--run-id`；如果省略，派生的 `<recipe>-<phase>` 只作为 planning placeholder。`research_brainstorm` 是 planning-only 的轻量 durable harness：`autoresearch workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"` 会记录 brainstorm context、candidate angles、screening、单一 recommendation 与 `next_contract` handoff。`.autoresearch/plan.md` 是给人读的派生 read model，不是机器编排 SSOT。这个 contract 可以建议后续进入 `literature_landscape`、`literature_gap_analysis`、`derivation_cycle` 或 `review_cycle` 等更重 recipe，但不会自动启动它们，也不依赖 host-native thinking process。持久化的 `research_brainstorm.*` step tools 是 handoff authority，不是内置 runtime tools，除非未来有外部 tool caller 明确实现它们。

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
1. 当某个 run 已有证据后，先执行 `autoresearch verify --project-root /absolute/path/to/external-project --run-id <run_id> --status passed --summary "..." --evidence-path <path>`
1. 再执行 `autoresearch final-conclusions --project-root /absolute/path/to/external-project --run-id <run_id>`
1. 再通过 `autoresearch approve <approval_id>` 消费 A5 request，并写出 `artifacts/runs/<run_id>/final_conclusions_v1.json`

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
