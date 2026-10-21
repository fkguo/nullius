# QUICKSTART

本指南提供两段最常用路径：
- **Generic First-Touch**：初始化外部研究项目并取得生命周期状态。
- **HEP 文献路径**：把检索导出、标识符映射等研究输出写入项目文件，并取得论文源码按原文阅读。

本页面向当前最成熟的 domain pack 上手路径，而不是重新定义 root 产品身份。generic lifecycle + workflow-plan front door 仍是 `nullius`；这里的 `hep_*` 路径只是在此基础上进入 HEP 文献与证据工具。

> 参数名以当前 Zod schema 为准；请始终以 MCP tool `inputSchema` 为最终准据。


原生计算将启用的 A3 审批绑定到当前 manifest、脚本、声明的输入与依赖文件、解析后的可执行文件字节、生产环境和审批策略。packet 缺失、历史审批没有内容绑定或输入发生变化时，必须在派发前重新审批。暂停请求允许当前直接子进程返回，保留该步骤证据，并将整体运行保持为 paused；最后一步也适用。原生计算不支持原地续行：同一运行重入和 `resume --force` 均在修改暂停产物前拒绝；另行审批的新运行是独立执行。`execution_status.json` 持久化一个覆盖 preflight、后续直接子进程与最终收尾的绝对截止时间，重试不重置，每个子进程使用剩余总预算与步骤上限的较小值。硬 CPU、内存和磁盘约束在 preparation 阶段拒绝；这些限制不负责任意后代进程或远程作业。规范状态写入在短独占锁内比较调用者的读取快照，比较通过后才追加组合事件；过期快照拒绝，过期锁须在写入者停止后人工修复。CLI 与项目传输共用外部根目录准入，并解析未创建路径的已存在软链接祖先。

运行时复制或移动到其它位置后，原开发仓及其它 Nullius 开发仓副本仍不能作为真实研究项目根。

## Updating existing project guidance

更新运行时不会自动更新课题里的定制指导文件。`nullius init --refresh` 会生成缺失的
`AGENTS.md`，但保留已有且与模板不同的文件。`--runtime-only` 接续运行时握手和入口，
不改写定制指导；CLI 仍可能同步笔记和索引中已存在的机器维护块。笔记字节改变后，
原有审查可能过期，需要按当前材料重新核对。两种更新都不能代替对旧指导文件的合并。

先用 Git 或课题已有的备份方式保存当前指导文件与研究记录。在原课题根目录执行：

```bash
nullius init --runtime-only
./.nullius/bin/nullius status --json
guidance_preview_root="$(mktemp -d "${TMPDIR:-/tmp}/nullius-guidance.XXXXXX")"
nullius init --project-root "$guidance_preview_root"
diff -u AGENTS.md "$guidance_preview_root/AGENTS.md"
```

`diff` 返回 1 表示存在差异。只把需要的指导合并回原文件，保留课题的研究约定、授权边界、
读序与其他定制内容；不要整份复制，也不要用 `init --force` 更新既有课题。
已有 `CLAUDE.md` 或其他宿主规则也需要按内容检查，不能用新模板覆盖。
同时对照预览中的 `research_notebook.md`，只合并需要更新的操作说明，保留原有科学内容。
课题已有的 prompts、team packet 或复制安装的技能操作说明也需要按来源检查；模板更新不会
覆盖它们。复制安装应重新安装并核对来源版本；链接安装应确认仍指向所用源码。

针对旧版笔记审查说明，核对以下变化：

- 有效 UTF-8 文本不会因大小而变成 `opaque_links`；删除旧的 1 MiB 文本总量限制。
  链接到的二进制或无效 UTF-8 文件仍只是不可作为已读证据的快照。
- 用本次生成的模板与 `nullius notebook --help` 核对存储、文件数、单次请求、时间和调用次数预算，
  替换旧的 64 MiB 快照限制。存储容量与模型上下文容量分开计算。
