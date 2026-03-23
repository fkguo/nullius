# Architecture Overview

本文档面向 AI coding agents（如 Claude Code、Codex）提供项目架构的全局理解，便于快速上手开发。
**维护要求**：任何架构层面的变更都必须同步更新本文档。

---

## 1. 设计原则

### 1.1 Evidence-First I/O

核心原则：**大对象写入 artifacts + MCP Resources；tool result 仅返回 URI + 小摘要**

```
┌─────────────┐     large content      ┌──────────────────┐
│  Tool Call  │ ─────────────────────▶ │  Run Artifact    │
│  (input)    │                        │  (on-disk file)  │
└─────────────┘                        └────────┬─────────┘
                                                │
┌─────────────┐     URI + summary      ┌────────┴─────────┐
│ Tool Result │ ◀───────────────────── │  hep:// Resource │
│  (output)   │                        │  (MCP protocol)  │
└─────────────┘                        └──────────────────┘
```

**设计目的**：
- 防止 LLM 上下文 token 溢出
- 支持任意大小的研究产出
- 保留完整审计追踪

### 1.2 Local-First

- **Stdio-Only Transport**：仅 `StdioServerTransport`，不实现 HTTP/REST
- **Zotero Local API Only**：仅 `http://127.0.0.1:23119`
- **本地数据存储**：所有 artifacts 存储在 `HEP_DATA_DIR`（默认 `~/.hep-research-mcp`）
- **PDG artifacts 默认按 TTL 清理**：`pdg://artifacts/*` 视为本地查询缓存；默认保留 24 小时（`PDG_ARTIFACT_TTL_HOURS`，设为 `0/off` 可禁用清理）

### 1.3 Zod as SSOT

- 工具参数以 **Zod schema** 为单一事实来源
- MCP `inputSchema` 由 `zodToMcpInputSchema()` 自动生成
- 避免手写 JSON Schema 导致的漂移

### 1.4 Quality-First (v0.3.0)

**核心原则**：学术写作质量优先于成本/延迟

- 默认启用质量增强功能（如 LLM rerank）
- 不为节省微小成本（如几分钱 token）而牺牲引用准确性或检索质量
- 在算法设计中优先考虑输出质量而非执行速度

**体现**：
- RAG 检索默认启用 LLM 语义重排序（而非基于规则的关键词匹配）
- 写作工作流采用软指导 + 关键质量硬门（例如引用 allowlist / token gate；不允许静默降质）
- Token overflow 防护机制确保大文档不丢失内容

### 1.5 Fail-fast（禁止静默降质）

- 工具不得在语义上“悄悄变成另一种实现”（例如 semantic query 退化为 lexical）
- LaTeX parsing 不允许 truncated/regex fallback 进入证据链；解析失败直接报错并提供可执行的 `next_actions`
- Export 不允许生成 placeholder BibTeX；任意 citekey 缺失即 hard fail
- 启动时环境变量校验严格；无效值直接失败（例如 `HEP_TOOL_MODE` / `HEP_ENABLE_ZOTERO`）

### 1.6 Iceberg Resource Discovery（减少客户端噪声）

- `resources/list` **只暴露少量入口资源**（例如 `hep://projects` / `hep://runs` / `pdg://artifacts`），避免在客户端 UI 中平铺成千上万条中间产物
- 具体 artifact/paper/run 等通过：
  - 入口资源（index）返回的子 URI（例如 `hep://runs/{run_id}/manifest` 会列出 artifacts）
  - `resources/templates/list` 暴露的 URI 模板（例如 `hep://runs/{run_id}/artifact/{name}`）

### 1.7 Skill→MCP 桥接契约（v0.3.2）

为减少 skill 入口与 MCP 直调入口之间的语义漂移，run-scoped 工具结果统一补充轻量 `job` envelope（不替代 artifacts）：

- `job.job_id`：等于 `run_id`（把 run 视为可轮询作业）
- `job.status_uri`：统一指向 `hep://runs/{run_id}/manifest`
- `job.polling.strategy`：`manifest_resource`（客户端/skill 读取 manifest 轮询状态）
- `job.status`：基于当前 run manifest 的快照（`created|running|done|failed`，best-effort）

