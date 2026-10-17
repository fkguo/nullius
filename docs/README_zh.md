# Nullius

[English](../README.md) | 中文

> **Nullius in verba**——"勿轻信任何人的断言"。
> 这句皇家学会会训既是本仓库得名的由来，也是它的运行规则：任何结果都不因权威而成立——结论只有经过独立重推导、干净环境复现与对抗性评审，才允许写入长期记录。

Nullius 是一个面向 agent 辅助科研的 evidence-first harness。它为 AI 编码 agent（Codex、Claude Code、OpenCode 等）提供外部研究项目的生命周期与 control plane，并以 checked-in skills 规定：长期结果只有经过独立重推导、数值收敛检查、有出处的引文核验与跨模型对抗评审才被接纳；整体设计 domain-neutral。仓库本身是一个 pnpm workspace，包含 `nullius` CLI 与 control-plane 包、`skills/` 下的研究 skills、本地 MCP provider 包，以及可通过 `nullius workflow-plan` 或 agent client 消费的 workflow recipes。root 就是这个 domain-neutral 基座与 control plane；HEP 是在其上构建的、目前最成熟的 provider family 与最强的端到端 workflow 示例。


原生计算将启用的 A3 审批绑定到当前 manifest、脚本、声明的输入与依赖文件、解析后的可执行文件字节、生产环境和审批策略。packet 缺失、历史审批没有内容绑定或输入发生变化时，必须在派发前申请新的根审批；仅有步骤级 A3 而绑定失效时直接拒绝，不创建根审批请求。暂停请求允许当前直接子进程返回，保留该步骤证据，并将整体运行保持为 paused；最后一步也适用。原生计算不支持原地续行：同一运行重入和 `resume --force` 均在修改暂停产物前拒绝；另行审批的新运行是独立执行。`execution_status.json` 持久化一个覆盖 preflight、后续直接子进程与本地结果发布的绝对截止时间，重试不重置，每个子进程使用剩余总预算与步骤上限的较小值。硬 CPU、内存和磁盘约束在 preparation 阶段拒绝；这些限制不负责任意后代进程或远程作业。规范状态写入在短独占锁内比较调用者的读取快照，比较通过后才追加组合事件；过期快照拒绝，过期锁须在写入者停止后人工修复。CLI 与项目传输共用外部根目录准入，并解析未创建路径的已存在软链接祖先。

## 1. Surface Policy

- `nullius` 继续作为已初始化外部 project root 的 stateful CLI front door。lifecycle state、bounded execution、`workflow-plan`、verification、更高结论 gate、主报告结构校验、proposal decisions 与 conversational decision ledger 都从这里进入。
- `orch_*` 继续作为同一 control plane 的 MCP/operator counterpart。它是 control plane 的 host-facing bridge，不是另一个产品身份，也不是对 CLI 的替代。
- `openalex_*`、`arxiv_*`、`hepdata_*`、`pdg_*`、`zotero_*` 继续作为 bounded atomic MCP operators。它们保持 MCP-first，因为这些 surface 是 schema-driven provider atoms，而不是需要整套 CLI 镜像的 stateful workflow shell。`@nullius/hep-mcp` 同时把这些 provider 工具作为入口纳入自身工具面（复用各 provider 包的 `tooling`），因此在一个 HEP 会话里即可使用文献、数据、参考与 Zotero 能力，无需分别接入各 provider MCP。
- `idea-mcp` 继续是实验性的 runtime bridge。它不是 root front door，而且当前 MCP surface 也故意比完整 `idea-engine` runtime contract 更窄。idea-engine 的 search/eval runtime 已归档；contracts + store 保留，打分消费外部 belief-graph posterior（pinned tool，当前 pin gaia-lang==0.5.0a4），idea-engine 仍不是默认 capability expansion lane。
- `@nullius/hep-mcp` 是在 domain-neutral root 之上构建的、当前最成熟的 domain pack 与最强的端到端示例。
- `research-harness` 是面向 Codex / Claude Code / OpenCode 的薄 external research project 入口 skill：它恢复 `nullius` 项目状态，把里程碑执行路由给 `research-team`，把 Markdown 笔记清理路由给 `markdown-hygiene`，把 HEP 证据工作路由给 `hep-mcp`，并把长期结论折回项目文件与 artifacts。它不是新的 CLI，也不是第二套 control plane。
- `.nullius/HARNESS` 是 `nullius init` 写入的机器可读 runtime handshake；存在时 agent 必须先取得 `nullius status --json` receipt，再开始新工作、milestone 执行、closeout 或 handoff。
- `research_brainstorm` 是 `nullius workflow-plan` 下的 checked-in durable harness recipe，不是新的顶层 CLI 命令，不是 idea-engine，不是 full research-team workflow，也不是 root front-door expansion。
- strict fail-closed research quality 继续成立。`.nullius/HARNESS`、project-local durable memory 加 `.nullius/` state 仍是 reconnect truth；可选 support surfaces 继续只是 opt-in layers。