- 大材料逐段读取原始文本，随后联合审查完整原文。任一必需输入或联合审查超出容量时，
  保持 incomplete/unavailable；摘要、截断与增加批次不能替代完整原文覆盖。
- 恢复未完成审查会创建新运行，并重新核对原材料和可复用记录；保留旧证据。
  当前仍只接受 tool mode `none`；多个批次不构成独立复核。

合并后再次查看差异，确认只有预期段落改变，再保存本次更新。检查完成后删除生成预览：

```bash
rm -rf "$guidance_preview_root"
```

## 文献流程执行后的验收

`nullius run` 的 `status: completed` 表示计划执行完毕；同时查看
`workflow_acceptance.status` 和 `ok`。必需检查未通过时命令返回非零，执行状态仍保持真实的
completed。先按 `findings` 补齐当前运行的检索记录、饱和证据、核心论文阅读笔记和原始全文，
再用返回的 `identity.plan_sha256` 与 `identity.outputs_sha256` 绑定饱和文件。具体格式见
[文献工作流契约](../packages/literature-workflows/README.md#workflow-evidence-acceptance)。

对同一已完成计划再次运行 `nullius run` 会重新验收，不重复检索。`nullius status --json`
只读核对验收记录是否仍然有效。旧课题不会自动获得通过记录；旧证据应保留原字节，
在当前运行另行建立证据文件和绑定，不能把旧运行改称本次执行。已有课题的定制指令不变。
检查通过表示文件与声明覆盖满足结构要求，不能替代全文内容复核或科学结论验收。

## Generic First-Touch（先走 generic front door）

普通安装、独立 skills 和[个人插件](../packages/skills-market/docs/PERSONAL_PLUGIN.md)共用本机 Nullius CLI。先在 checkout 根目录构建并安装命令入口：

```bash
pnpm install --frozen-lockfile
pnpm -r build
mkdir -p "$HOME/.local/bin"
ln -sf "$(pwd)/packages/orchestrator/dist/cli.js" "$HOME/.local/bin/nullius"
chmod +x "$HOME/.local/bin/nullius"
export PATH="$HOME/.local/bin:$PATH"
nullius --help
nullius runtime path
nullius init --project-root /absolute/path/to/research-project
```

路径只由每位用户的本机安装决定。复制安装的 skills 优先使用显式 `NULLIUS_WORKSPACE_ROOT`、源文件所在 checkout，或 `nullius runtime path`；迁移 checkout 后更新命令入口即可，不需要修改已复制的 skills。将 PATH 同样配置给实际运行 MCP 的宿主；终端中的 export 不会自动配置 GUI 应用。

MCP 可直接使用 `nullius runtime mcp <server>`。在私有 `${XDG_CONFIG_HOME:-$HOME/.config}/nullius/runtime.json` 中设置 `servers.<server>.env`，或用 `NULLIUS_RUNTIME_CONFIG` 选择其他绝对配置文件；该文件留在分发目录之外。示例：

```json
{
  "servers": {
    "project-mcp": {"env": {"NULLIUS_PROJECT_ROOT": "/absolute/path/to/research-project"}},
    "idea-mcp": {"env": {"NULLIUS_PROJECT_ROOT": "/absolute/path/to/research-project", "IDEA_MCP_DATA_DIR": "/absolute/path/to/idea-data"}},
    "hep-mcp": {"env": {"HEP_TOOL_MODE": "standard"}}
  }
}
```

每个服务的配置覆盖宿主环境。默认配置不存在时使用宿主环境，显式指定的配置缺失或无效则拒绝启动。project 和 idea 服务必须绑定外部项目，idea 还需外部数据目录；HEP 可独立启动。需要组合插件时再运行：

```bash
python3 packages/skills-market/scripts/build_personal_plugin.py \
  --source-root "$PWD" \
  --output /absolute/path/to/plugins/nullius
```

生成的清单组合 `project-mcp`、`hep-mcp` 和 `idea-mcp`，不另列 HEP 已组合的原子 provider，也不写入本机目录或凭据。生成后可直接搬到另一台机器，由目标机器提供 CLI、配置及外部工具。本步骤不安装 marketplace、不建立 ChatGPT 连接，也不提供外部模型登录。Chat/Work/Claude 宿主接通及所需 tunnel/app ID 仍待用户配置和验收。

[`project-mcp`](../packages/project-mcp/README.md) 初始化项目后，先调用 `project_cli` 的 `status` 或 `orch_run_status` 获取当前项目状态；state 或 ledger 变化后再次调用，再继续项目读写。缺失、过期或属于其他项目的核验记录会阻止新操作。status、能力查询、交付查询和已有请求的精确重放仍可用于恢复。

后台变更请求需稳定的 `delivery_id`；断线后用该 ID 查询 `project_delivery_read`，不要换 ID 重试未知副作用。`outcome_unknown` 需要本地核对，`finalizing` 要等项目锁释放，`committed` 仅表示原始响应已保存，仍须读取响应和 canonical 研究状态来判断成败。审批在本地主机完成；sampling 仅在客户端支持且前台连接持续时可用。项目文件边界不等于本机脚本的 OS sandbox。

在 Codex / Claude Code / OpenCode 里继续一个外部研究项目时，优先安装或启用 `research-harness` skill。它不是新的 CLI；它会指导 agent 先读取 `.nullius/HARNESS`、`.nullius/`、`research_plan.md#Current Status`、`research_contract.md` 与相关 `artifacts/runs/`，再把生命周期操作交给 `nullius`、把里程碑推进交给 `research-team`、把 Markdown 笔记清理交给 `markdown-hygiene`、把 HEP 文献/证据工作交给 `hep-mcp`。

若项目已提升主研究报告，还要从 `project_index.md#Main research report` 读取唯一当前报告及其 supersession registry。

给 Codex、Claude Code、OpenCode、Cursor、Kimi-code 等 agent 的通常启动指令应当是幂等的：同一段话同时覆盖第一次使用、关闭后重启、断网后恢复。

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

新 decision 条目先使用 6 字符的 branch-local handle，其原始抽样为 30 个无偏随机 bit（$32^6 = 2^{30}$）。与 durable `D<n>` 同形的候选、本地已有 id 与既有映射都会重抽，因此精确的逐对碰撞概率依上下文而变；无本地占位时为 $1/(2^{30}-90{,}000)\approx 9.314\times 10^{-10}$，略高于 $2^{-30}$。这是概率保证而非结构保证，碰撞时 fail closed。`--resolves` 是关闭关系，只接受仍然 open 的 `pending` 目标；`--relates` 是非关闭关系，可以指向更早且可读的 `decided` 或 `pending` 条目。回放时若持久化关系格式错误或语义不成立，工具会在 `unrecognized_relations` 中报告并忽略该链接，但不会让整条记录失效。旧版或未知的、含非空白字符的字符串 `kind` 会继续按当前 `decided` 语义读取，并通过 `source_kind` 与 `normalized_kinds` 保留原始拼写；只有精确的持久化 `pending` 才会创建 open item，而归一化条目上其余合法的 `resolves` 仍会关闭对应 pending。分支内容进入权威主干后，`decision land` 原子分配后续 durable `D<n>`、改写指向 handle 的关系，并以 `provisional_id` 保留映射。既有 `D<n>` ledger 无需迁移，仍可读取和 resolve。若同一 provisional id 映射到多条记录或又被用作当前 id，list/status 会具名冲突行，land 在零改写下拒绝。初始化完成后，接续是 local-first 的：`.nullius/HARNESS`、`.nullius/bin/nullius`、`AGENTS.md`、`project_index.md`、`research_plan.md`、`research_contract.md`、当前主研究报告和 `artifacts/runs/<run_id>/` 足以让 agent 在关闭会话或断网后恢复项目状态；只有真实需要外部文献/数据时才需要网络。

如果你还没初始化外部 project root，先走这一条：

1) `nullius init --project-root /absolute/path/to/external-project`
- 建立 `.nullius/HARNESS` runtime handshake 与 `.nullius/` lifecycle/control-plane 状态。