失败语义保持 fail-fast：仍使用 `INVALID_PARAMS` + `next_actions`；不引入静默降级。

---

## 2. 代码结构

```
packages/
├── hep-research-mcp/           # 主 MCP server（聚合所有工具）
│   └── src/
│       ├── index.ts            # 入口：MCP server 启动
│       ├── tools/
│       │   ├── registry.ts     # 工具注册表（SSOT：50+ 工具定义）
│       │   ├── dispatcher.ts   # 调度器：参数校验 + 错误处理
│       │   ├── mcpSchema.ts    # Zod → MCP inputSchema 转换
│       │   └── research/       # 工具实现模块
│       │       ├── inspire/    # INSPIRE API 相关
│       │       ├── stance/     # 立场分析 / 冲突检测
│       │       └── writing/    # 写作辅助
│       ├── core/
│       │   └── semantics/      # LLM-first 语义裁决核心（quantity / claim / evidence）
│       │       └── quantity*/claim*/evidence*.ts
│       ├── tools/research/synthesis/
│       │   ├── collectionSemantic*.ts # Batch D: open-text grouping + explicit heuristic fallback provenance
│       │   └── challenge*.ts          # Batch D: open-text challenge extraction + fallback taxonomy normalization
│       ├── vnext/              # vNext 本地工作流（核心）
│       │   ├── projects.ts     # Project CRUD
│       │   ├── runs.ts         # Run 管理 + manifest
│       │   ├── citations.ts    # 引用映射
│       │   ├── resources.ts    # hep:// 资源协议实现
│       │   ├── hep/            # HEP 数值工具链（run measurements / cross-run compare）
│       │   │   ├── measurements.ts
│       │   │   └── compareMeasurements.ts
│       │   └── writing/        # 写作链
│       │       ├── evidenceIndex.ts   # M03: EvidenceChunk + BM25 index（run artifacts）
│       │       ├── evidenceSelection.ts # M04: Retrieval candidates + LLM rerank + EvidencePacketV2（client闭环）
│       │       ├── tokenBudgetPlan.ts  # M05: TokenBudgetPlan（预算 SSOT，artifact-first）
│       │       ├── tokenGate.ts        # M05: TokenGate（fail-fast；超限写 overflow artifact）
│       │       ├── submitSection.ts
│       │       ├── renderLatex.ts
│       │       └── integrate.ts
│       ├── api/
│       │   ├── client.ts       # INSPIRE API 客户端
│       │   └── rateLimiter.ts  # 速率限制（inspireFetch/arxivFetch）
│       └── data/
│           └── dataDir.ts      # HEP_DATA_DIR 路径管理
│
├── zotero-mcp/                 # Zotero Local API tools
├── pdg-mcp/                    # PDG 离线数据库 tools
└── shared/                     # 共享 types/errors/utils
```

---

## 3. 核心抽象

### 3.1 Project / Run 模型

```
Project (长期研究容器)
├── project_id: string
├── name: string
├── description: string
├── papers: { paper_id → LaTeXSource }
└── created_at / updated_at

Run (版本化执行上下文)
├── run_id: string
├── project_id: string (所属 Project)
├── status: 'running' | 'done' | 'failed'
├── steps: RunStep[]           # 执行步骤审计
└── artifacts/                 # 产出文件目录
    ├── latex_evidence_catalog.jsonl
    ├── latex_evidence_embeddings.jsonl
    ├── latex_evidence_enrichment.jsonl
    ├── hep_measurements_<hash>.jsonl
    ├── hep_compare_measurements_<hash>.json
    ├── writing_section_001.json
    ├── writing_verification_001.json
    └── ...
```

### 3.2 RunStep 与 Artifact

```typescript
interface RunStep {
  step: string;        // e.g., 'writing_claims', 'writing_outline'
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  artifacts?: RunArtifactRef[];  // 产出的 artifact URI
  completed_at?: string;
}

interface RunArtifactRef {
  name: string;        // e.g., 'writing_section_001.json'
  uri: string;         // e.g., 'hep://runs/{run_id}/artifact/...'
}
```

### 3.3 hep:// 资源协议

