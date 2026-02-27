# HEP Research MCP

[English](../README.md) | 中文

HEP Research MCP - 用于高能物理（HEP）及相关领域深度学术调研的 Model Context Protocol 服务器。

## 语言策略（Phase 4.11）

- `README.md` 为英文主语义文档（canonical semantics）。
- `docs/README_zh.md` 为同步中文参考文档。
- 桥接/对齐参考：`docs/SKILL_MCP_BRIDGE.md`、`docs/STYLE_CORPUS_ALIGNMENT.md`。

## vNext：本地优先 + Evidence-first（推荐）

本仓库正在按 **vNext** 架构重构，核心是 **Project/Run** 与 `hep://` **MCP Resources**。

**硬约束（设计如此）：**
- **MCP 只走本地 stdio**：仅 `StdioServerTransport`；不提供/不引入 HTTP transport/server。
- **Zotero 仅 Local API**：`http://127.0.0.1:23119`（不做 Zotero Web API）。
- **Evidence-first I/O**：大对象只落盘为 **run artifacts**，通过 `hep://...` resources 读取；tool 返回只包含 **URI + 摘要**。

**推荐 vNext 工作流（高层）：**
1. `hep_project_create` → `hep_run_create`
2. （可选）Zotero：`hep_import_from_zotero`（映射）以及/或在 `hep_run_build_pdf_evidence` 里传 `zotero_attachment_key`（通过 Zotero Local API 读取 PDF；可使用 `.zotero-ft-cache`）
3. 构建证据：
   - LaTeX → `hep_project_build_evidence`
   - PDF → `hep_run_build_pdf_evidence`（text/visual；Docling JSON 可选作为后端输入）
4. 写作与强约束：`hep_render_latex`（verifier 会拒绝 missing/unauthorized citations）
5. 导出：
   - 研究资产包：`hep_export_project` → `master.bib`、`report.(tex|md)`、`research_pack.zip`、`notebooklm_pack_*`
   - 投稿脚手架：`hep_export_paper_scaffold` → `paper/` + `paper_scaffold.zip`
   - 投稿回灌（可选）：`hep_import_paper_bundle`（把最终 `paper/` 回灌到 run artifacts；`hep_export_project(include_paper_bundle=true)` 可把它打进 `research_pack.zip`）

## 核心能力：深度研究 (Deep Research)

hep-research-mcp 不只是“检索”，而是面向 HEP 的 **本地优先、证据优先** 研究与写作流水线：

### 1. 构建可引用证据（Project/Run）

- 下载 arXiv 源码，或通过 Zotero Local API 读取 PDF
- 解析 LaTeX 为结构化块（章节/公式/图表/引用）
- 大输出落盘为 run artifacts，并通过 `hep://...` resources 读取（Evidence Catalog、PDF evidence、writing evidence）

### 2. 走通文献闭环（INSPIRE）

- 小结果：`inspire_search` + `inspire_search_next` 安全翻页；大结果：`hep_inspire_search_export` 直接导出为 artifacts
- 发现/扩展/网络/专家/溯源：`inspire_research_navigator(mode=discover|field_survey|topic_analysis|network|experts|connections|trace_source|analyze)`
- （可选）数值与粒子性质可用离线 PDG 工具（`pdg_*`）交叉核对

### 3. Run-based 写作与强约束（vNext）

- `inspire_deep_research(mode=write, run_id=...)` 生成写作所需的 run 级资产（outline、evidence quotas、reviewer round prompts）
- client 提交章节候选与审稿：`hep_run_writing_submit_section_candidates_v1` / `hep_run_writing_submit_section_judge_decision_v1` / `hep_run_writing_submit_review`，再集成/导出（`hep_run_writing_integrate_sections_v1`, `hep_export_project`, `hep_export_paper_scaffold`, `hep_import_paper_bundle`）

---

## 典型使用场景

### 场景 A：快速了解一个新领域

> "我想了解 nucleon structure 领域的发展历程"

AI 会自动：

1. 搜索相关文献 → 识别奠基性论文
2. 构建引用网络 → 找出核心论文
3. 生成研究时间线 → 展示发展脉络
4. 识别领域专家 → 推荐关键作者

### 场景 B：深入分析几篇论文

> "帮我分析这 5 篇论文的核心方法和公式"

AI 会自动：

1. 下载 LaTeX 源码 → 解析文档结构
2. 提取所有公式 → 识别关键方程
3. 提取关键章节与引用上下文 → 总结贡献与证据链
4. 识别方法论 → 分类研究方法

### 场景 C：发现可能遗漏的重要文献

> "基于我的阅读列表，有哪些重要论文我可能遗漏了？"

AI 会自动：

1. 分析已有论文的引用网络
2. 发现高度相关但未包含的论文
3. 识别"桥接论文"连接不同子领域
4. 推荐按重要性排序的补充阅读

### 场景 D：追踪新兴研究方向

> "哪些 nucleon spin structure 论文可能代表范式转移？"

AI 会自动：

1. 检测引用动量异常高的论文
2. 计算新进入者比例（社会学信号）
3. 计算颠覆指数（区分炒作 vs 真正创新）
4. 综合评估置信度并解释原因

### 场景 E：自动生成结构化综述

> "帮我生成这个主题的文献综述"

AI 会自动：

1. 深度分析每篇论文内容
2. 按方法论/时间线/影响力分组
3. 提取关键公式和核心贡献
4. 生成 Markdown 综述 + BibTeX 参考文献

### 场景 F：研究者画像（重名消歧 + 代表作/产出概览）

> "帮我分析张昊（Zhang Hao）的学术产出与代表作"

推荐调用链（**优先用 INSPIRE 作者 BAI / ORCID** 做重名消歧）：

1. 确认作者身份（最佳：BAI；可用：ORCID；兜底：姓名搜索）
```json
{ "mode": "get_author", "identifier": "E.Witten.1" }
```
BAI（INSPIRE 作者唯一标识）是稳定的消歧 key，形如 `E.Witten.1`。

2. 拉取该作者的高被引代表作列表（BAI 可稳定消歧）
```json
{ "query": "a:E.Witten.1", "sort": "mostcited", "size": 25, "format": "markdown" }
```
从每条结果的 `IDs:` 行复制 `recid`，用于后续调用。