2) `nullius status --project-root /absolute/path/to/external-project`
- 确认 lifecycle state、审批与后续 workflow-plan / computation 入口可见。

恢复 `nullius run` 时，未知副作用会停止等待核对，已提交响应可回放而不重调。暂停阻止下一步；审批请求保留未完成步骤，必须由宿主实际批准后才能继续。不要把未知结果的中断当作普通失败反复重派。

3) `nullius workflow-plan --recipe literature_landscape`
- 如需高层 literature planning front door，可先完成这一步；随后再按下方 HEP 文献路径使用 domain-pack 工具。

如果你只想先把一个研究题目收敛成后续 handoff contract，而不启动重流程，可以使用 `research_brainstorm` durable harness：

```bash
nullius workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"
```

它会持久化 `.nullius/state.json#/plan` 并派生 `.nullius/plan.md` read model，输出的 `next_contract` 可建议后续 `literature_landscape` 或 `literature_gap_analysis`，但不会自动升级到这些 recipe。这个 harness 是 planning-only：持久化的 `research_brainstorm.*` step tools 是 handoff authority，不是内置 runnable tool chain。host-native thinking process 不属于这个 recipe 的 contract；它也不是 idea-engine、不是 full research-team、不是新的 root front door。

研究记录约定：`research_plan.md#Current Status` 是简洁状态入口，`research_notebook.md` 是持续更新的问题逻辑主线；二者都不能冒充主研究报告。主报告从 `reports/main_research_report_template.md` 创建为不可变新文件，经 `project_index.md#Main research report` 登记并指向唯一当前版本，再以 `nullius report-validate` 检查结构、hash、链接、supersession 与 validation 分类。该检查通过不等于科学充分性通过。机器 JSON、hash、receipt 只绑定 provenance，不能替代解释性叙事与可点击的人类可读证据。重要文献 note 必须全文/source-first 阅读，记录 section/page/equation/figure 覆盖，并用 LaTeX math 写科学记号；带日期的 run log、原始检索摘要、下载尝试和控制面观察写入 `research_plan.md` progress log 或 `artifacts/runs/<run_id>/`，再把稳定理解折回 notebook。