| URI 模式 | 描述 |
|----------|------|
| `hep://projects` | Projects index |
| `hep://projects/{project_id}` | Project manifest |
| `hep://projects/{project_id}/papers` | Project papers index |
| `hep://projects/{project_id}/papers/{paper_id}` | Paper manifest |
| `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog` | 论文证据目录 |
| `hep://runs` | Runs index |
| `hep://runs/{run_id}/manifest` | Run manifest（步骤 + artifacts） |
| `hep://runs/{run_id}/artifact/{name}` | 具体 artifact 内容 |
| `pdg://info` | PDG MCP info |
| `pdg://artifacts` | PDG artifacts index |
| `pdg://artifacts/{artifact_name}` | PDG artifact by name |

### 3.4 Skill Bridge `job` Envelope

run-scoped tool result（包含 `run_id`）会自动补充：

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

该 envelope 仅用于桥接入口一致性与轮询约定；研究结果仍以 artifacts + resources 为权威来源。

---

## 4. 数据流

### 4.1 写作工作流（Draft Path）

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 0: Setup                                                   │
│   hep_project_create → hep_run_create                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: Evidence Building                                       │
│   hep_run_build_writing_evidence    → LaTeX evidence catalog    │
│   hep_run_build_pdf_evidence        → PDF text/visual evidence  │
│   hep_run_build_citation_mapping    → BibTeX ↔ INSPIRE mapping  │
│   hep_run_build_measurements        → numeric extraction        │
│   hep_project_compare_measurements  → cross-run tension flags   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: Rendering                                               │
│   hep_render_latex                                               │
│   → rendered_latex.tex + rendered_section_output.json            │
│   → citation verification + allowed_citations enforcement        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3: Export / Publication                                    │
│   hep_export_project                                             │
│   → master.bib, report.tex, report.md, research_pack.zip         │
│   hep_export_paper_scaffold                                      │
│   → paper/ scaffold + paper_scaffold.zip                         │
│   hep_import_paper_bundle (post research-writer)                 │
│   → paper_bundle.zip + paper_final.pdf (optional)                │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Tool Result 大小控制

```typescript
// 示例：WriteResult 结构（仅返回摘要，大内容在 artifacts）
interface WriteResult {
  claims_table: { total: number; by_type: Record<string, number> };  // 计数
  outline: { section_count: number; reference_count: number };       // 摘要
  sections: Array<{
    section_index: number;
    mode_used: string;
    bibtex_keys_used: string[];
  }>;
  summary: { total_sections: number; total_claims: number };
  // 完整内容通过 hep://runs/.../artifact/... 访问
}
```

---

## 5. Token 管理机制

### 5.1 现有保护措施

| 机制 | 位置 | 说明 |
|------|------|------|
| Artifact 输出 | `vnext/runs.ts` | 大内容写入磁盘，tool result 仅返回 URI |
| 分块读取 | `artifactChunk.ts` | 64KB 最大块，支持 offset/length |
| JSONL 流式 | Evidence catalogs | 逐行处理，避免全量加载 |
| Result Summary | `registry.ts` handlers | 返回计数/摘要而非原始内容 |

### 5.2 输入端 Token 问题（已部分解决）

当前 Evidence-First 主要解决 **输出端**（MCP → Client）的 token 问题。
**输入端**（Client → MCP）的大内容提交仍可能触发 token 限制：

- 大型章节内容提交（中文 + 复杂公式）
- 复杂 JSON 结构叠加

**已实现机制**（强约束；不允许静默降级）：

1. **Artifact URI 间接提交**：`hep_run_stage_content`（写入 staging artifact）+ submit tools 接收 `*_uri`
2. **无内建“分块提交”工具**：输入过大时，必须通过 staging + 拆分任务/缩小输入解决；禁止静默截断继续跑

### 5.3 Token 管理

大输出通过 staging artifact（`hep_run_stage_content`）提交；输入过大时必须拆分任务或缩小输入，禁止静默截断。
- `packages/hep-research-mcp/src/tools/registry.ts`（新增 run tools 注册）
- `packages/hep-research-mcp/tests/vnext/*`（预算/门控相关回归）

**Fail-fast 语义**：
- pass：写 `token_gate_pass_*_v1.json` 并返回 `summary.gate='pass'`
- overflow：写 `writing_token_overflow_*_v1.json`，并以 `INVALID_PARAMS` 返回（`error.data` 含 `token_overflow_uri` + `next_actions`）；禁止任何 silent trim/截断继续跑

