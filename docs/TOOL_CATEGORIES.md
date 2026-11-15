# Tool Categories（standard=51 / full=57）

本文件把 `hep-mcp` 的 **standard 暴露**工具按“场景/闭环”分组，目的是让你不必理解全部工具，也能快速完成闭环。它描述的是当前 HEP 领域工具面，不是仓库的 root 产品身份。

先选对层，再选工具：

- `nullius` = stateful CLI front door
- `orch_*` = 同一 control plane 的 MCP/operator counterpart
- provider tools = bounded atomic MCP operators，而不是一套待补齐的 provider CLI

> SSOT：工具名/工具数以代码为准（`pnpm -r build` 后）：
>
> ```bash
> node --input-type=module -e "import('./packages/hep-mcp/dist/tools/index.js').then(({getTools})=>console.log('standard',getTools('standard').length,'full',getTools('full').length))"
> ```
>
> 备注：`HEP_ENABLE_ZOTERO=0` 会裁剪 Zotero 相关工具，standard/full 数量会减少。
>
> 备注：标题里的 standard 计数也包含 `openalex_*` / `arxiv_*` / `hepdata_*` 等 provider-atom 工具；它们按 bounded operator 归类，未在下方 A–F 场景分组里逐一列出，因此逐节枚举会少于标题计数。

## Decision Matrix

| 用户意图 | 推荐工具 | 备注 |
|----------|---------|------|
| 轻量研究头脑风暴并收敛一个后续 contract | `nullius workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"` | planning-only durable harness recipe；写入 `.nullius/state.json#/plan` 并派生 `.nullius/plan.md` read model；显式 `--run-id` 应是 safe、sortable、readable 的研究标识；若省略，`<recipe>-<phase>` 只作为 planning placeholder；输出 `next_contract` handoff，但不自动启动 heavier recipe；`research_brainstorm.*` step tools 不是内置 runnable tool chain，不依赖 host-native thinking process，也不是 idea-engine / full research-team / 新 root front door |
| 快速搜索论文 | `inspire_search` | 分页；用 `inspire_search_next` 翻页 |
| 获取单篇论文元数据/引用/被引 | `inspire_literature` | 原子化访问 |
| 深度分析论文集 | `inspire_critical_analysis` / `inspire_classify_reviews` | 高层 workflow 先经 stateful front-door consumer；这里保留的是 bounded atomic operators |
| 文献综述 | `nullius workflow-plan --recipe literature_landscape` | 推荐的公开 stateful front door，需先 `nullius init`；直接通过 `@nullius/literature-workflows` 解析 recipe，并写入 `.nullius/state.json#/plan` / `.nullius/plan.md`。可再配合 `inspire_critical_analysis` / `inspire_classify_reviews` |
| 发现奠基性/相关论文 | `nullius workflow-plan --recipe literature_landscape` | 由公开的 stateful front door 解析后，再下沉到 `inspire_search` / provenance / network operators |
| 物理学家式文献调研 | `nullius workflow-plan --recipe literature_gap_analysis` | 不再通过 provider-specific high-level MCP facade |
| 主题时间线/趋势/新兴方向 | `inspire_topic_analysis` | 模式: `timeline/evolution/emerging/all` |
| 引用/合作网络分析 | `inspire_network_analysis` | 模式: `citation/collaboration` |
| 发现跨论文关联 | `inspire_find_connections` | 输入 `recids`；可选 external hubs。若上游 workflow 的 paper set 为空，高层 consumer 会跳过该步并写出结构化 no-op 结果，而不会放宽原子工具契约 |
| 追溯原始来源链 | `inspire_trace_original_source` | 输入 `recid` |
| 证据质量/冲突分析 | `inspire_grade_evidence` / `inspire_critical_analysis` / `inspire_classify_reviews` / `inspire_theoretical_conflicts` | 原子 surface；不再通过 mode bag 混装 |
| 下载论文源码 (LaTeX/PDF) | `inspire_paper_source` (`mode=content`) | |
| LaTeX 结构解析 | `inspire_parse_latex` | 需 `project_root` + `output_dir`；在该目录写出 `parse_latex_<hash>.json`，返回项目相对路径 + summary |
| 解析 BibTeX citekey | `inspire_resolve_citekey` | 批量 citekey + BibTeX 解析 |
| 批量 ID→recid 映射 | `hep_inspire_resolve_identifiers` | 需 `project_root` + `output_dir`，映射写入该目录；与 `inspire_resolve_citekey` 互补 |
| 把 INSPIRE 检索结果导出成项目文件 | `hep_inspire_search_export`，或带 `output_dir` 的 `inspire_search` | 需 `project_root` + `output_dir`；返回项目相对路径而不是记录本身 |
| PDG 粒子数据 | `pdg_find_particle`, `pdg_get` 等 | 离线；需 `PDG_DB_PATH` |
| Zotero 文献管理 | `zotero_local`, `zotero_find_items` 等 | 需 `HEP_ENABLE_ZOTERO=1` |

