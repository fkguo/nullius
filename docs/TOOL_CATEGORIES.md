# Tool Categories（standard=72 / full=100）

本文件把 `hep-mcp` 的 **standard 暴露**工具按"场景/闭环"分组，目的是让你不必理解全部工具，也能快速完成闭环。

> SSOT：工具名/工具数以代码为准（`pnpm -r build` 后）：
>
> ```bash
> node --input-type=module -e "import('./packages/hep-mcp/dist/tools/index.js').then(({getTools})=>console.log('standard',getTools('standard').length,'full',getTools('full').length))"
> ```
>
> 备注：`HEP_ENABLE_ZOTERO=0` 会裁剪 Zotero 相关工具，standard/full 数量会减少。

## Decision Matrix

| 用户意图 | 推荐工具 | 备注 |
|----------|---------|------|
| 快速搜索论文 | `inspire_search` | 分页；用 `inspire_search_next` 翻页 |
| 获取单篇论文元数据/引用/被引 | `inspire_literature` | 原子化访问 |
| 深度分析论文集 | `inspire_deep_research` (`mode=analyze`) | |
| 文献综述 | `inspire_deep_research` (`mode=synthesize`) | |
| 发现奠基性/相关论文 | `inspire_discover_papers` | 模式: `seminal/related/expansion/survey` |
| 物理学家式文献调研 | `inspire_field_survey` | reviews → seminal → expansion → controversies |
| 主题时间线/趋势/新兴方向 | `inspire_topic_analysis` | 模式: `timeline/evolution/emerging/all` |
| 引用/合作网络分析 | `inspire_network_analysis` | 模式: `citation/collaboration` |
| 发现跨论文关联 | `inspire_find_connections` | 输入 `recids`；可选 external hubs |
| 追溯原始来源链 | `inspire_trace_original_source` | 输入 `recid` |
| 证据质量/冲突分析 | `inspire_critical_research` | 模式: `evidence/conflicts/analysis/reviews/theoretical` |
| 下载论文源码 (LaTeX/PDF) | `inspire_paper_source` (`mode=content`) | |
| LaTeX 结构解析 | `inspire_parse_latex` | 需 `run_id`；返回 artifact URI + summary |
| 解析 BibTeX citekey | `inspire_resolve_citekey` | 批量 citekey + BibTeX 解析 |
| 批量 ID→recid 映射 | `hep_inspire_resolve_identifiers` | 写入 artifact；与 `inspire_resolve_citekey` 互补 |
| PDG 粒子数据 | `pdg_find_particle`, `pdg_get` 等 | 离线；需 `PDG_DB_PATH` |
| Zotero 文献管理 | `zotero_local`, `zotero_find_items` 等 | 需 `HEP_ENABLE_ZOTERO=1` |

### 常见任务路径

**"我想写一篇关于 X 的综述论文"**
1. `inspire_search` 搜索领域
2. `inspire_field_survey` 文献调研
3. `hep_project_create` + `hep_run_create`
4. `hep_run_build_writing_evidence` 构建证据
5. `inspire_deep_research(mode='synthesize')` 综合分析
6. `hep_render_latex` 渲染 LaTeX
7. `hep_export_project` 导出

**"我想检查我的论文引用是否准确"**
1. `hep_run_build_citation_mapping` 构建引用映射
2. 检查 `bibliography_raw.json`、`citekey_to_inspire.json`、`allowed_citations.json` 制品
3. （可选，`full` 模式）`inspire_validate_bibliography` 做可用性审计（默认 manual-only、warning 非阻断；可选 INSPIRE 交叉验证）

**"我想找到某个测量值的历史"**
1. `pdg_find_particle` 查找粒子
2. `pdg_get_measurements` 获取测量历史
3. `inspire_topic_analysis(mode='timeline')` 查看研究时间线

## A) Core 闭环（Project/Run + Evidence-first）

**闭环必需（Draft Path）**
- `hep_project_create`
- `hep_run_create`
- `hep_render_latex`
- `hep_export_project`
- （可选：投稿闭环）`hep_export_paper_scaffold` → `hep_import_paper_bundle`

**项目/运行信息（调试）**
- `hep_health`
- `hep_project_get`
- `hep_project_list`
- `hep_run_read_artifact_chunk`
- `hep_run_clear_manifest_lock`
- `hep_run_stage_content`

**Idea → Run（Pipeline Connectivity）**
- `hep_run_create_from_idea`（从 IdeaHandoffC2 创建 project + run + outline seed）

## B) Evidence 构建（写作/检索/回放的输入资产）

**LaTeX（Project evidence catalog）**
- `hep_project_build_evidence`

**Writing evidence（run 级复用资产：catalog/embeddings/enrichment + source status）**
- `hep_run_build_writing_evidence`

**PDF evidence（Zotero/PDF → run artifacts）**
- `hep_run_build_pdf_evidence`

## C) Evidence 查询（从 catalog 中取回证据）

- `hep_project_query_evidence`（unified：`mode=lexical|semantic`，默认 lexical；semantic 需 `run_id`）
- `hep_project_query_evidence_semantic`（semantic；必须先在 run 中生成 embeddings（`hep_run_build_writing_evidence`），缺失则 hard fail）
- `hep_project_playback_evidence`（locator 回放）

## D) 引用与标识符（写作硬门的依赖）

**Citation mapping（用于真实 BibTeX 与 allowlist）**
- `hep_run_build_citation_mapping`

**INSPIRE 数据集导出/ID 解析（Evidence-first）**
- `hep_inspire_search_export`
- `hep_inspire_resolve_identifiers`

## E) 数值抽取与冲突（写作评审/张力叙事）

- `hep_run_build_measurements`（从 run LaTeX evidence 抽取数值）
- `hep_project_compare_measurements`（跨 run 数值一致性 flagging；不是权威 world-average 组合器）

## F) Zotero（Local API，本地库管理）

- `zotero_local`
- `zotero_find_items`
- `zotero_search_items`
- `zotero_export_items`
- `zotero_get_selected_collection`
- `zotero_add`
- `zotero_confirm`
- `hep_import_from_zotero`（导入到 run 的 mapping）

> 备注：已移除 full-only 的细粒度 `zotero_*` 工具；统一使用 `zotero_local` 的 `mode` 分派。

## G) INSPIRE（网络工具：检索/分析工作流）

> 备注：`inspire_*` 工具可直接调用（不需要 Project/Run）。Project/Run 与 `hep://...` resources 主要用于 evidence-first 本地工作流（`hep_*`）。

- `inspire_search`
- `inspire_search_next`
- `inspire_literature`
- `inspire_resolve_citekey`
- `inspire_paper_source`
- `inspire_parse_latex`
- `inspire_discover_papers`
- `inspire_field_survey`
- `inspire_topic_analysis`
- `inspire_network_analysis`
- `inspire_find_connections`
- `inspire_trace_original_source`
- `inspire_critical_research`
- `inspire_deep_research`

## H) PDG（离线数据库：`PDG_DB_PATH`）

- `pdg_info`
- `pdg_find_particle`
- `pdg_find_reference`
- `pdg_get_reference`
- `pdg_get_property`
- `pdg_get`
- `pdg_get_decays`
- `pdg_get_measurements`