---

## 6. 工具注册与调度

### 6.1 注册表结构

```typescript
// packages/hep-research-mcp/src/tools/registry.ts
interface ToolSpec {
  name: string;                    // 工具名称
  zodSchema: ZodType;              // 参数 schema（SSOT）
  handler: (params: unknown) => Promise<unknown>;
  intent?: string;                 // 语义意图标签（用于门面分层/治理）
  maturity?: 'stable' | 'experimental' | 'deprecated'; // 生命周期元数据
  exposure: 'standard' | 'full';   // 暴露级别
}

// 注册示例
{
  name: 'hep_project_create',
  zodSchema: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
  handler: async (params) => { /* ... */ },
  intent: 'project_lifecycle',
  maturity: 'stable',
  exposure: 'standard',
}
```

### 6.1.1 Phase 2：导航门面收敛（历史态，已被 M-24 supersede）

- Phase 2 曾将 `inspire_discover_papers` / `inspire_field_survey` / `inspire_topic_analysis` / `inspire_network_analysis` 临时收敛为单一门面 `inspire_research_navigator`
- 该设计在当时降低了 tool 数量，但也把大量 mode-specific 无效参数暴露到统一公开 schema 顶层
- **Superseded (2026-03-23, M-24)**：当前公开 truth 已不再使用这个 facade；保留这里只是记录历史阶段，而不是现行接口建议

### 6.1.2 当前公开 surface：专用导航工具 + 独立 LaTeX 解析

- 当前标准公开面恢复为 dedicated first-class tools：
  - `inspire_discover_papers`
  - `inspire_field_survey`
  - `inspire_topic_analysis`
  - `inspire_network_analysis`
  - `inspire_find_connections`
  - `inspire_trace_original_source`
- `experts` / `analyze` 公开入口已移除；不再保留 `inspire_research_navigator`
- 设计目标从“最少工具数”转为“让 MCP client 看到干净、语义清晰、无顶层无效参数暴露的 object schema”
- `inspire_parse_latex` 继续保持独立 Evidence-first 语义：
  - 入参必须包含 `run_id`
  - 产物写入 `parse_latex_<hash>.json`（run artifact）
  - tool result 仅返回 `uri + summary`

### 6.2 调度流程

```
MCP Tool Call
    │
    ▼
dispatcher.ts
    │
    ├─▶ 查找 ToolSpec（by name）
    │
    ├─▶ zodSchema.parse(args)   // 参数校验
    │
    ├─▶ handler(parsedArgs)     // 执行
    │
    └─▶ formatToolResult()      // 格式化返回
```

### 6.3 Phase 4 补充（质量核心与工程卫生）

- **4.1 参考文献审计语义重定义**：`inspire_validate_bibliography` 默认为“手工条目可用性审计”（`scope=manual_only`），核心检查“可编译 + 可定位（DOI/arXiv/journal+volume+pages）”，告警仅 warning，不作为研究质量门控。
- **4.5 Zotero Find/Search 内部桥接**：`zotero_find_items` 与 `zotero_search_items` 复用内部 bridge executor，统一读路径实现、降低漂移风险，同时保留验证式与浏览式语义边界。
- **4.9 遥测（opt-in）**：dispatcher 在成功调用后记录工具计数，`hep_health` 扩展 `telemetry` 摘要（默认关闭，环境变量 `HEP_ENABLE_TOOL_USAGE_TELEMETRY` 控制）。
- **4.10 Skill↔MCP 作业语义**：run-scoped 响应附加 `job` envelope（`job_id/status_uri/polling`），统一技能层与 MCP 直调的长任务轮询契约。
- **4.7/4.8/4.11 文档对齐原则**：PDG 仅做版本透明化（不做 freshness 裁决）；style corpus 对齐以语义与证据契约一致为目标；中英文档采用“英文主语义 + 中文同步参考”策略。

---

## 7. 关键文件索引