3. 对选中的论文集合做“画像”统计（通过 `inspire_research_navigator(mode=analyze)` 汇总时间线/主题/引用等）
```json
{ "mode": "analyze", "recids": ["1234567", "2345678"], "analysis_type": ["overview", "timeline", "topics"] }
```

4. 深挖一篇代表作（用 `provenance.retrieval_level` 核验是否真的拿到了 LaTeX 源码）
```json
{ "mode": "content", "identifier": "1234567", "options": { "prefer": "latex", "extract": true } }
```

---

## 项目概述

本项目是一个 MCP (Model Context Protocol) 服务器，为 AI 助手提供 INSPIRE-HEP 高能物理文献数据库的深度访问能力。

| 包                    | 功能                           | 状态                             |
| --------------------- | ------------------------------ | -------------------------------- |
| **hep-research-mcp** | INSPIRE-HEP + vNext 本地 evidence-first 工作流（`hep_*`, `zotero_local`, `pdg_*`） | ✅ vNext M0–M12 已完成 |
| **zotero-mcp**  | Zotero Local API 工具（用于本地文献库管理；同时已聚合进 hep-research-mcp 作为 `zotero_*`）— [文档](../packages/zotero-mcp/README.md) | ✅ v0.3.0 |
| **pdg-mcp**     | 本机离线 PDG sqlite tools/resources（同时已聚合进 hep-research-mcp 作为 `pdg_*`）— [文档](../packages/pdg-mcp/README_zh.md) | ✅ v0.3.0 |
| **shared**      | 共享类型定义和工具函数         | ✅ 已完成                        |

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      AI Assistant                           │
│                   (MCP 客户端)                               │
└──────────────────────────┬──────────────────────────────────┘
                           │ MCP Protocol (stdio)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  hep-research-mcp Server                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   Tool Layer    │  │ Artifacts/Cache │  │  API Layer  │ │
│  │ (74 std / 86)   │  │  (FS+Memory)    │  │ (Rate Limit)│ │
│  └─────────────────┘  └─────────────────┘  └──────┬──────┘ │
└───────────────┬───────────────────────┬──────────┼────────┘
                │                       │          │ HTTPS APIs
                │ 本地磁盘              │ localhost│
                ▼                       ▼          ▼
      <HEP_DATA_DIR>/           Zotero Local API  INSPIRE-HEP + arXiv
      (projects/runs/...)       (127.0.0.1:23119) (inspirehep.net + arxiv.org)
                │
                ▼
        PDG sqlite（可选）
        (PDG_DB_PATH)
```

## 目录结构

```
hep-research-mcp/
├── README.md
├── package.json              # workspace 配置
├── tsconfig.json             # 基础 TypeScript 配置
├── pnpm-workspace.yaml       # pnpm workspace
├── docs/                     # 文档（见 docs/README_zh.md、docs/TESTING_GUIDE.md）
├── packages/
│   ├── hep-research-mcp/     # hep-research-mcp 服务器
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts      # 入口
│   │       ├── tools/        # MCP 工具实现
│   │       ├── vnext/        # vNext Project/Run + hep:// resources（本地工作流）
│   │       ├── api/          # INSPIRE API 客户端
│   │       ├── data/         # HEP_DATA_DIR + 路径安全 + downloads
│   │       ├── cache/        # 缓存逻辑
│   │       └── utils/        # 工具函数
│   ├── pdg-mcp/              # pdg-mcp 服务器（本机 PDG sqlite；可选单独运行）
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts      # 入口
│   │       ├── tools/        # MCP 工具实现（pdg_*）
│   │       └── resources.ts  # pdg:// resources（artifacts）
│   ├── zotero-mcp/           # zotero-mcp 服务器（Zotero Local API；可选单独运行）
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts      # 入口
│   │       ├── tools/        # MCP 工具实现（zotero_*）
│   │       └── zotero/       # Zotero Local API client
│   └── shared/               # 共享代码
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── types/        # 共享类型定义
│           └── utils/        # 共享工具函数
```

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- pnpm >= 8.0.0

```bash
# 安装 pnpm（如果没有）
npm install -g pnpm
```

### 安装依赖

```bash
cd /path/to/hep-research-mcp
pnpm install
```

### 构建

```bash
# 构建所有包
pnpm -r build

# 或构建特定包
pnpm --filter @hep-research/shared build
```

### 验证安装

```bash
cd packages/shared
pnpm exec tsx test-check.ts
```

## 工具概览

本服务端暴露四类工具：
- **vNext 本地工作流**：`hep_*`（Project/Run、证据、强制 verifier 写作、导出）
- **Zotero 本地文献库工具**：`zotero_*`（仅 Local API）
- **离线 PDG 工具**：`pdg_*`（本机 sqlite；可选启用）
- **INSPIRE 调研工具**：`inspire_*`（调研/写作 + 安全翻页/导出等）

说明：
- `inspire_*` 工具可直接调用（不需要 Project/Run）。Project/Run 与 `hep://...` resources 主要用于 evidence-first 本地工作流（`hep_*`）。

工具数量：**`standard` 模式 74 个**（默认：收敛后的紧凑工具面）与 **`full` 模式 86 个**（额外暴露 advanced/heavy 工具，如 Style Corpus）。

### 工具暴露模式

| 模式 | 工具数 | 说明 |
|------|--------|------|
| `standard` | 74 | 默认：紧凑、推荐 |
| `full` | 86 | `standard` + advanced/heavy 工具 |

```bash
# 使用 full 模式（可选）
export HEP_TOOL_MODE=full
```

### vNext + Zotero 工具（hep_* / zotero_*）—— Evidence-first 本地工作流

这些工具实现了 **Project/Run + artifacts + `hep://` resources** 的端到端流程；Zotero 工具（`zotero_*`）用于可选的本地文献库管理，直接返回 JSON（不产出 `hep://` artifacts）。