## 2. 当前公开 Surface

| Surface | Canonical 入口 | 用途 |
| --- | --- | --- |
| Stateful CLI front door | `nullius` | 外部 project-root lifecycle state、审批、受限原生 TS `run --workflow-id computation`、stateful `workflow-plan` 持久化、主报告结构校验，以及 `graph` 依赖图渲染（claims / progress / literature / roadmap） |
| Control-plane MCP/operator counterpart | `orch_*` | 面向 host 的 MCP/operator surface，承载同一套 lifecycle/control-plane authority |
| 绑定项目的 MCP adapter | [`@nullius/project-mcp`](../packages/project-mcp/README.md) | 通过 `NULLIUS_PROJECT_ROOT` 绑定外部项目的本地 stdio 叶层，复用 canonical control-plane 操作并提供受限项目文件传输 |
| Stateful 文献规划入口 | `nullius workflow-plan` | 通过 `@nullius/literature-workflows` 解析 checked-in workflow authority，并写入 `.nullius/state.json#/plan` / `.nullius/plan.md` |
| Agent research project harness skill | `research-harness` | 面向 Codex / Claude Code / OpenCode 的薄客户端 skill，用于恢复外部项目状态、把工作路由到 `nullius` / `research-team` / `markdown-hygiene` / `hep-mcp`，并把结果折回长期 artifacts |
| 实验性 idea runtime bridge | `node /absolute/path/to/nullius/packages/idea-mcp/dist/server.js` | 面向显式外部数据根的 TS hosted campaign lifecycle bridge，覆盖 `idea_campaign_*`；posterior 排序的 rank/promote、节点 posterior/lifecycle/grounding-audit/card-revision 更新、溯源修正与 generation-pack 导入（`node.import_generated`）属于 `idea-engine` runtime-contract truth，不是 root front door |
| 当前最成熟的领域 MCP front door | `node /absolute/path/to/nullius/packages/hep-mcp/dist/index.js` | 面向文献研究与 provider-local 组合的 HEP 领域 MCP server；其研究输出工具把文件写入调用方指定的项目内 `output_dir` |
| Bounded provider MCP operators | `@nullius/openalex-mcp`、`@nullius/arxiv-mcp`、`@nullius/hepdata-mcp`、`@nullius/pdg-mcp`、`@nullius/zotero-mcp` | 保持 MCP-first 的原子化文献、数据、参考与证据 operators |

HEP 工具清单由代码拥有，并由 `HEP_TOOL_MODE` 做模式过滤；精确工具数量只保留在生成的分类/状态文档里，不写入本 README。

## 3. Layer Model

| 层 | 当前 authority | 为什么留在这里 |
| --- | --- | --- |
| Workflow authority | 由 `nullius workflow-plan` 消费的 checked-in recipes | 高层 workflow 语义继续位于 provider packs 之上 |
| Stateful control plane | `nullius` 加 `orch_*` | 持久 project/run state、审批、bounded execution、verification 与 read models 继续归于同一个 control plane |
| Agent project harness | `research-harness` skill | 面向 host client 的恢复、路由、验证、交接说明；执行仍委托给 control plane 与 domain/executor layers |
| Experimental runtime bridge | `idea-mcp` | runtime bridge 继续显式存在，并保持比完整 engine contract 更窄 |
| Domain workflow pack | `@nullius/hep-mcp`、`hep_*` | 当前最强的端到端示例，但不升级成 root identity |
| Provider atoms | `openalex_*`、`arxiv_*`、`hepdata_*`、`pdg_*`、`zotero_*` | bounded、schema-driven MCP operators 比 provider-local CLI mirrors 更易组合 |
| Project-local truth | `.nullius/` 加 durable memory 文件 | reconnect truth 继续位于外部 project root，而不是开发仓本身 |