| 文件 | 职责 |
|------|------|
| `src/index.ts` | MCP server 入口 |
| `src/tools/registry.ts` | 工具注册表（SSOT） |
| `src/tools/dispatcher.ts` | 调度 + 错误处理 |
| `src/tools/mcpSchema.ts` | Zod → MCP schema 转换 |
| `src/vnext/projects.ts` | Project CRUD |
| `src/vnext/runs.ts` | Run 管理 + manifest |
| `src/vnext/resources.ts` | hep:// 资源协议 |
| `src/vnext/writing/submitSection.ts` | 章节提交 + 验证 |
| `src/api/rateLimiter.ts` | 网络请求速率限制 |

---

## 8. 扩展点

### 8.1 添加新工具

1. 在 `registry.ts` 添加 `ToolSpec`
2. 实现 handler（遵循 Evidence-First：大输出写 artifact）
3. 运行 `toolContracts.test.ts` 验证注册一致性

### 8.2 添加新资源协议

1. 在 `resources.ts` 的 `resourceHandlers` 添加 URI pattern
2. 实现对应的 handler 返回资源内容

### 8.3 添加新 Artifact 类型

1. 定义 artifact 文件格式（推荐 JSON/JSONL）
2. 使用 `writeRunArtifact()` 写入
3. Tool result 中返回 `hep://runs/{run_id}/artifact/{name}`

---

## 9. 主要增强功能 (v0.3.0)

### 9.1 Token Overflow Prevention

**目标**：防止大文档导致的 MCP/LLM context 超限

#### Staging Workflow
- **工具**：`hep_run_stage_content`
- **用途**：把大 JSON（section candidates / judge decision / outline/paperset/review/revision plan 等）先写入 run artifact，返回 `staging_uri`
- **实现**：`src/vnext/writing/staging.ts`

```typescript
// 用法示例
hep_run_stage_content({
  run_id: "run_xxx",
  content_type: "section_output",
  content: JSON.stringify({ section_number: "1", title: "Introduction", content: "Test content." }),
  artifact_suffix: "section_001_v1"
})
// 返回：{ staging_uri: "hep://runs/run_xxx/artifact/staged_section_output_....json", ... }
```

> 备注：当前没有 server-side 的“分块提交”工具；输入超限必须通过 staging + 拆分任务/缩小输入解决，禁止静默截断继续跑。

#### CJK Word Count
- **函数**：`countMixedTextUnits()`
- **公式**：`total_units = english_words + (cjk_chars / 1.5) + latex_elements`
- **集成**：`verifyWordCount()` 自动使用

---

### 9.2 RAG Enhancement

**目标**：提升检索质量，改善引用准确性

#### LLM Rerank (默认启用)
- **配置**：`DEFAULT_RERANKER_CONFIG` (`src/tools/writing/rag/types.ts`)
- **流程**：BM25 (top-100) → LLM 语义重排序 → 输出 (最多 25 个，受用户请求限制)
- **Fallback**：无；失败即 fail-fast（禁止 BM25 静默回退）
- **成本**：~$0.027/query（对学术写作完全可接受）

```typescript
DEFAULT_RERANKER_CONFIG = {
  mode: 'llm',                  // 默认启用
  llm: {
    enabled: true,
    llm_mode: 'client',         // 使用 client LLM
    rerank_top_k: 100,          // BM25 取 top-100 候选送 LLM (提升自 50)
    output_top_n: 25,           // LLM 输出上限 (提升自 15)
    max_chunk_chars: 500,
  },
}
```

**检索流程**：
```
Query
  ↓
BM25 初筛 (取 top-K)
  ↓
Type Prior 加权（根据 section type）
  ↓
LLM Rerank ✅ (取 top-100 候选，rerank 后输出 ≤25)
  ↓
Sticky Retrieval (+~5 chunks)
  ↓
最终输出 (~min(requested_top_k, 25) + 5 sticky)
```

**硬限制**：
- `rerank_top_k` 可配置上限 300（代码硬编码上限，质量优先原则）
- `output_top_n` 可配置上限 100
- 最终输出数量 = min(用户请求的 top_k, output_top_n) + sticky chunks

#### Word-Count Adaptive Retrieval (v0.3.0+)

**目标**：根据章节字数自动调整检索参数，解决短中长章节需求差异