`research-team` 的新 team/draft cycle 使用 `artifacts/runs/<run_id>/research_team/` 保存 packet、日志、检查点与成员工作区；来源记录盖章在父 run 上。它们可被证据引用，但完整结论仍须写入新的不可变报告，并通过 `project_index.md#Main research report` 切换入口。

## HEP 文献路径

先在外部研究项目执行 `nullius init` 和 `nullius status --json`，并在每次持久 HEP 调用中传入其绝对 `project_root`。run、审批与通用生命周期只由 orchestrator 管理（`artifacts/runs/<run_id>/`）；`hep-mcp` 没有自己的 run，也不建项目或 evidence catalog。

1) 把检索结果导出成项目文件：`hep_inspire_search_export`（或带 `output_dir` 的 `inspire_search`）、`hep_inspire_resolve_identifiers`
- 关键参数：`project_root` + `output_dir`。`output_dir` 相对 `project_root` 或写成绝对路径，不存在时创建；不得经过 project root 以下的符号链接，不得位于 `.nullius/`、`team/runs/`、`artifacts/hep-mcp/` 之下，也不能是 project root 本身。通常取当前 orchestrator run 目录下的子目录，例如 `artifacts/runs/<run_id>/literature/`。
- 返回项目相对路径（`export_path`、`meta_path`、`mapping_path` 等）；导出所用的每次 INSPIRE 请求/响应记录在 `<output_dir>/external_api/`。`inspire_parse_latex`、`inspire_theoretical_conflicts` 与 `hep_import_from_zotero` 同样写入 `output_dir`。