### 常见任务路径

**"我想写一篇关于 X 的综述论文"**
1. 先 `nullius init`
2. 若研究问题还未收敛，运行 `nullius workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"` 生成 `next_contract` handoff；它只规划，不自动升级到重流程
3. 运行 `nullius workflow-plan --recipe literature_landscape` 解析文献工作流（直接通过 `@nullius/literature-workflows` 解析并写入 `.nullius/state.json#/plan` / `.nullius/plan.md` read model）
4. `inspire_search` + `inspire_topic_analysis` + `inspire_network_analysis` 做原子调研
5. `arxiv_paper_source` / `inspire_paper_source`（`mode=content`）取得选定论文原文；对照原文核对论断，把位置（章节、公式号、页码）记入项目笔记
6. `inspire_critical_analysis` / `inspire_classify_reviews` 做受限论文集分析
7. 成稿：hep-mcp 不提供草稿渲染或导出工具，稿件在项目内另行编写（例如用 `research-writer` skill 搭建 RevTeX 稿件）

**"我想检查我的论文引用是否准确"**
1. `inspire_resolve_citekey` 按 recid 取得 INSPIRE citekey、BibTeX 与规范链接
2. `hep_inspire_resolve_identifiers`（传 `project_root` + `output_dir`）把 recid/arXiv/DOI 批量映射到 INSPIRE recid，映射写入项目内文件
3. （可选，`full` 模式）`inspire_validate_bibliography` 做可用性审计（默认 manual-only、warning 非阻断；可选 INSPIRE 交叉验证）

**"我想找到某个测量值的历史"**
1. `pdg_find_particle` 查找粒子
2. `pdg_get_measurements` 获取测量历史
3. `inspire_topic_analysis(mode='timeline')` 查看研究时间线

## A) Core

**健康检查**
- `hep_health`

**研究输出工具：调用方指定 `output_dir`**
- `hep-mcp` 没有自己的 run；run、审批与生命周期只属于 orchestrator（`artifacts/runs/<run_id>/`）。
- 研究输出工具（`hep_inspire_search_export`、`hep_inspire_resolve_identifiers`、`hep_import_from_zotero`、`inspire_parse_latex`、`inspire_theoretical_conflicts`，以及带 `output_dir` 的 `inspire_search`）把文件写入调用方给定的 `output_dir`。`inspire_paper_source` 的下载、缓存与 PDG 数据仍位于 hep-mcp 的数据根（`<project_root>/artifacts/hep-mcp` 或 `HEP_DATA_DIR`）。
- `output_dir` 需要同时传 `project_root`；可写成相对 `project_root` 的路径，或绝对路径（根目录的任一别名拼写均可）；不存在时创建；不得经过 project root 以下的符号链接；不得位于 `.nullius/`、`team/runs/` 或 `artifacts/hep-mcp/` 之下（比较时不区分大小写），也不能是 project root 本身。
- 调用从不覆盖已有文件：输出名已存在的调用会被拒绝；调用失败时撤回本次已发布的文件，删不掉的在错误里列出（详见 hep-mcp README）。
- 结果返回项目相对路径（`export_path`、`meta_path`、`mapping_path`、`path`、`artifacts[].path`），不再返回 `hep://` run URI。
- 通常把 `output_dir` 设为当前 orchestrator run 目录下的子目录，例如 `artifacts/runs/<run_id>/literature/`。

经 INSPIRE 响应缓存发出的查询（`hep_inspire_search_export`、`hep_inspire_resolve_identifiers`、带 `output_dir` 的 `inspire_search`，以及 `hep_import_from_zotero` 中把条目解析到 INSPIRE 的一步）逐次把请求/响应记录到 `<output_dir>/external_api/`；其他外部调用（Zotero 本地 API、`inspire_theoretical_conflicts` 取论文、`inspire_parse_latex` 取源码）不在此记录。检索导出与 Zotero 映射另写一份预算/警告记录（例如 `inspire_search_export_<hash>_diagnostics.json`）。旧版本留下的 HEP run 目录（`<project_root>/artifacts/hep-mcp/runs/<run_id>/` 等）与论文/evidence 项目目录（`<project_root>/artifacts/hep-mcp/projects/<project_id>/` 等，含 evidence catalog）是历史证据：原位读取，不再被任何工具创建或改写；`hep://runs/...` 与 `hep://projects/...` 引用的人工解析规则见 [`docs/URI_REGISTRY.md`](./URI_REGISTRY.md)。