**问题**：
- Outline 规划是自适应的（short: 3 章节，medium: 6，long: 10）
- 章节 suggested_word_count 可能从 200 字到 4000+ 字不等
- 固定检索参数（25 chunks）对短章节浪费，对长章节不足

**解决方案**：线性缩放检索参数

| 字数  | max_chunks | top_k_per_claim | max_tokens | 场景 |
|-------|------------|-----------------|------------|------|
| 200   | 15         | 3               | 2,000      | Short Introduction |
| 1000  | 25         | 5               | 10,000     | Baseline (medium) |
| 2500  | 62         | 12              | 25,000     | Long Discussion |
| 4000+ | 100        | 15              | 40,000+    | Comprehensive Review |

**缩放公式**：
```typescript
scaleFactor = suggestedWordCount / 1000;  // 基准：1000 字
max_chunks = clamp(25 * scaleFactor, 15, 150);
top_k_per_claim = clamp(5 * scaleFactor, 3, 15);
max_tokens = suggestedWordCount * 10;  // ~10 tokens/word (CJK 兼容)
```

**实现**：
- `scaleRetrievalParams()` (`src/tools/writing/rag/packetBuilder.ts:44-87`)
- `SectionSpec.suggested_word_count` 可选字段
- `buildEvidencePacket()` 自动检测并缩放

**影响**：
- 质量优先：长篇综述获得更多 evidence chunks（100 vs 25）
- 效率提升：短章节减少不必要的检索（15 vs 25）
- 自动化：无需手动调参，由 outlinePlanner 生成的字数驱动

#### Evidence Query Hard Limits Update (v0.3.1)

**问题**：Evidence 查询工具的 hard cap（50）与自适应检索的 max_chunks 上限（150）不一致，违反质量优先原则（长章节的手动/二次查询被过早截断）。

**变更**：
- Project Evidence query：`limit` 上限 `50 → 150`
- Style corpus query：`top_k` 上限 `50 → 150`（保持默认 10 不变）

**实现**：
- `src/vnext/evidence.ts`
- `src/vnext/evidenceSemantic.ts`
- `src/tools/writing/inputSchemas.ts`

#### Bounded Multimodal Evidence Fusion (NEW-SEM-06f, 2026-03-08)

**目标**：在现有 semantic retrieval + structure-aware localization backbone 之上，补一层 **page-native multimodal signal**，专门处理 `page` / `figure` / `table` / `equation` 型 query。

**实现**：
- shared contract：`packages/shared/src/discovery/evidence-multimodal.ts`
- capability/query gate：`packages/hep-mcp/src/core/evidence-multimodal/policy.ts`
- visual candidate fusion：`packages/hep-mcp/src/core/evidence-multimodal/fusion.ts`
- visual label → preferred localization unit bridge：`packages/hep-mcp/src/core/evidence-localization/units.ts`
- artifact integration：`packages/hep-mcp/src/core/evidenceSemantic.ts`

**设计约束**：
- 只在 page-native query 上触发；普通 prose/citation query 继续 text-first，并写出 `multimodal.status = skipped`
- 只对显式 promoted candidates 注入 `preferred_unit`；禁止把所有 `pdf_region` 全局重释为 `figure/table/equation`
- `HEP_ENABLE_MULTIMODAL_RETRIEVAL` 可显式关闭该层；disabled / unsupported / ambiguous 都必须 fail-closed 并可审计
- 不新增 parser/OCR/index/server，也不改写 canonical-paper discovery substrate

**评估面**：
- `packages/hep-mcp/tests/eval/evalSem06fMultimodalScientificRetrieval.test.ts`
- `packages/hep-mcp/tests/eval/fixtures/sem06f_multimodal_scientific_retrieval_eval.json`
- `packages/hep-mcp/tests/eval/fixtures/sem06f_multimodal_scientific_retrieval_holdout.json`
- `packages/hep-mcp/tests/eval/baselines/sem06f_multimodal_scientific_retrieval.baseline.json`

#### Asset Injection Adaptive Scaling (v0.3.1)

**目标**：资产注入（equations/figures/tables）预算随章节字数自适应缩放，与检索缩放保持一致，避免理论重章节公式不够、结果重章节图/表不够。