2) 读论文原文：`arxiv_paper_source` / `inspire_paper_source`（`mode=content`）取得 LaTeX 源码或 PDF
- 论断是否得到支持须对照原文核对；把核对所用的位置（章节、公式号、页码）记入项目笔记。

3) `nullius workflow-plan --recipe literature_landscape`
- 先在目标外部 project root 执行 `nullius init`，然后在该 root 内或通过 `--project-root` 调用；这是一个公开的 stateful front door，会直接通过 `@nullius/literature-workflows` 解析 checked-in workflow authority，并写入 `.nullius/state.json#/plan` / `.nullius/plan.md`。对受限论文集分析使用 `inspire_critical_analysis`、`inspire_classify_reviews`、`inspire_theoretical_conflicts` 等 bounded operators。

> 说明：较底层的 checked-in Python `workflow-plan` consumer 与 internal regression/parser-residue 路径见 `docs/TESTING_GUIDE.md`；不要把它们当成新的 quickstart 默认入口。

若后续用 `nullius run` 驱动配置的本地 stdio MCP server，请把普通配置与凭据分开：`NULLIUS_RUN_MCP_ENV_JSON` 只放非敏感 string map，`NULLIUS_RUN_MCP_CREDENTIALS_JSON` 放显式凭据；需要鉴权的 server 再用 `NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON` 声明必需 key，使缺失凭据在 spawn 前失败。委托 runtime 对结果未知的副作用不会自动重试，而是以 `outcome_unknown` 停机等待核对；direct 与 team journal 分别位于 `artifacts/delegated-runs/direct/<run_id>/` 和 `artifacts/delegated-runs/team/<runtime_run_id>/`，也不与 root run 的 `artifacts/runs/<run_id>/` 共用 namespace。

hep-mcp 不提供草稿渲染、项目导出或论文打包工具；稿件在项目内另行编写与编译（例如用 `research-writer` skill 搭建 RevTeX 稿件）。旧版本留下的 HEP run 目录（`<project_root>/artifacts/hep-mcp/runs/<run_id>/` 等）是历史证据，原位读取，不被任何工具创建或改写；`hep://runs/...` 引用的人工解析规则见 [`docs/URI_REGISTRY.md`](./URI_REGISTRY.md)。

## 常见提示

开发 Julia 计算程序包时，使用 [`julia-package`](../skills/julia-package/SKILL.md)
检查接口、依赖、数值状态、测试和文档，并为计算内核组合
[`julia-perf`](../skills/julia-perf/SKILL.md)。两者可以独立于研究状态系统使用。
已有外部项目的常驻指令不会随模板自动更新；需要时显式添加这条路由。

- 若提示 `output_dir requires project_root`：同时传入已初始化项目的绝对 `project_root`。
- 若提示输出文件已存在（`already exists`）：工具从不覆盖已有输出；换一个新的 `output_dir`（或新的文件名）再调用，旧结果保持原样。调用失败时会撤回本次已发布的文件；若清理失败，错误会写明残留：已发布的文件删不掉时，错误为 UNSAFE_FS，写明输出不完整并在 `files_left` 中列出它们（残留的暂存文件列在 `staging_left`）；只有暂存文件删不掉时，保留原错误并附 `staging_left`；无法识别的暂存文件在 `staging_path` 中给出；删除之后若无法刷盘，错误为 UNSAFE_FS，说明清理可能经不起崩溃，并在 `unflushed_directories` 中列出相应目录。只有在发布途中服务进程崩溃，才可能留下未被报告的不完整文件。这两种情况下，删除这些文件或换新的 `output_dir` 即可。
- 若 `output_dir` 因符号链接或保留位置（`.nullius/`、`team/runs/`、`artifacts/hep-mcp/`）被拒：换成项目内由真实目录构成的子目录，例如当前 run 目录下的子目录。
- 若 token gate overflow：按返回的 overflow artifact 和 `next_actions` 收敛上下文规模，不要绕过门控。