**vNext（节选）**
- `hep_project_create`：创建本地 project → `hep://projects/{project_id}`
- `hep_project_get`：读取 project 元信息 → `hep://projects/{project_id}`
- `hep_project_list`：列出 projects → `hep://projects`
- `hep_run_create`：创建 run（可审计/可复现） → `hep://runs/{run_id}/manifest`、`args_snapshot.json`
- `hep_project_build_evidence`：LaTeX → Evidence Catalog v1（project paper） → `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog`
- `hep_project_query_evidence`：Evidence Catalog 统一检索（`mode=lexical|semantic`，默认 `lexical`；`mode=semantic` 需要 `run_id`，并支持 `include_explanation`）→ 词法 hits 或语义 run artifact（URI + 摘要）
- `hep_project_query_evidence_semantic`：Evidence Catalog 语义检索（需先在 run 中生成 embeddings：`hep_run_build_writing_evidence`；否则 hard fail） → `evidence_semantic_query_*.json`（URI + 摘要）
- `hep_project_playback_evidence`：locator 回放成稳定 snippet → snippet 文本
- `hep_run_build_citation_mapping`：bibliography→INSPIRE 映射 + allowlist → `bibliography_raw.json`、`citekey_to_inspire.json`、`allowed_citations.json`
- `hep_run_build_measurements`：从 run evidence 抽取结构化数值 → `hep_measurements_*.jsonl` + meta/diagnostics artifacts
- `hep_project_compare_measurements`：跨多个 run 对比测量并标记 pairwise tension（仅 flagging，不做权威组合）→ run artifact URI + 摘要
- `hep_render_latex`：结构化 draft → LaTeX，统一插入 `\\cite{}` 并强制 verifier → `rendered_latex.tex`、`rendered_latex_verification.json`
- `hep_run_build_pdf_evidence`：PDF → Evidence v1（按页文本 + 可选视觉裁剪） → `*_evidence_catalog.jsonl`、`*_page_*.png`、`*_region_*.png`
- `hep_export_project`：导出 run 的研究资产包 → `master.bib`、`report.(tex|md)`、`research_pack.zip`、`notebooklm_pack_*`
- `hep_export_paper_scaffold`：导出投稿脚手架 `paper/`（RevTeX4-2）→ `paper_manifest.json`、`paper_scaffold.zip`
- `hep_import_paper_bundle`：把最终 `paper/` 回灌到 run artifacts → `paper_bundle.zip`、`paper_bundle_manifest.json`、（可选）`paper_final.pdf`
- `hep_import_from_zotero`：Zotero items → identifiers → INSPIRE recid 映射 → `zotero_map.json`

**Zotero（standard）**
- `zotero_local`：统一 Zotero Local API 工具 → 返回 JSON（collections/items；可解析 attachment/fulltext cache 路径）
- `zotero_search_items`：浏览/搜索 items → summarized items + `select_uri`
- `zotero_find_items`：按 identifiers + filters 精确定位 → `select_uri` + identifiers 摘要
- `zotero_export_items`：导出 items 为 BibTeX/CSL-JSON/RIS 等 → content（截断）+ sha256
- `zotero_get_selected_collection`：解析 Zotero UI 当前选中 collection → Local API `collection_key` + path
- `zotero_add`：预览添加/更新 → `confirm_token`（+ 可选 `select_uri`）
- `zotero_confirm`：执行一次已预览的写入 → 消耗 `confirm_token`

> 备注：已移除 full-only 的细粒度 `zotero_*` 工具；`zotero_local` 统一以 `mode` 分派（包含 `list_collection_paths` / `list_tags` / `download_attachment` / `get_attachment_fulltext` 等）。
> Phase 4.5 桥接说明：`zotero_find_items` 与 `zotero_search_items` 在保持“验证式/浏览式”语义边界的前提下，共享内部桥接执行路径。

**关于 citekey 选择：**当同一 recid 映射到多个 BibTeX key 时，`hep_render_latex` 选择**字典序最小**的 key（稳定且可复现）。

### vNext Resources（`hep://...`）—— 如何读取 artifacts

多数 vNext 工具只返回 **URI**。实际文件内容通过 MCP resources 读取（本地落盘）。

| Resource URI | 含义 |
|--------------|------|
| `hep://projects` | 项目索引（`hep_projects`） |
| `hep://projects/{project_id}` | project manifest |
| `hep://projects/{project_id}/papers` | project 的 paper 列表 |
| `hep://projects/{project_id}/papers/{paper_id}` | paper manifest |
| `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog` | Evidence Catalog（JSONL） |
| `hep://runs` | run 索引（列出本地 runs） |
| `hep://runs/{run_id}/manifest` | run manifest（steps + artifact refs） |
| `hep://runs/{run_id}/artifact/{name}` | 任意 run artifact（JSON/JSONL/TEX/PDF/PNG/ZIP/…） |
| `hep://corpora` | style corpora 索引（列出本地 corpora） |
| `pdg://info` | PDG 资源信息（server + artifacts 根目录元信息） |
| `pdg://artifacts` | PDG artifacts 索引（缓存文件列表） |
| `pdg://artifacts/<name>` | 读取单个 PDG artifact（文本直接返回；二进制返回元信息 JSON） |

**为什么 Resources 列表看起来“很少”？（Iceberg 模型）**
- 为避免在客户端 UI 中平铺成千上万条中间产物，server 的 `resources/list` **只暴露少量入口资源**（例如 `hep://projects` / `hep://runs` / `pdg://artifacts`）。
- 具体 artifact 不会被枚举到列表里；请先读取入口 index，然后按返回的 URI 继续读取（或使用 `resources/templates/list` 提供的 URI 模板，如 `hep://runs/{run_id}/artifact/{artifact_name}`、`pdg://artifacts/{artifact_name}`）。

### Skill↔MCP 作业 Envelope（Phase 4.10）

对于 run-scoped 响应（包含 `run_id`），dispatcher 会自动补充轻量 `job` 字段，以统一 skill 入口与 MCP 直调入口的长任务轮询语义：

```json
{
  "run_id": "run_xxx",
  "manifest_uri": "hep://runs/run_xxx/manifest",
  "job": {
    "version": 1,
    "job_id": "run_xxx",
    "status": "running",
    "status_uri": "hep://runs/run_xxx/manifest",
    "polling": {
      "strategy": "manifest_resource",
      "resource_uri": "hep://runs/run_xxx/manifest",
      "terminal_statuses": ["done", "failed"]
    }
  }
}
```

`job` 仅是桥接层契约；研究结果仍以 artifacts + resources 为权威。失败语义保持 fail-fast（`INVALID_PARAMS + next_actions`）。

### 推荐：整合工具 (8个)

这些多态工具覆盖大多数使用场景：