在 project-local truth 里，`research_plan.md#Current Status` 是给人看的状态入口并应保持简洁，`research_notebook.md` 是持续更新的问题逻辑主线；两者都不是不可变的主研究报告。被提升的主报告应是 `reports/` 下完整、面向研究者的叙事，`project_index.md#Main research report` 是唯一当前入口和 supersession registry。在结果粒度上，`project_index.md#Current results` 承担同样的登记角色：每个 headline 结果的当前行写明产生它的 run 与该 run 的精确代码版本，run 通过 origin stamp 绑定到 commit，有效性记录在 append-only validity ledger；`nullius current` 把完整答案——当前结果、产生它的代码修订、稿件指针、notebook 各节新旧、哪些 run 仍有效哪些已被取代或作废——渲染成人可以直接读的散文。机器 JSON、hash 与 receipt 只绑定 provenance，不能替代解释性叙事和可点击的人类可读证据。提升前运行 `nullius report-validate`；它检查结构、不可变 hash、链接、validation 分类与 supersession 一致性，但通过不代表科学充分性已经成立。重要文献 note 必须全文/source-first 阅读，记录可审查的 section/page/equation/figure 覆盖，并用 LaTeX math 写科学记号。带日期的执行记录、原始 workflow 摘要和工具调用过程应放在 `research_plan.md` progress log 或 `artifacts/runs/<run_id>/`，再把长期有效的理解折回 notebook。

Skill 源码面与分发面是分离的：

- `skills/` 存放 checked-in 的 skill 源码与手册。
- Julia 计算程序包用 [`julia-package`](../skills/julia-package/SKILL.md) 检查接口、数值契约和包开发规范，用 [`julia-perf`](../skills/julia-perf/SKILL.md) 检查计算内核及可复现的性能证据。
- `packages/skills-market` 是 installer / distribution control plane；它不意味着这些 skill 已经预装到某个 client runtime 中。
- `research-harness` 是已进入 market 的 external research project 薄入口 skill。它故意不对 `research-team`、`markdown-hygiene` 或 `hep-mcp` 声明硬 package 依赖；这些能力仍由 host client 独立提供或安装。

项目的非 surface 层保证 — Nullius **不是**什么、它主动防御哪些 agent 失败模式（M1–M7 + 长对话漂移）、这些保证如何被 anti-drift CI 机器强制、以及哪些借鉴概念被考虑后明确丢弃 — 见 [`docs/POSITIONING_zh.md`](./POSITIONING_zh.md)。

## 4. Files、Artifacts、State 在哪里

### `hep-mcp` 数据根目录

`@nullius/hep-mcp` 会按每次 tool call 解析数据根目录。若工具调用带有已初始化 nullius 项目的 `project_root`，HEP 状态写到 `<project_root>/artifacts/hep-mcp`。否则使用已设置的 `HEP_DATA_DIR`，再否则回退到 `~/.nullius/hep-mcp` 作为 scratch / 临时检查目录。

```text
<resolved HEP data root>/
  cache/
  downloads/
  pdg/
```

- `hep-mcp` 没有自己的 run：run、审批与生命周期属于 orchestrator，位于 `<project_root>/artifacts/runs/<run_id>/`。HEP 研究输出工具（检索导出、标识符映射、Zotero 映射、LaTeX 解析、冲突图）把文件写入调用方指定的项目内 `output_dir`（通常是当前 run 目录下的子目录），并返回项目相对路径。`output_dir` 需要 `project_root`，不能是 project root 本身，不得经过 project root 以下的符号链接，也不得位于 `.nullius/`、`team/runs/` 或 `artifacts/hep-mcp/` 之下（比较时不区分大小写）；调用从不覆盖已有文件。`inspire_paper_source` 的下载、缓存与 PDG 数据仍位于 hep-mcp 的数据根（`<project_root>/artifacts/hep-mcp` 或 `HEP_DATA_DIR`）。
- 旧版本留下的 HEP run 目录（HEP 数据根下的 `runs/<run_id>/`）与论文/evidence 项目目录（`projects/<project_id>/`，含 evidence catalog）是历史证据：原位读取，不再被任何工具创建或改写。历史 `hep://runs/...` 与 `hep://projects/...` 引用的解析规则见 [`docs/URI_REGISTRY.md`](./URI_REGISTRY.md)。
- `PDG_DATA_DIR` 是 PDG 的本地 companion root；未单独设置时跟随 resolved HEP data root，即 `<resolved HEP data root>/pdg`。
- 文本与二进制 artifacts 都保留在 package-owned artifact root 下；tool result 保持紧凑，只指回 project artifacts，避免把大 payload 内联进上下文。
- 论文原文、抽取文本、arXiv source tarball 和源码树都是普通本机文件。若只服务于本轮检查，放在本机临时目录；若后续验证或接续还需要，则放在外部 project root 中合适的 project/run artifact 子目录下。