**generic lifecycle / staging / execution 属于 orchestrator**
- HEP 包不暴露 generic staging / computation planning / manifest execution authority。
- 需要 stateful control-plane 流程时使用 `nullius` / `orch_*`：
  - staging / planning / execution: `orch_run_stage_idea` / `orch_run_stage_content` / `orch_run_plan_computation` / `orch_run_execute_manifest` / `orch_run_progress_followups`
  - verification / higher-conclusion gate: `nullius verify` / `orch_run_record_verification`，以及 `nullius final-conclusions` / `orch_run_request_final_conclusions`
  - proposal decisions / read models: `nullius proposal-decision`、`nullius status --json`、`orch_run_status`、`orch_run_export`
  - conversational decisions: `nullius decision record|pending`（追加写 `.nullius/decisions.jsonl`）、`nullius decision list`（只读回放）与主干侧 `nullius decision land`（原子落号）；open 项计数始终出现在 status receipt（最旧十条列明，其余用 `decision list` 查看）。`--resolves` 只关闭更早的 open `pending` 条目；`--relates` 可非关闭地指向更早且可读的 `decided` 或 `pending` 条目。回放时无法识别的持久化关系进入 `decision_ledger.unrecognized_relations`，链接本身失效但记录仍计数、列出且可寻址；旧版或未知字符串 kind 按当前 `decided` 语义保留，并通过 `source_kind` / `normalized_kinds` 标注，只有精确的 `pending` 创建 open item，而归一化条目上其余合法 `resolves` 仍可关闭 pending。分支记录先使用 6 字符随机 Crockford-base32 handle，不编码时间、无需协调，并可供分支内关系引用；本地铸号避让当前 id 与既有 `provisional_id`。分支尾进入权威主干后，`decision land` 按主干文件顺序分配永久单调 `D<n>`，改写指向 handle 的两类关系，并以 `provisional_id` 保存映射。既有 `D<n>` ledger 零迁移有效，条目继续进入计数且原 id 可 resolve；展示顺序取自毫秒精度 `ts`。若任意形式的当前 id 在文件里出现多次，`decision_ledger.duplicate_ids` 具名；若同一 provisional id 被多条 durable 记录保留或又被用作当前 id，`decision_ledger.ambiguous_provisional_ids` 具名。两类身份冲突都使 `decision list` 判不通过、新关系写入被拒绝、`decision land` 零改写拒绝；正常 provisional 条目仍是有效记录，并由 `decision_ledger.unlanded_count` 显示尚未落号的数量

## B) 引用与标识符

**Citekey / BibTeX**
- `inspire_resolve_citekey`（recid → INSPIRE citekey + BibTeX + 规范链接）

**INSPIRE 数据集导出/ID 解析（写入项目内 `output_dir`）**
- `hep_inspire_search_export`
- `hep_inspire_resolve_identifiers`

## C) 数值与理论冲突（有界论文集）

- 数值测量比较：用 `inspire_paper_source` / `arxiv_paper_source` 取得并实际阅读原文；按需用 `pdg_get_measurements` / `hepdata_get_table` 核对数据。主 agent 确认物理量定义、条件、单位和误差/相关性后，通过已有数值执行能力计算。不可比较或缺少协方差时明确保留未解决项，不自动给出兼容结论或平均值。
- `inspire_theoretical_conflicts`（理论冲突图；需 `project_root` + `output_dir`，中间记录与结果都写入该目录）

## D) Zotero（Local API，本地库管理）

- `zotero_local`
- `zotero_find_items`
- `zotero_search_items`
- `zotero_export_items`
- `zotero_get_selected_collection`
- `zotero_add`
- `zotero_confirm`
- `zotero_delete`
- `hep_import_from_zotero`（Zotero 条目 → INSPIRE recid 映射，写入项目内 `output_dir`）

> 备注：已移除 full-only 的细粒度 `zotero_*` 工具；统一使用 `zotero_local` 的 `mode` 分派。

## E) INSPIRE（网络原子工具：检索/分析）

> 备注：高层 literature workflow 现由公开的 stateful `nullius workflow-plan` 前门承载，需先 `nullius init` 并且会直接通过 `@nullius/literature-workflows` 解析后写入 `.nullius/state.json#/plan` / `.nullius/plan.md`。这里列的是仍可直接调用的 INSPIRE 原子工具；其中 `inspire_parse_latex`、`inspire_theoretical_conflicts` 与带 `output_dir` 的 `inspire_search` 把文件写入项目内的 `output_dir`。

- `inspire_search`
- `inspire_search_next`
- `inspire_literature`
- `inspire_resolve_citekey`
- `inspire_paper_source`
- `inspire_parse_latex`
- `inspire_topic_analysis`
- `inspire_network_analysis`
- `inspire_find_connections`
- `inspire_trace_original_source`
- `inspire_grade_evidence`
- `inspire_critical_analysis`
- `inspire_classify_reviews`
- `inspire_theoretical_conflicts`

## F) PDG（离线数据库：`PDG_DB_PATH`）

- `pdg_info`
- `pdg_find_particle`
- `pdg_find_reference`
- `pdg_get_reference`
- `pdg_get_property`
- `pdg_get`
- `pdg_get_decays`
- `pdg_get_measurements`