| 字数 | equations | figures | tables | max_total_asset_block_chars |
|------|-----------|---------|--------|------------------------------|
| 200  | 2         | 1       | 1      | 1,200                        |
| 1000 | 8         | 5       | 3      | 6,000                        |
| 2500 | 20        | 13      | 8      | 15,000                       |
| 4000 | 32        | 20      | 12     | 24,000                       |

**缩放策略**：
```typescript
scaleFactor = clamp(suggestedWordCount / 1000, 0.2, 6);
max_equations = round(8 * scaleFactor);
max_figures = round(5 * scaleFactor);
max_tables = round(3 * scaleFactor);
max_total_asset_block_chars = round(6000 * scaleFactor);
```

**实现**：
- `scaleAssetBudget()` (`src/tools/writing/prompts/assetInjection.ts`)
- 在 prompt 构建与 deep research 写作管线中传递 `suggested_word_count`（由 `word_budget` 派生）

**影响**：
- 长章节允许注入更多资产（例如 4000 字：32 eq / 20 fig / 12 table）
- 默认行为不变：未提供字数时仍使用 8/5/3 与 6000 chars（baseline）

---

### 9.3 Writing Quality Fix

**目标**：减少公式化写作，提升自然度

#### 软约束 (Phase 1)
- **配置**：`SOFT_DEPTH_CONFIGS` (`src/tools/writing/deepWriter/writingPacket.ts`)
- **变更**：`min_paragraphs` → `suggested_paragraphs: { min, max }`
- **验证**：`depthChecker` 改为 advisory 模式（建议而非拒绝）

```typescript
// 从硬约束改为软指导
body: {
  suggested_paragraphs: { min: 3, max: 8 },          // 建议范围
  suggested_sentences_per_paragraph: { min: 2, max: 6 },
  optional_elements: ['definition', 'derivation'],   // 可选而非必须
  suggested_figures: 0,  // 0 = 根据需要
}
```

#### 语言一致性检查 (Phase 2)
- **实现**：`src/tools/writing/verifier/languageChecker.ts`
- **功能**：检测中英混杂，确保全文语言统一

#### LaTeX 修复 (Phase 3)
- **特殊字符转义**：`<` → `\textless{}`, `>` → `\textgreater{}`, `|` → `\textbar{}`
- **引用白名单扩大**：包含所有 evidence catalog 中的论文
- **Asset 标记转换**：`Fig[hash]` → `\ref{fig:label}`

#### Citation Targets Update (v0.3.1)

- **变更**：长文（long）引用目标：`min 50 → 80`，`suggested 80 → 150`
- **目的**：为 8000+ words 的综述提供更符合 RMP 风格的引用数量指导（建议而非硬约束）
- **实现**：`src/vnext/writing/globalChecks.ts` (`checkCitationCount`)

---

### 9.4 LLM-Generated Section Titles (v0.3.1)

**目标**：在 outline 的确定性 fallback 路径中，使用 claims 内容生成更具体的章节标题，避免 “Experimental Results / Theoretical Models and Predictions” 这类刚性分类标题。

**问题**：
- 主题提取过窄时，会退化到按 category 分组
- 旧的 category 标题过于宽泛，造成结构哲学不一致（RAG 自适应，但 outline 标题刚性）

**解决方案（三级回退）**：
1. **LLM（MCP sampling）**：`llm_mode=internal` 且 MCP 客户端支持 sampling（`createMessage`）时，根据该组 claims 生成 2–6 词的具体标题
2. **Heuristic**：从 keywords/claim_text 抽取高频主题短语，拼接软化的类别词（Results/Theory/Methods/Discussion）
3. **Soft default**：最终回退为软化的类别标题（Results/Theory/...），避免 “Experimental Results” 这类硬编码短语

**实现**：
- `src/vnext/writing/outlinePlanner.ts`
  - `generateSectionTitleFromClaims()` / `generateTitleWithLLM()` / `generateTitleHeuristic()`
  - `buildHeuristicPlan()` 改为 async，并接收 `llm_mode` 以决定是否走 LLM 路径

**示例**：
- 输入：关于 Higgs mass 的实验主张
- 输出（heuristic）：`Higgs Mass Measurements`（或 `Higgs Mass Results`）
- 输出（soft default）：`Results`（而不是 `Experimental Results`）