### 通用 lifecycle state

`nullius init` 会在真实外部 project root 中初始化 `.nullius/HARNESS` 与 `.nullius/`。当前 lifecycle 包会读写：

```text
<project_root>/
  .nullius/
    HARNESS
    state.json
    ledger.jsonl
    decisions.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json          # 使用 fleet 功能时
    fleet_workers.json        # 使用 fleet 功能时
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
```

Approval packet 会落在该 run 的 `artifacts/runs/<run_id>/approvals/<approval_id>/approval_packet_v1.json` 路径下，并通过 lifecycle 命令消费。

这里的长期真相应理解为两层一起成立：

- `.nullius/` 中的 lifecycle / plan / approval state
- project-local durable memory，例如 `research_plan.md`、`research_contract.md`、已经有实质内容的 `research_notebook.md`，以及 `reports/` 下已登记的不可变报告

像 `prompts/`、`team/`、`research_team_config.json`、`.mcp.template.json`、根级 `specs/plan.schema.json` 这类 surface 都是 opt-in support layers，只应由明确项目需要或 host-specific tooling 后续创建，不是默认工作前门。

## 5. 用户如何从 MCP clients / agent clients 接入

当前的 MCP 接入模型是本地 stdio。[`project-mcp`](../packages/project-mcp/README.md) 是绑定单个外部项目的叶层 adapter，通过 `NULLIUS_PROJECT_ROOT` 指定项目，并复用 orchestrator 的 canonical tool dispatcher 与 CLI。仓库仍没有“单体的” generic root MCP server；`nullius` 保持 stateful front door，HEP 与 idea server 保持各自职责。

当前公开 MCP contract 是：本地 stdio 进程启动、tool `inputSchema`、紧凑 JSON/text tool result、没有 prompts。研究材料放置遵循 filesystem-first：临时抓取放本机临时目录，需要后续验证或接续的材料写成 project/run artifact。`orch_*` 是 orchestrator package 暴露的 operator/tool inventory，不是单独打包的 root MCP server。Remote MCP transports、OAuth 与 registry publishing 都仍是未来部署面，不属于当前 local-stdio contract。

[本地个人插件构建器](../packages/skills-market/docs/PERSONAL_PLUGIN.md) 同源复制现有技能，生成 Codex 与 Claude Code 清单，默认组合 `project-mcp`、`hep-mcp`、`idea-mcp`，不重复注册原子 provider。普通安装和插件均通过本机已安装的 `nullius` CLI 定位运行包，生成的清单与技能元数据不记录构建者路径。项目、provider 和数据路径由宿主环境或私有 `${XDG_CONFIG_HOME:-$HOME/.config}/nullius/runtime.json` 配置；也可用 `NULLIUS_RUNTIME_CONFIG` 指向分发目录外的绝对文件。project 和 idea 服务要求外部项目，idea 还需 `IDEA_MCP_DATA_DIR`；HEP 可独立运行，配置项目时以该项目为 cwd。外部工具仍需本机安装。文件 API 限定项目路径，但本机脚本执行没有 OS sandbox；审批留在本地主机，sampling 需要客户端支持并保持前台连接，缺少时返回 `unavailable`。本地执行与组合已验收；ChatGPT Chat/Work 与 Claude 宿主连接尚未验收，需要的 tunnel/app ID 留待用户配置，构建器不会创建应用连接或上架插件。

通用 MCP 配置模式：

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

说明：

- 先构建：`pnpm -r build`。
- MCP env 里的路径是 filesystem roots，不是 URI/protocol 设置。持久 nullius 项目工作应在 HEP tool call 中传入已初始化的 `project_root`，让 hep-mcp 的下载、缓存与 PDG 数据写到 `<project_root>/artifacts/hep-mcp`，工具输出文件写到你在项目内指定的 `output_dir`。`HEP_DATA_DIR` 只作为 scratch fallback，或用于一次性检查、CI、迁移等显式 override。
- 如果 `nullius` 不在 `PATH` 中，构建后创建本地 wrapper：