| 工具 | 模式 | 说明 |
|------|------|------|
| `inspire_literature` | `get_paper` / `get_references` / `lookup_by_id` / `get_citations` / `search_affiliation` / `get_bibtex` / `get_author` | 统一 INSPIRE “原子能力”入口（standard） |
| `inspire_resolve_citekey` | - | 按 recid 批量解析 INSPIRE citekey + BibTeX + canonical links |
| `inspire_parse_latex` | `components=[sections/equations/theorems/citations/figures/tables/bibliography/all]` | LaTeX 解析写入 run artifact（需要 `run_id`，返回 URI + 摘要） |
| `inspire_deep_research` | `analyze` / `synthesize` / `write` | **深度研究与报告生成** |
| `inspire_research_navigator` | `discover` / `field_survey` / `topic_analysis` / `network` / `experts` / `connections` / `trace_source` / `analyze` | 统一研究导航门面（Phase 3） |
| `inspire_critical_research` | `evidence` / `conflicts` / `analysis` / `reviews` / `theoretical` | 批判性研究（含理论争议图谱；`theoretical` 需要 `run_id`） |
| `inspire_paper_source` | `urls` / `content` / `metadata` / `auto` | 论文源码访问 |
| `zotero_local` | `list_collections` / `list_collection_paths` / `list_items` / `get_item` / `get_item_attachments` / `download_attachment` / `get_attachment_fulltext` / `list_tags` | 统一 Zotero Local API 工具（standard；返回 JSON） |

**写作：**统一走 vNext `hep_*` 写作链（见 `docs/WRITING_RECIPE_DRAFT_PATH.md`、`docs/WRITING_RECIPE_CLIENT_PATH.md`）。

---

## 整合工具详细用法

### `inspire_deep_research` - 深度研究与报告生成

最强大的工具，支持三种模式：

#### 模式：`analyze` - 深度内容分析
```json
{
  "mode": "analyze",
  "identifiers": ["1833986", "627760"],
  "options": {
    "extract_equations": true,
    "extract_methodology": true,
    "extract_conclusions": true
  }
}
```
返回：提取到的组件（如公式、关键章节）以及紧凑摘要。

#### 模式：`synthesize` - 综述合成
```json
{
  "mode": "synthesize",
  "identifiers": ["1833986", "627760"],
  "format": "markdown",
  "options": {
    "review_type": "methodology",
    "include_critical_analysis": true
  }
}
```
返回：按方法论/时间线/对比分组的结构化综述。

#### 模式：`write` - Run-based 写作（vNext）
```json
{
  "mode": "write",
  "run_id": "<run_id>",
  "identifiers": ["1833986", "627760"],
  "options": {
    "topic": "奇特强子",
    "title": "奇特强子态综述",
    "target_length": "medium",
    "llm_mode": "client"
  }
}
```
返回：**run artifacts**（`hep://runs/{run_id}/artifact/...`）以及可选的 `client_continuation` prompts。下一步：
- host LLM 生成 N-best 章节候选，并提交 `hep_run_writing_submit_section_candidates_v1`
- 用 `hep_run_writing_submit_section_judge_decision_v1` 选择最佳候选（verifier/originality 在此触发）
- 若 `client_continuation.next_actions` 要求审稿：运行审稿 prompt 并通过 `hep_run_writing_submit_review` 提交 reviewer report
- 用 `hep_run_writing_integrate_sections_v1` 集成出 `writing_integrated.tex`（含 compile gate 与 diagnostics）
- 导出：
  - 研究资产包：`hep_export_project`（通常把 `rendered_latex_artifact_name` 指向 `writing_integrated.tex`）
  - 投稿脚手架：`hep_export_paper_scaffold`（写入 `paper_manifest.json` + `paper_scaffold.zip`）
  - 投稿回灌（可选）：`hep_import_paper_bundle`（导入最终 `paper/`，写入 `paper_bundle.zip` + `paper_final.pdf`）

### `inspire_research_navigator` - 发现/调研/网络/专家/溯源

#### 模式：`discover` - 奠基性/相关/扩展/综述发现
```json
{
  "mode": "discover",
  "discover_mode": "seminal",
  "topic": "QCD sum rules",
  "limit": 20
}
```

#### 模式：`field_survey` - 物理学家式文献调研
```json
{
  "mode": "field_survey",
  "topic": "nucleon structure",
  "limit": 30,
  "iterations": 2,
  "focus": ["open_questions", "controversies"]
}
```

#### 模式：`topic_analysis` - 时间线/演化/新兴方向
```json
{
  "mode": "topic_analysis",
  "topic": "pentaquark",
  "topic_mode": "timeline",
  "topic_options": { "granularity": "year" }
}
```

#### 模式：`network` - 引用/合作网络分析
```json
{
  "mode": "network",
  "network_mode": "citation",
  "seed": "1833986",
  "network_options": { "depth": 2 }
}
```

#### 模式：`experts` - 领域专家识别
```json
{
  "mode": "experts",
  "topic": "nucleon structure",
  "limit": 10,
  "format": "markdown"
}
```

#### 模式：`connections` - 跨论文关联发现
```json
{
  "mode": "connections",
  "seed_recids": ["1833986", "627760"],
  "include_external": true,
  "max_external_depth": 2
}
```

#### 模式：`trace_source` - 原始来源追溯
```json
{
  "mode": "trace_source",
  "seed": "1833986",
  "max_depth": 3,
  "cross_validate": true
}
```

#### 模式：`analyze` - 论文集合画像（兼容路径）
```json
{
  "mode": "analyze",
  "recids": ["1833986", "627760"],
  "analysis_type": ["overview", "timeline", "topics"]
}
```

### `inspire_critical_research` - 批判性分析

#### 模式：`evidence` - 证据质量分级
```json
{
  "mode": "evidence",
  "recids": ["1833986"]
}
```
返回：证据级别（discovery/evidence/hint/indirect/theoretical）

#### 模式：`conflicts` - 冲突检测
```json
{
  "mode": "conflicts",
  "recids": ["1833986", "627760"],
  "options": { "min_tension_sigma": 2 }
}
```
返回：测量冲突及张力 σ 值

#### 模式：`analysis` - 综合批判性分析
```json
{
  "mode": "analysis",
  "recids": ["1833986"],
  "options": { "include_assumptions": true }
}
```

#### 模式：`reviews` - 综述分类
```json
{
  "mode": "reviews",
  "recids": ["1833986", "627760"]
}
```
返回：综述类型（catalog/critical/consensus）

### `inspire_paper_source` - 论文源码访问

#### 模式：`urls` - 获取下载链接
```json
{
  "mode": "urls",
  "identifier": "2301.12345"
}
```