新项目运行统一位于 `artifacts/runs/<run_id>/`，team/draft 执行记录放在其 `research_team/` 子目录，来源记录盖章在父 run 上。旧 `team/runs` 保留为只读证据，状态、列表、索引和导出使用其原位置，不改写来源、有效性或结果引用；`init --runtime-only` 可重新连接而不移动证据。同名编号明确报告歧义，不可读历史位置报告为不可用，不阻断无关的可读记录。`inventory_run_relocation.py --fixture-root <匿名fixture> --source-manifest <哈希清单>` 只盘点已固定输入的引用、冲突与未解决绑定，没有 apply 模式。独立 reviewer 快照排除所有轮次的执行 payload 和工作区树，保留生产输入；读取仅允许自己的声明输出前缀。历史报告与裁决保留给协调者。`team/LATEST*.md` 与 `artifacts/LATEST.md` 只提供导航。

Existing `PROJECT_INDEX_AUTO` blocks are historical, unmaintained observations; the team helper neither parses nor updates them. Current `RUN_INDEX` navigation and curated result/report registries have separate owners. Do not silently rewrite or delete an old block.

Existing `team/runs/<run_id>/` evidence remains readable in place. New execution uses a distinct ID under `artifacts/runs/`. Export a historical run with `nullius export --run-id <id>`; for a duplicate ID, select `--run-root team/runs`. Runtime-only reconnect preserves historical evidence.

### Keep the human notebook current

When adopting a scientific result, rewrite the affected `research_notebook.md`
sections with its assumptions, definitions, conventions, derivation, interpretation
and limits. Link its registered artifact directly from the relevant human `##`
section, then refresh the automatic block and review the finished notebook:

```bash
nullius notebook sync
nullius notebook review --model claude/opus --dependency <project-relative-path>
nullius notebook check --json
```

Repeat `--dependency` for every required supporting file; omit it only when the
notebook needs no such dependency. Review uses a default hard 1200-second total timeout across at most 64 calls,
with one attempt per call (`--timeout-secs <N>` changes it), freezing SHA-256 for the
entire UTF-8 notebook, automatic block included, and declared dependency bytes,
including uncommitted edits.

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

The reviewer must read every section and give
source-anchored reasons about the reasoning, derivations, notation and assumptions.

The read-only check reports `structure` and `content_review` separately and
succeeds only with structural success and an accepted current full-text review.
`--result` scopes links alone; `--structure-only` establishes navigation alone.
Missing, partial, failed, unavailable, invalid or stale review is not acceptance.
A later edit requires a new review; the old report remains readable. File and
engine closeout use this same requirement. Automatic tables, formula counts,
checklists and the writer's self-assessment cannot supply a content verdict.
Semantic acceptance does not prove scientific truth or replace claim-specific
validation; see [the notebook check's scope](../packages/orchestrator/README.md#human-notebook-integration).

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

For an enabled full-access independent reproduction gate, supply `--reproduction-packet <neutral-input-file>` to the team cycle or set `independent_reproduction.blind_packet` to its project-relative path in `research_team_config.json`. Put the question, conventions and complete original inputs there; omit candidate answers and candidate implementation. The cycle freezes it for both member stages with reproduction instructions, while other review steps retain the full candidate packet. Missing neutral input refuses dispatch. Every subsequent actual file read and command input still needs the fresh source assessor's blindness and method checks; selecting this route does not prove independence. Each member supplies complete source through `files_written`, then requests its execution. At least two accepted independent constructions are required, including when their sound method or family is shared.

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.

Research output preservation, path classification, read-only inventory, commit checks and automatic origin-snapshot admission are described in [Research output storage](RUN_STORAGE.md). No storage command deletes data, rewrites history or expires recovery records.