```bash
mkdir -p "$HOME/.local/bin"
ln -sf /absolute/path/to/nullius/packages/orchestrator/dist/cli.js "$HOME/.local/bin/nullius"
chmod +x "$HOME/.local/bin/nullius"
nullius --help
```

  当前仓库是本地 workspace，不是已发布的全局 npm CLI。上面的 wrapper 是从源码 checkout 给可执行 shell 命令的 agent client 准备 CLI 的通常路径。`nullius init` 也会写入 project-local launcher，所以已初始化的研究目录即使没有全局 wrapper，也可以继续运行 `./.nullius/bin/nullius status --json`。
- GUI 客户端有时需要把 `node` 换成绝对路径。
- 有些客户端会把工具名 namespacing 成 `mcp__<serverAlias>__<toolName>`；务必以客户端实际显示的名字为准调用。
- 常见的 MCP-compatible client 包括 Cursor、Claude Desktop、Claude Code CLI、Chatbox、Cherry Studio、Continue、Cline、Zed。
- lifecycle CLI 与 MCP 配置分离，直接在 shell 中调用：

```bash
nullius init --project-root /absolute/path/to/external-project
nullius status --project-root /absolute/path/to/external-project
```

- 对 Codex、Claude Code、OpenCode、Cursor、Kimi-code 等 agent client，通常使用同一段幂等启动指令覆盖第一次使用和后续恢复：

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
Stamp each run's code origin at creation with: nullius trace stamp <run_id>
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

新 decision 条目先使用 6 字符的 branch-local handle，其原始抽样为 30 个无偏随机 bit（$32^6 = 2^{30}$）。与 durable `D<n>` 同形的候选、本地已有 id 与既有映射都会重抽，因此精确的逐对碰撞概率依上下文而变；无本地占位时为 $1/(2^{30}-90{,}000)\approx 9.314\times 10^{-10}$，略高于 $2^{-30}$。这是概率保证而非结构保证，碰撞时 fail closed。`--resolves` 是关闭关系，只接受仍然 open 的 `pending` 目标；`--relates` 是非关闭关系，可以指向更早且可读的 `decided` 或 `pending` 条目。回放时若持久化关系格式错误或语义不成立，工具会在 `unrecognized_relations` 中报告并忽略该链接，但不会让整条记录失效。旧版或未知的、含非空白字符的字符串 `kind` 会继续按当前 `decided` 语义读取，并通过 `source_kind` 与 `normalized_kinds` 保留原始拼写；只有精确的持久化 `pending` 才会创建 open item，而归一化条目上其余合法的 `resolves` 仍会关闭对应 pending。分支内容进入权威主干后，`decision land` 原子分配后续 durable `D<n>`、改写指向 handle 的关系，并以 `provisional_id` 保留映射。既有 `D<n>` ledger 无需迁移，仍可读取和 resolve。若同一 provisional id 映射到多条记录或又被用作当前 id，list/status 会具名冲突行，land 在零改写下拒绝。初始化完成后，接续是 local-first 的：`.nullius/HARNESS`、`.nullius/bin/nullius`、`AGENTS.md`、`project_index.md`、`research_plan.md`、`research_contract.md`、已登记报告和 `artifacts/runs/<run_id>/` 足以让 agent 在关闭会话或断网后恢复项目状态；只有真实需要外部文献/数据时才需要网络。