#### 模式：`content` - 下载论文内容
注意：如设置 `options.output_dir`，必须位于 `HEP_DATA_DIR` 内（路径安全）。建议传相对路径，例如 `"arxiv_sources/<arxiv_id>"`，或通过设置 `HEP_DATA_DIR` 来改变根目录。

```json
{
  "mode": "content",
  "identifier": "1833986",
  "options": { "prefer": "latex", "extract": true, "output_dir": "arxiv_sources/1833986" }
}
```

#### 模式：`metadata` - 获取 arXiv 元数据
```json
{
  "mode": "metadata",
  "identifier": "2301.12345"
}
```

### `inspire_parse_latex` - Run 级 LaTeX 解析（Evidence-first）

`inspire_parse_latex` 要求 `run_id`，并写入 `parse_latex_<hash>.json` 到 run artifacts。

```json
{
  "run_id": "<run_id>",
  "identifier": "1833986",
  "components": ["sections", "equations", "citations"],
  "options": { "format": "json", "cross_validate": true }
}
```

返回：artifact `uri`（`hep://runs/{run_id}/artifact/parse_latex_<hash>.json`）+ 紧凑 `summary`。

---

## 始终可用工具 (2个)

两种模式（`standard`/`full`）下始终可用：

| 工具 | 功能 |
|------|------|
| `inspire_search` | 使用 INSPIRE 语法搜索文献（采样；大结果导出用 `hep_inspire_search_export`） |
| `inspire_search_next` | 安全跟随 INSPIRE `next_url`（严格同源校验） |

## 写作（vNext）

写作统一走 run artifacts（Evidence-first）。见 `docs/WRITING_RECIPE_DRAFT_PATH.md` 与 `docs/WRITING_RECIPE_CLIENT_PATH.md`。

## Full-only 工具（部分）

仅当 `HEP_TOOL_MODE=full` 时可用：
服务器会在调用阶段强制校验：非 `full` 模式调用这些工具将直接报错。

| 工具 | 功能 |
|------|------|
| `inspire_find_crossover_topics` | 查找跨学科研究 |
| `inspire_analyze_citation_stance` | 引用立场分析 |
| `inspire_cleanup_downloads` | 清理下载文件 |
| `inspire_validate_bibliography` | 参考文献可用性审计（默认仅手工条目；可选 INSPIRE 交叉验证；warning 不阻断） |

---

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HEP_DATA_DIR` | 本地数据根目录（projects、runs、artifacts、cache、downloads） | `~/.hep-research-mcp` |
| `HEP_TOOL_MODE` | 工具暴露模式（`standard`/`full`；无效值会启动失败） | `standard` |
| `HEP_ENABLE_ZOTERO` | Zotero 开关：`0/false/no/off` 禁用，`1/true/yes/on` 启用（无效值会启动失败） | （默认启用） |
| `HEP_ENABLE_TOOL_USAGE_TELEMETRY` | 工具调用计数遥测（opt-in；`1/true/yes/on` 启用；通过 `hep_health.telemetry` 暴露） | （默认关闭） |
| `HEP_DEBUG` | 调试分类（逗号分隔）：`rate_limiter,cache,downloads,circuit_breaker,api,tools` | （空） |
| `DEBUG` | 额外调试日志（Node 常用约定） | （空） |
| `CONCURRENCY_LIMIT` | `inspire_deep_research` 的 write 模式章节生成并发数上限 | `1` |
| `HEP_DOWNLOAD_DIR` | 下载目录（必须位于 `HEP_DATA_DIR` 内） | `<dataDir>/downloads` |
| `ARXIV_DOWNLOAD_DIR` | `HEP_DOWNLOAD_DIR` 的别名 | `<dataDir>/downloads` |
| `WRITING_PROGRESS_DIR` | 长任务进度输出目录（必须位于 `HEP_DATA_DIR` 内） | `<dataDir>/writing_progress` |
| `ZOTERO_BASE_URL` | Zotero Local API base URL（**必须**是 `http://127.0.0.1:23119`） | `http://127.0.0.1:23119` |
| `ZOTERO_DATA_DIR` | Zotero 数据目录（包含 `zotero.sqlite` + `storage/`；用于读取 `.zotero-ft-cache`） | `~/Zotero` |
| `ZOTERO_FILE_REDIRECT_GUARD` | （可选加固）限制 Zotero 返回的 `file://` 重定向必须落在允许的根目录内（用于 linked attachment） | （默认禁用） |
| `ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS` | `file://` 重定向额外允许的根目录列表（macOS/Linux 用 `:` 分隔，Windows 用 `;`） | （空） |
| `PDG_DB_PATH` | 本机 PDG sqlite 数据库文件绝对路径（可选；启用 `pdg_*`） | （未设置） |
| `PDG_DATA_DIR` | PDG 本地数据目录（可选；包含 `artifacts/`） | （若设置了 `HEP_DATA_DIR` 则为 `<HEP_DATA_DIR>/pdg`；否则 `~/.hep-research-mcp/pdg`） |
| `PDG_ARTIFACT_TTL_HOURS` | PDG artifacts 缓存 TTL（小时；`0/off` 禁用；启动时 + 周期性清理） | `24` |
| `PDG_ARTIFACT_DELETE_AFTER_READ` | 若启用，则在通过 `pdg://artifacts/<name>` 成功读取后立即删除该文件 | （默认禁用） |
| `PDG_TOOL_MODE` | PDG 工具暴露模式（`standard`/`full`） | `standard` |
| `PDG_SQLITE_CONCURRENCY` | PDG 工具并行查询的 `sqlite3` 进程数上限 | `4` |

### Zotero Local API 设置（Zotero 7）

1. 在 Zotero 中启用 **Local API**（Advanced → Local API）。
2. 为 MCP server 设置环境变量：
   - `ZOTERO_BASE_URL=http://127.0.0.1:23119`
   - （可选）`ZOTERO_DATA_DIR=~/Zotero`（仅当你的 Zotero 数据目录不是默认位置时需要）
   - （可选加固）`ZOTERO_FILE_REDIRECT_GUARD=1`（默认会阻止 linked attachment，除非你显式放行其目录）
   - （可选加固）`ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS=/path/to/linked/pdfs`（多个根目录用 `:`/`;` 分隔）
3. 快速自检（应返回 JSON，而不是 HTML）：