## 10. 版本历史

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-03-23 | M-24：删除 `inspire_research_navigator`，恢复 dedicated discovery/survey/topic/network/connections/trace tool surface；移除 `experts` / `analyze` 公开入口；tool counts updated to `72/100`. | AI Agent |
| 2026-02-12 | Phase 4（4.10）首轮落地：dispatcher 对 run-scoped 结果统一补充 `job` envelope（`job_id=run_id`、`status_uri=hep://runs/{run_id}/manifest`、`polling.strategy=manifest_resource`），以统一 Skill↔MCP 长任务轮询语义；失败语义保持 `INVALID_PARAMS + next_actions`。 | AI Agent |
| 2026-02-12 | Phase 4（4.1/4.9）落地：`inspire_validate_bibliography` 改为 usability-first（manual-only 默认 + 非阻断 warning + 可选 INSPIRE 交叉验证）；新增 opt-in 工具调用遥测（dispatcher 记录 + `hep_health.telemetry` 暴露）。 | AI Agent |
| 2026-02-12 | Phase 4（4.5/4.7/4.8/4.11）落地：Zotero find/search 内部桥接统一读路径；PDG 文档强调版本透明化而非新鲜度裁决；新增 Skill↔MCP 与 Style Corpus 对齐文档；中英文档语言策略同步。 | AI Agent |
| 2026-02-12 | Phase 4（4.6）落地：新增 `hep_project_compare_measurements`（cross-run pairwise tension flagging；flagging-only）与 `src/vnext/hep/compareMeasurements.ts`，统一产出 run artifact URI + summary，并在 RunStep 中记录诊断 artifacts。工具数更新为 `71/83`。 | AI Agent |
| 2026-02-11 | Phase 3 文档/架构对齐：移除 legacy advanced parse 入口的 active 引导；新增独立工具 `inspire_parse_latex`（要求 `run_id`，返回 artifact URI + summary）；`inspire_research_navigator` 扩展到 `discover|field_survey|topic_analysis|network|experts|connections|trace_source|analyze`；工具数量基线保持 `70/82` | AI Agent |
| 2026-02-11 | Phase 2 文档/架构对齐：ToolSpec 元数据补充（`intent`/`maturity`），导航类工具面收敛为 `inspire_research_navigator(mode=discover|field_survey|topic_analysis|network)`，并同步工具数量基线为 `70/82` | AI Agent |
| 2026-01-31 | Milestone 4：新增 `hep_import_paper_bundle`（paper 回灌：`paper_bundle.zip` + `paper_bundle_manifest.json` + 可选 `paper_final.pdf`），并支持 `hep_export_project(include_paper_bundle=true)` 把 `paper/` 统一打进 `research_pack.zip` | AI Agent |
| 2026-01-31 | Milestone 3（部分）：新增 `hep_export_paper_scaffold`（RevTeX `paper/` scaffold + `paper_scaffold.zip`），用于与 research-writer publisher/hygiene 对接 | AI Agent |
| 2026-01-28 | Iceberg Resource Discovery：`resources/list` 仅入口资源；新增 `resources/templates/list`；新增 `hep://runs` index；PDG artifacts 默认 TTL 清理 | AI Agent |
| 2026-01-14 | Milestone 3：Fail-fast 核心违约点清理（LaTeX 解析无回退；semantic query 需 embeddings；export citekey 全覆盖；严格 env 校验） | AI Agent |
| 2026-01-10 | v0.3.1：Quality-First Improvements（evidence limits, asset scaling, citation targets, section titles） | AI Agent |
| 2026-01-10 | v0.3.0：RAG Enhancement (LLM Rerank), Token Overflow Prevention, Writing Quality Fix, Quality-First 原则 | AI Agent |
| 2026-01-09 | 初始版本：核心架构、数据流、Token 管理 | AI Agent |

---

## 11. 相关文档

- `CLAUDE.md`：开发约束与代码入口
- `AGENTS.md`：Codex/Agent 协作指南
- `docs/TOOL_CATEGORIES.md`：工具分类
- `docs/WRITING_RECIPE_CLIENT_PATH.md`：Client Path 写作流程
- `docs/WRITING_RECIPE_DRAFT_PATH.md`：Draft Path 写作流程