- 对 stateful 文献工作流，先用 `nullius init` 初始化目标外部 project root，再在该 root 内或通过 `--project-root` 调用 `nullius workflow-plan`。它会直接通过 `@nullius/literature-workflows` 解析 recipe，并写入 `.nullius/state.json#/plan` / `.nullius/plan.md`。有意义的外部研究运行应显式传 `--run-id`；如果省略，派生的 `<recipe>-<phase>` 只作为 planning placeholder。`research_brainstorm` 是 planning-only 的轻量 durable harness：`nullius workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"` 会记录 brainstorm context、candidate angles、screening、单一 recommendation 与 `next_contract` handoff。`.nullius/plan.md` 是给人读的派生 read model，不是机器编排 SSOT。这个 contract 可以建议后续进入 `literature_landscape` 或 `literature_gap_analysis` 等更重 recipe，但不会自动启动它们，也不依赖 host-native thinking process。持久化的 `research_brainstorm.*` step tools 是 handoff authority，不是内置 runtime tools，除非未来有外部 tool caller 明确实现它们。
- delegated agent 执行现在在 tool 边界持久化：attempt 明确区分 `not_started`、`outcome_unknown` 与 `committed`；副作用结果未知时停机交 operator 核对，已提交的 MCP result 原样 replay 而不再次派发。direct 与 team journal 分别位于 `artifacts/delegated-runs/direct/<run_id>/` 和 `artifacts/delegated-runs/team/<runtime_run_id>/`，caller 自选的 root/direct run id 无法冒充 team checkpoint；approval resolver 只允许 host/operator 调用。`nullius run` 启动配置的 stdio MCP server 时，非敏感配置写入 `NULLIUS_RUN_MCP_ENV_JSON`，凭据写入 `NULLIUS_RUN_MCP_CREDENTIALS_JSON`，必需凭据名可用 `NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON` 声明；缺值会在 spawn 前失败。

持久化 workflow-plan 的每次派发也使用 `artifacts/runs/<run_id>/manifest.json`：未知副作用停止等待核对，已提交响应原样回放而不重调工具；每个派发边界检查暂停，审批请求在真实批准前不会完成步骤。溢出恢复逐字保留原始用户约束，且不拆开工具调用与其结果（较早的交换整段丢弃，过长的结果截为带标记的不完整摘录）；指令自身超出窗口时停止，不能静默截断。

## 6. 更深的架构 / 治理文档在哪里

- [架构总览](./ARCHITECTURE.md)
- [测试指南](./TESTING_GUIDE.md)
- [项目状态](./PROJECT_STATUS.md)
- [工具分类](./TOOL_CATEGORIES.md)
- [英文 README](../README.md)
- [仓库治理规则](../AGENTS.md)
- [开发契约](../meta/ECOSYSTEM_DEV_CONTRACT.md)

面向维护者的重构计划、remediation tracker、执行 prompt，以及本地 legacy workflow 说明不再作为公开仓库内容发布。

## Quick Start

```bash
pnpm install
pnpm -r build
pnpm --filter @nullius/hep-mcp docs:tool-counts:check
```

如果你想先走 generic lifecycle/control-plane 烟测路径：

1. `nullius init --project-root /absolute/path/to/external-project`
1. `nullius status --project-root /absolute/path/to/external-project`
1. 当某个 run 已有声明证据与 decisive checker 后，执行完整命令（有多个证据、reference、争议维度或负控制时重复相应 flag）：

   ```bash
   nullius verify --project-root /absolute/path/to/external-project --run-id <run_id> --status passed --summary "operator expectation note" --evidence-path computation/outputs/result.json --checker-path verification/decisive_checker.py --checker-runtime python3 --quantity-id quantity:declared-result --layer-id layer:production-output --reference-provenance-json '{"reference_id":"reference:oracle-v1","uri":"rep://runs/<run_id>/artifact/references%2Foracle.json","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}' --disputed-dimension normalization --required-negative-control-id negative-control:zero-input
   ```

   请把示例中的 64 个零替换为所声明 reference 的实际小写 SHA-256；完整 flag contract 可查 `nullius verify --help`。CLI status 只是必须与 checker verdict 相等的 expectation；CLI summary 是非权威 operator note；最终记录与之匹配的 checker-emitted status、summary 和 check kind。Nullius 保存产生计算的相邻 snapshots，并检查 checker 自报的 observations 是否与内部持有的输出哈希一致。recorded pass 不证明 checker 实际打开了输出或实际执行了具名负控制。依赖/import closure 明确仍是不完整的：没有 syscall tracing，也没有 installed-byte 或 isolated-image binding。
1. 执行 `nullius final-conclusions --project-root /absolute/path/to/external-project --run-id <run_id>` 检查 fail-closed 边界。当前只支持恰好一个 canonical subject；由于所有现有 validation binding 都声明 incomplete dependency closure，该命令返回 `unavailable`，不会创建或解锁 A5 approval。

如果你接着想走当前最强的 domain-pack 烟测路径，再把 MCP client 接到 `packages/hep-mcp/dist/index.js` 并执行：