```bash
curl "http://127.0.0.1:23119/api/users/0/collections?limit=1"
```

如果你用浏览器直接打开 `/api/...` URL 看到 `Request not allowed`，这是正常现象（Zotero 会拦截浏览器型请求）；请以 `curl` 或本地程序（如本 MCP server）的访问结果为准。

参考文档：https://www.zotero.org/support/dev/zotero_7_for_developers

说明：Zotero 的 Local API 暴露在 `http://127.0.0.1:23119/api/`，接口形态与字段/分页/查询参数大体遵循 Zotero Web API v3。可以把 Web API v3 文档当作“端点与字段参考”（但实际请求仍然只打 localhost，不使用 zotero.org Web API）：https://www.zotero.org/support/dev/web_api/v3/basics

说明：所有 `*_at`/`generated_at` 时间戳均使用 ISO 8601 **UTC（带 `Z`）**，不是本地时区字符串。

### 在 Zotero 中查找条目（`zotero_find_items`）

`zotero_find_items` 支持两类查询：
- `identifiers`：DOI/arXiv/INSPIRE recid/title/item_key
- `filters`：tags/authors（creators）/publication_title/year/volume/issue

最小示例（tool args JSON）：

```json
{ "identifiers": { "doi": "10.1103/PhysRevLett.116.061102" } }
```

```json
{ "filters": { "tags": ["hep-th"], "authors": ["Witten"], "publication_title": "Physical Review Letters", "year": 2016 } }
```

### 向 Zotero 添加条目（`zotero_add`）

`zotero_add` 的入参里 **必须**有 `source`，并且 `source` 是一个 discriminated union（这是最常见的调用方误用点）。

- 典型用法：先在 Zotero 左侧选中目标 collection，然后不传 `collection_keys` 直接调用 `zotero_add`（会写入当前选中 collection）。
- 如果 Zotero 当前选中的是 library root，则会报错；除非显式传 `allow_library_root=true` 才允许写入 root。

最小示例（tool args JSON）：

```json
{ "source": { "type": "doi", "doi": "10.1103/PhysRevLett.116.061102" }, "tags": ["hep"], "note": "可选 note" }
```

```json
{ "source": { "type": "arxiv", "arxiv_id": "2001.00001" } }
```

```json
{ "source": { "type": "inspire", "recid": "123456" } }
```

```json
{ "source": { "type": "item", "item": { "itemType": "journalArticle", "title": "My Paper", "DOI": "10.1000/xyz" } } }
```

### 数据目录结构（`HEP_DATA_DIR`）

所有 vNext 状态都只在本地、并统一落在 `HEP_DATA_DIR` 下：

```
<HEP_DATA_DIR>/
  cache/                  # 持久化磁盘缓存（可安全删除）
  corpora/                # 可选本地语料（写作风格包等）
  downloads/              # 临时 arXiv 下载（TTL 自动清理）
  models/                 # 可选本地模型（embedding/rerank；仅本地）
  projects/<project_id>/  # 长期研究资产（papers、evidence catalogs）
  runs/<run_id>/          # run manifests + artifacts（审计与复现）
```

> 注：PDG artifacts 位于 `PDG_DATA_DIR` 下。若设置了 `HEP_DATA_DIR`，则 `PDG_DATA_DIR` 默认会跟随为 `<HEP_DATA_DIR>/pdg`（更便于随项目迁移/清理）；否则默认是 `~/.hep-research-mcp/pdg`。`PDG_DATA_DIR/artifacts` 视为查询缓存，按 `PDG_ARTIFACT_TTL_HOURS` 自动清理。

#### 多项目 vs 多根目录

- **单根目录**：保持一个固定 `HEP_DATA_DIR`，在其中创建多个 `hep_project_create` 项目；旧项目/旧 run 会持续在 `hep://projects` / `hep://runs` 中可发现。
- **每个研究一个根目录**：把 `HEP_DATA_DIR` 设到当前研究目录下（例如 `<research>/.hep-research-mcp`），便于“整体打包/移动/删除”。注意：切换 `HEP_DATA_DIR` 后，之前聊天里返回的 `hep://...` URI 只会在切回原根目录时再次可读。

#### 快速清理

- PDG 查询缓存：`rm -rf "${PDG_DATA_DIR:-$HOME/.hep-research-mcp/pdg}/artifacts"`（安全；仅影响可重复生成的 PDG 查询输出）
- HEP 持久化缓存：`rm -rf "${HEP_DATA_DIR:-$HOME/.hep-research-mcp}/cache"`（安全）

说明：部分 MCP 客户端会把“曾经返回过的 artifact URI”也展示在 Resources 列表中；删除文件能回收磁盘空间，但 UI 列表是否立即变干净取决于客户端缓存策略，通常重启/重新加载 MCP server 后会刷新。

### 磁盘缓存

默认情况下，持久化缓存位于 `<HEP_DATA_DIR>/cache`（gzip 压缩条目）。若升级后怀疑缓存陈旧/损坏，可直接删除该目录，功能不受影响。

### Deep Research 的 write 模式（vNext）

`inspire_deep_research`（mode=`write`）是 Evidence-first：传入 `run_id`，输出统一写入 run artifacts，并通过 `hep://runs/{run_id}/...` resources 读取。

| llm_mode | 行为 |
|----------|------|
| `client` | 返回 `client_continuation` prompts/next_actions；host LLM 提交 N-best 候选 + judge 决策（`hep_run_writing_submit_section_candidates_v1` / `hep_run_writing_submit_section_judge_decision_v1`） |
| `passthrough` | 与 `client` 类似，面向外部编排；章节提交仍通过“候选 + judge”链路 |
| `internal` | server 使用配置的 LLM 客户端生成章节，并写入 section/verification/originality artifacts |

示例（client 模式）：

```json
{
  "mode": "write",
  "run_id": "<run_id>",
  "identifiers": ["1833986", "627760"],
  "options": {
    "topic": "奇特强子",
    "title": "奇特强子态综述",
    "target_length": "medium",
    "llm_mode": "client"
  }
}
```

### LLM 配置（`internal` 模式）

`internal` 模式使用内置 LLM 客户端生成章节内容，并自动进行验证。通过环境变量配置：

#### 必需变量

```bash
# 启用 internal 模式
export WRITING_LLM_MODE=internal

# 提供商选择（必需）
export WRITING_LLM_PROVIDER=deepseek  # 见下方支持的提供商

# API 密钥（必需）
export WRITING_LLM_API_KEY=YOUR_API_KEY
```