1. 调用 `hep_health`
1. 若是持久项目工作，每次 HEP tool call 都传入 `project_root=/absolute/path/to/external-project`
1. 调用 `hep_inspire_search_export`，传入 `project_root` 与 `output_dir`（如 `artifacts/runs/<run_id>/literature`）；检查返回的项目相对 `export_path` / `meta_path`，以及 `<output_dir>/external_api/` 下的逐次外部 API 记录

run、通用生命周期与审批仍归 orchestrator。`hep-mcp` 不提供项目或 evidence catalog、草稿渲染、项目导出或论文打包工具；论文源码用 `arxiv_paper_source` / `inspire_paper_source` 读取，对照原文核对的结果记入项目自己的笔记。

## 文档

- [功能测试指南](./TESTING_GUIDE.md)
- [项目状态](./PROJECT_STATUS.md)
- [架构总览](./ARCHITECTURE.md)
- [pdg-mcp 文档](../packages/pdg-mcp/README_zh.md)

## Development

检查 front-door drift 时，优先看：

- `packages/hep-mcp/tests/docs/docToolDrift.test.ts`
- `pnpm --filter @nullius/hep-mcp docs:tool-counts:check`
- `pnpm --filter @nullius/hep-mcp test -- tests/docs/docToolDrift.test.ts`

## 引用

如果 Nullius 对你的工作有所帮助，请引用你实际使用的版本。每个 GitHub Release 都会自动归档到 Zenodo 并获得独立 DOI；当前 Release 的 DOI 记录在 [`CITATION.cff`](../CITATION.cff) 中（GitHub 会在仓库页 "Cite this repository" 处渲染）。在首个归档 Release 发布之前，可直接引用仓库：

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

新生成的受控项目运行统一位于 `artifacts/runs/<run_id>/`，team/draft 执行记录放在其 `research_team/` 子目录，来源记录盖章在父 run 上。旧 `team/runs` 保留为只读证据，状态、列表、索引和导出使用其原位置，不改写来源、有效性或结果引用；`init --runtime-only` 可重新连接而不移动证据。同名编号明确报告歧义，不可读历史位置报告为不可用，不阻断无关的可读记录。`inventory_run_relocation.py --fixture-root <匿名fixture> --source-manifest <哈希清单>` 只盘点已固定输入的引用、冲突与未解决绑定，没有 apply 模式。独立 reviewer 快照排除所有轮次的执行 payload 和工作区树，保留生产输入；读取仅允许自己的声明输出前缀。历史报告与裁决保留给协调者。`team/LATEST*.md` 与 `artifacts/LATEST.md` 只提供导航。

通用 scaffold 创建 `project_index.md`；team helper 只维护执行器本地导航指针，根索引缺失时要求 `nullius init`。结果登记和派生区块写入共用短路径锁，重新读取输入，对检测到的编辑最多尝试三次，保留区块外人工内容、模式和换行。忽略该锁的任意写入者不在锁的保证范围内。通用运行计数不解释执行轮次上限；这些设置由 Python 执行器解析和后缀门负责。

既有的 `PROJECT_INDEX_AUTO` 块是历史记录，不再维护；team helper 不解析也不更新它。当前 `RUN_INDEX` 导航和人工选择的结果／报告登记区由各自的写入者维护。不要静默改写或删除旧块。

历史 `team/runs/<run_id>/` 仍可读取、索引、引用和导出，保留原路径与有效性记录；新运行只写 `artifacts/runs/<run_id>/`。历史编号不能用于新执行。同名目录报告歧义，导出可用 `--run-root team/runs` 指定原位置。不可读历史目录报告为不可用，不阻断无关的可读记录。

科研结果采用时，engine 与 file 模式都须重写 notebook 中受影响的正文，保留假设、推导步骤、解释和局限，并直接链接已登记的结果文件。完成编辑并刷新自动块后，运行 `nullius notebook review --model claude/opus`，以重复的 `--dependency <project-relative-path>` 声明必要依赖，再运行 `nullius notebook check --json`。检查分别报告 `structure`（`result_links`）与 `content_review`；只有结构通过且当前全篇正文审查 accepted 才成功。`--result` 只缩小链接范围，正文始终审查全文；`--structure-only` 的成功只证明导航。

正文审查实际调用 reviewer，默认总硬超时 1200 秒、最多 64 次有界调用、每次一次尝试且不自动重试。输入冻结完整 UTF-8 notebook（包括自动块）与依赖的实际字节 SHA-256，涵盖未提交编辑；字节变化使旧报告 stale，历史报告仍可读取。逐节全文覆盖与源锚定理由须检查推导完整性、逻辑、符号、定义、假设和约定。缺失、部分、失败、unavailable、invalid 或 stale 均不能通过。链接、自动表、公式数量、勾选项和作者自评不能替代正文判定。`current` 与 `status` 的 `notebook.content_review` 只读报告，不自动启动 reviewer，也不妨碍普通状态和历史读取。语义审查不证明科学真理，单 reviewer 的独立性局限须明确保留；具体结论仍须对应的推导、数值或文献验证。详见[笔记检查范围](../packages/orchestrator/README.md#human-notebook-integration)。

收敛 fold 与最终 file closeout 都必须调用无 `--result` 的 `nullius notebook check --json`；`none` 声明或 launcher 缺失不构成例外。`--result` 仅用于缩小结构诊断范围，不能替代覆盖所有当前结果的最终默认检查。

默认结构检查要求结果注册表存在且有效，并检查全部登记行，包括已被替代的行；只有当前结果须在人工正文中有直接链接。closeout 检查失败时，普通状态和历史读取仍可使用。

合法 UTF-8 文本不因体积变大而归为 `opaque_links`，Markdown 依赖递归发现。只有二进制或无效 UTF-8 的自动链接来源作为不可变快照及哈希定位符；报告须逐项说明 path/hash/`required_for_reasoning`，必要但未读的来源不能通过。notebook 与显式依赖须为严格 UTF-8，并使用 LF 或 CRLF。

完整原材料先冻结；存储预算与模型单次请求分开：`--snapshot-bytes` 默认 512 MiB、`--max-files` 默认 256，`--context-bytes` 控制请求体积，`--context-tokens` 声明可用后端的上下文窗口（默认 200,000 tokens，保留指令及输出余量）。默认以字节数作保守 token 上界；显式扩大字节预算后，如该上界超过窗口，则须有执行时记录的后端 token 用量。缺少容量证据、后端压缩原上下文或投递失败均不能通过。

大材料逐个原文区间审读，附相邻原文；随后联合审读接收完整 notebook 与所有文本依赖，检查跨章符号、定义、假设、约定和推理。所有区间与联合审读均完整且 fresh 才可接受，不能用精选引文或摘要代替原文。默认总执行预算 1200 秒、64 次调用（`--timeout-secs`、`--max-batches`），每次只有一次尝试，无自动重试。预算不足报告完整冻结量、待审区间、联合审读欠缺、原因及续审命令；材料枚举未完成时只报告已发现量，并明确闭包不完整。`--resume <run-id>` 新建运行并复核旧收据及原材料身份，保留显式依赖与存储预算，不改旧证据。完整联合原文若超出可用后端窗口，须提高实际可用容量或保持 incomplete。目前仅接受 tool mode `none`；多个批次仍是一次语义审查，不构成多份独立验证或跨家族 quorum。

启用 full-access 独立复现门时，须用 `--reproduction-packet <中性输入文件>` 或 `research_team_config.json` 中的 `independent_reproduction.blind_packet` 提供中性问题、约定与完整原始输入，不携带作者答案或待检实现。两个成员阶段都使用其冻结原文和复现指令；完整候选材料供协调者及其他审读步骤使用。成员通过受审计的 `files_written` 请求写入完整源码，再请求实际执行。新调用的 source assessor 检查实际读取、命令输入、源码构建、执行与方法适用性；输入路由或数值遮蔽本身不证明盲性。同一／相似可靠方法、同一模型家族的两份真正独立构建可以计数，方法与家族多样性另列。作者勾选、导入评语、受污染输入、原实现重跑或相关方法缺陷均不能提供当前确认；至少两份有效独立证据的门槛不变。

容量证据必须附带本机运行时对实际成功调用的来源记录，即使请求满足保守字节上界也一样。该记录绑定完整原始请求、报告、实际工作目录与捕获内容，重算项目摘要不能伪造运行来源。这项验证信任本机运行时及操作系统账户，不证明外部服务或科学结论的正确性。历史未签发记录仍可读取，但不能支持新的容量验收，也不得补签。

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.

研究输出保存、按用途分类、只读清单、提交检查及运行来源快照前的自动拦截见[研究输出存储](RUN_STORAGE.md)。存储命令不会删除数据、改写历史或清空恢复记录。