#### 可选变量

```bash
# 模型选择（不设置则使用提供商默认模型）
export WRITING_LLM_MODEL=deepseek-chat

# 自定义 API 端点（用于自托管或代理）
export WRITING_LLM_BASE_URL=https://api.deepseek.com/v1

# 生成参数
export WRITING_LLM_TEMPERATURE=0.3      # 默认: 0.3
export WRITING_LLM_MAX_TOKENS=8192      # 默认: 提供商特定

# 超时和重试
export WRITING_LLM_TIMEOUT=90000        # 默认: 90 秒
export WRITING_LLM_MAX_RETRIES=3        # 默认: 3 次
```

#### 支持的 LLM 提供商

| 提供商 | 默认模型 | API 类型 | 默认 Base URL |
|--------|----------|----------|---------------|
| `openai` | gpt-4o | 原生 | api.openai.com/v1 |
| `anthropic` | claude-sonnet-4-20250514 | 原生 | api.anthropic.com |
| `google` | gemini-1.5-pro | 原生 | generativelanguage.googleapis.com |
| `deepseek` | deepseek-chat | OpenAI 兼容 | api.deepseek.com/v1 |
| `kimi` | moonshot-v1-128k | OpenAI 兼容 | api.moonshot.cn/v1 |
| `glm` | glm-4-plus | OpenAI 兼容 | open.bigmodel.cn/api/paas/v4 |
| `qwen` | qwen-max | OpenAI 兼容 | dashscope.aliyuncs.com/compatible-mode/v1 |

#### 模式优先级

1. **工具参数**（最高）：工具调用中的 `llm_mode`
2. **环境变量**：`WRITING_LLM_MODE`
3. **智能默认**：如果配置了 API 密钥则使用 `internal`，否则 `client`

#### Write-Verify-Revise 循环

使用 `internal` 模式时，系统自动执行：
1. 使用配置的 LLM 生成草稿内容
2. 验证引用是否来自允许的来源
3. 检测原创性（n-gram 重叠检测）
4. 如果验证失败，生成修正反馈并重试（最多 3 次）
5. 返回带有质量指标的最终输出

### 进度与续跑（Run-based）

vNext 工作流的进度统一记录在 run manifest：`hep://runs/{run_id}/manifest`（steps + artifacts）。`inspire_deep_research` 的 write 模式可在同一 `run_id` 上通过 `resume_from` 从某一步继续。

### INSPIRE 搜索语法

**作者重名消歧提示：** INSPIRE 提供稳定的作者标识 **BAI**（例如 `E.Witten.1`）。做作者检索时建议优先用 BAI：`a:E.Witten.1`（而不是歧义较大的姓名检索）。

| 语法 | 示例 | 说明 |
|------|------|------|
| `a:` | `a:witten` | 按作者搜索（支持 INSPIRE BAI，例如 `a:E.Witten.1`） |
| `t:` | `t:supersymmetry` | 按标题搜索 |
| `aff:` | `aff:CERN` | 按机构搜索 |
| `topcite:` | `topcite:500+` | 引用数过滤 |
| `date:` | `date:2020->2024` | 日期范围 |
| `j:` | `j:Phys.Rev.D` | 期刊过滤 |
| `eprint:` | `eprint:2301.12345` | arXiv ID |
| `fulltext:` | `fulltext:"dark matter"` | 全文搜索 |

## MCP 服务器安装

### 工具名前缀（客户端 Namespacing）

一些 MCP 客户端/agent runtime 会对工具名做 namespacing，把工具暴露成 `mcp__<serverAlias>__<toolName>`（例如：`mcp__hep__inspire_search`）。其中 `serverAlias` 是你在客户端配置里的 MCP server key（例如 `hep`、`hep-research-mcp` 等）。

务必以 **客户端 Tools 列表里显示的完整工具名** 为准调用；如果出现 “tool not found”，请打开 Tools 列表复制/粘贴完整名字（不要靠猜）。

快速自检：调用 `hep_health`（如需探测 INSPIRE 连通性，可传 `check_inspire=true`）。

### Claude Desktop

编辑配置文件 `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) 或 `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "hep-research-mcp": {
      "command": "node",
      "args": ["/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"]
    }
  }
}
```

### Cursor

可在 Cursor 设置界面（Settings → MCP）添加服务器，或直接编辑 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "hep-research-mcp": {
      "command": "node",
      "args": ["/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"]
    }
  }
}
```

**如果你看到 `spawn node ENOENT`**
- 这表示 Cursor 在启动 MCP server 时找不到 `node`（PATH 里没有）。在 macOS 上，若 Cursor 作为 GUI App 启动，往往不会继承你 shell 里的 PATH。
- 解决：把 `"command"` 改为 node 的绝对路径（例如 Homebrew 常见是 `/opt/homebrew/bin/node`），或在 `"env"` 里显式设置 `PATH`。

**如何在 Cursor 里看到 Tools**
1. 确保已构建：`pnpm -r build`（需要存在 `dist/index.js`）。
2. 重启 Cursor（或在你的版本里手动刷新 MCP servers 列表）。
3. 打开 Chat/Agent → 找到 **Tools** 列表/面板 → 对 `hep-research-mcp` 启用工具（Cursor 通常对每个 MCP server 需要单独“信任/启用工具”）。

**如果仍然看不到 Tools**
- Cursor 可能会在 `listTools` 返回的 schema 不合法时直接隐藏 Tools。请先重新执行 `pnpm -r build`，重启 Cursor，然后按 `docs/TESTING_GUIDE.md` 的 “listTools sanity check” 小节排查。

**如果你发现 Resources 列表没有列出每个 artifact**
- 这是预期：Resources 列表采用 “Iceberg” 入口模型，只显示 `hep://projects` / `hep://runs` / `hep://corpora` / `pdg://artifacts` 等入口。
- 想查看“之前做过哪些项目”：读取 `hep://projects`。
- 想查看 runs：读取 `hep://runs`，再读 `hep://runs/{run_id}/manifest` 获取该 run 的 artifacts 列表。

### Claude Code CLI

```bash
claude mcp add hep-research-mcp -- node /path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js
```

### Chatbox

[Chatbox](https://chatboxai.app/) 是一款跨平台 AI 聊天客户端，支持 MCP 协议。

1. 打开 Chatbox 设置 → MCP 服务器
2. 点击"添加服务器"
3. 配置如下：

```json
{
  "hep-research-mcp": {
    "command": "node",
    "args": ["/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"]
  }
}
```

或通过配置文件 `~/.chatbox/mcp.json`（路径可能因系统而异）。

### Cherry Studio

[Cherry Studio](https://cherry-ai.com/) 是一款支持多模型的 AI 助手，支持 MCP 协议。

1. 打开 Cherry Studio 设置 → MCP 设置
2. 添加新的 MCP 服务器
3. 填写配置：
   - **名称**: `hep-research-mcp`
   - **命令**: `node`
   - **参数**: `/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js`

### 其他支持 MCP 的工具

MCP 是开放协议，以下工具也支持 MCP 服务器：

| 工具                                   | 配置方式                    | 说明                |
| -------------------------------------- | --------------------------- | ------------------- |
| **Cline** (VS Code)              | 设置 → MCP Servers         | VS Code AI 编程助手 |
| **Continue** (VS Code/JetBrains) | `~/.continue/config.json` | 开源 AI 编程助手    |
| **Zed**                          | 设置 → Assistant → MCP    | 现代代码编辑器      |

**通用配置格式**（大多数工具兼容）：

```json
{
  "mcpServers": {
    "hep-research-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

> **提示**: 请将 `/path/to/` 替换为实际的绝对路径。

### 可选配置

通过环境变量自定义 hep-research-mcp 行为：

	```json
	{
	  "mcpServers": {
	    "hep-research-mcp": {
	      "command": "node",
	      "args": ["/path/to/hep-research-mcp/packages/hep-research-mcp/dist/index.js"],
		      "env": {
		        "HEP_DATA_DIR": "/path/to/hep-data",
		        "HEP_TOOL_MODE": "full",
		        "HEP_DOWNLOAD_DIR": "/path/to/hep-data/downloads",
		        "HEP_DEBUG": "tools,downloads",
		        "ZOTERO_BASE_URL": "http://127.0.0.1:23119",
		        "ZOTERO_DATA_DIR": "/path/to/Zotero",
		        "WRITING_LLM_PROVIDER": "deepseek",
		        "WRITING_LLM_MODEL": "deepseek-chat",
		        "WRITING_LLM_API_KEY": "YOUR_API_KEY"
		      }
	    }
	  }
	}
	```

Zotero Local API 无认证：不需要 Local API Key。

说明：Zotero Local API 不提供稳定的 fulltext HTTP 端点。`zotero_local`（mode=`get_attachment_fulltext`）用于解析 `ZOTERO_DATA_DIR/storage/<attachmentKey>/.zotero-ft-cache` 路径（默认 `~/Zotero`）；当 `hep_run_build_pdf_evidence` 传 `zotero_attachment_key` 时会自动读取该缓存。

> 注意：不要提交任何包含真实 API Key 的配置文件。请将本地 MCP 配置（如 `.mcp.json`）排除在 git 之外。

详见 [环境变量](#环境变量) 和 [LLM 配置](#llm-配置internal-模式) 部分的完整说明。

## 工具调用示例

以下展示 AI 助手如何调用 hep-research-mcp 工具完成各种任务：

### 示例 1：深度调研某个主题

```
用户: 帮我调研 pentaquark 领域的发展历程

AI: [调用 inspire_search] 搜索 pentaquark 相关文献
    [调用 inspire_research_navigator] 识别奠基性论文（mode=discover, discover_mode=seminal）
    [调用 inspire_research_navigator] 分析引用网络（mode=network, network_mode=citation）
    [调用 inspire_research_navigator] 生成时间线（mode=topic_analysis, topic_mode=timeline）

    ## Pentaquark 研究发展历程

    ### 奠基性工作
    - LHCb 2015 (recid: 1380672) - 首次发现五夸克态
    ...
```

### 示例 2：深度内容分析与综述生成

```
用户: 帮我分析这几篇论文的核心公式和方法，生成综述

AI: [调用 inspire_deep_research] 深度分析论文内容（mode=analyze）
    - 提取公式/关键章节/引用上下文（按需可开启更细粒度解析选项）

    [调用 inspire_deep_research] 生成结构化综述（mode=synthesize）
    - 按方法论分组
    - 提取关键公式
    - 生成 Markdown 格式输出

    ## Review: Pentaquark States

    ### Methodology Group: QCD Sum Rules
    - Paper 1: 使用 QCD sum rules 方法...

    ### Key Equations
    ```latex
    \Pi(q^2) = \int d^4x e^{iq\cdot x} \langle 0|T\{J(x)J^\dagger(0)\}|0\rangle
    ```
```

### 示例 3：发现新兴研究方向（社会学指标）

```
用户: 哪些 exotic hadron 论文可能代表范式转移？

AI: [调用 inspire_research_navigator] 检测新兴论文（mode=topic_analysis, topic_mode=emerging）
    - include_sociology: true
    - sample_mode: 'fast'

    ## 潜在范式转移论文

    1. recid: 2847123
       - 引用动量: 0.85 (Hot!)
       - 新进入者比例: 0.45 (高)
       - 颠覆指数: 0.32 (颠覆性)
       - 置信度: high
       - 类型: kinematic + sociological
```

## 文档

- [功能测试指南（逐项对照版）](./TESTING_GUIDE.md)
- [pdg-mcp 文档](../packages/pdg-mcp/README_zh.md)

## 相关项目

- [zotero-inspire](https://github.com/fkguo/zotero-inspire) - Zotero INSPIRE 插件
- [INSPIRE-HEP](https://inspirehep.net) - 高能物理文献数据库
- [INSPIRE REST API](https://github.com/inspirehep/rest-api-doc) - INSPIRE API 文档

## 引用

### 引用本项目

如果本项目对您的研究有帮助，欢迎在致谢中提及。

### 引用 INSPIRE API

如果在学术工作中使用了 INSPIRE 数据，请按 INSPIRE 要求引用：

```bibtex
@article{Moskovic:2021zjs,
    author = "Moskovic, Micha",
    title = "{The INSPIRE REST API}",
    url = "https://github.com/inspirehep/rest-api-doc",
    doi = "10.5281/zenodo.5788550",
    year = "2021"
}
```

## Development

本项目使用 AI 辅助开发。AI 协助完成了代码实现、文档编写和代码审查。

## License

MIT
