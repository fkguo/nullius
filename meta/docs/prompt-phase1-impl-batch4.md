# Batch 4A — MCP Tool Result Handling Reform (H-13 扩展)

## 前置状态

- Phase 0: ALL DONE
- Phase 1 Batch 1: NEW-01 ✅, H-11a ✅, H-16a ✅
- Phase 1 Batch 2: H-15a ✅, H-18 ✅, H-03 ✅, H-04 ✅, H-11a P2 ✅
- Phase 1 Batch 3: H-01 ✅, H-02 ✅, H-19 ✅, NEW-CONN-01 ✅
- REDESIGN_PLAN: v1.8.0-draft (commit a312289)
- Phase 1 完成: 13/22 (不含 cut/deferred)

## 背景：为什么 H-13 需要扩展

原始 H-13 方案（~50 LOC naive 截断）不够。对现有 MCP server 的审计发现 **6 类系统性问题**：

### 审计发现摘要

| ID | 问题 | 严重度 | 涉及 |
|----|------|--------|------|
| **X-01** | `formatToolResult` 零大小检查 — handler 返回 500KB 也原封不动塞进 context | Critical | `dispatcher.ts:371-373` |
| **X-02** | `JSON.stringify(result, null, 2)` 缩进浪费 ~30% token | High | `dispatcher.ts:373`, `formatters.ts:218` |
| **D-02** | 只有 `inspire_search` 有 markdown 格式，其余 paper list 工具全走 raw JSON | High | `dispatcher.ts:341-369` |
| **R-01~R-04** | 发现类工具返回完整 `PaperSummary` (含 `pdf_url`, `source_url`, `publication_type[]`, `document_type[]`, `arxiv_categories[]` 等)，LLM 决策不需要大部分字段 | High | `registry.ts` 多个 handler |
| **R-10/R-11** | `deep_research.analyze/synthesize` inline 返回全部内容 (80-150KB)，但同工具的 `write` 模式正确走 artifact | Critical | `registry.ts:2848-2859` |
| **X-04** | 从未发射 MCP `resource_link` 内容块，尽管 `hep://` 基础设施完备 | Medium | `dispatcher.ts` |

### Token 预算参考

| 指标 | 值 |
|------|---|
| Claude context window | 200K tokens |
| 单个 tool result 目标上限 | **~10K tokens (~40KB)** |
| 单个 tool result 硬上限 | **~20K tokens (~80KB)** |
| `inspire_search(size=50)` 当前实际 | 40-80KB (10-20K tokens) ❌ |
| `get_references` (review paper) 当前实际 | 100-500KB (25-125K tokens) ❌❌ |
| `deep_research.analyze` (5 papers) 当前实际 | 80-150KB (20-37K tokens) ❌❌ |

来源: Anthropic Context Engineering Guide (2025-09), MCP Spec 2025-06-18, JetBrains NeurIPS 2025。

## 本批目标

将 H-13 从 "naive 截断" 升级为 **系统性 Result Handling Reform**，分 5 层实施:

```
L0: 紧凑序列化         — 去掉 JSON 缩进，扩展 markdown 覆盖面
L1: 字段裁剪            — Compact PaperSummary，精简发现类工具输出
L2: Evidence-first 对齐 — analyze/synthesize → artifact + 摘要
L3: Dispatcher 安全网   — 全局 size guard (40KB soft / 80KB hard)
L4: resource_link 输出  — 凡返回 hep:// URI 的工具附加 MCP resource_link
```

### L0: 紧凑序列化 (~30 LOC)

**`dispatcher.ts`**:
- `formatToolResult` 中 `JSON.stringify(result, null, 2)` → `JSON.stringify(result)` (去掉缩进)
- `formatToolError` 保留缩进 (error payload 很小，可读性优先)

**`formatters.ts`**:
- `formatOutput()` 中 `JSON.stringify(data, null, 2)` → `JSON.stringify(data)`

**扩展 markdown formatter 覆盖面**:
- `formatToolResult` 新增对以下工具的 `format=markdown` 分支:
  - `inspire_search_next` — 复用 `formatSearchResultMarkdown`
  - `inspire_literature` (mode=get_references / get_citations) — 复用 `formatPaperListMarkdown`
  - `inspire_research_navigator` (mode=discover / field_survey) — 复用 `formatPaperListMarkdown`
- **不做**: 不为非 paper-list 工具写新 formatter。不改变默认 `format` 值。

### L1: 字段裁剪 — Compact PaperSummary (~100 LOC)

在 `packages/shared/src/types/paper.ts` 或 `packages/hep-mcp/src/utils/` 新增 `compactPaperSummary` 投影函数:

```typescript
/** 从完整 PaperSummary 中提取 LLM 决策所需的紧凑字段 */
function compactPaperSummary(p: PaperSummary): CompactPaperSummary {
  return {
    recid: p.recid,
    arxiv_id: p.arxiv_id,
    title: p.title,
    authors: p.authors?.slice(0, 3),
    author_count: p.author_count ?? p.authors?.length,
    collaborations: p.collaborations,              // CMS, ATLAS 等
    year: p.year,
    citation_count: p.citation_count,
    texkey: p.texkey,
    arxiv_primary_category: p.arxiv_primary_category, // hep-ph, hep-th 等
    publication_summary: p.publication_summary,     // "PRL 130 (2023) 071801 [arXiv:2301.12345]"
  };
}
```

**保留字段及理由**:
- `recid` — 唯一 ID，后续 drill-down 必需
- `arxiv_id` — 编码时间 (YYMM)；旧格式 (hep-ph/0601001) 含领域，新格式 (2401.12345) 不含
- `title` — 核心
- `authors` (前 3) — 理论文章识别研究组；实验文章配合 `collaborations`
- `author_count` — 区分大合作组 vs 个人
- `collaborations` — CMS/ATLAS/Belle II 等，一个字段替代几百个 author name
- `year` — 时序判断
- `citation_count` — 影响力
- `texkey` — 直接用于 citation
- `arxiv_primary_category` — 新格式 arXiv ID 不含分类前缀，需要此字段判断领域 (hep-ph/hep-th/hep-lat/hep-ex)
- `publication_summary` — 已格式化的期刊信息，如 "Rev.Mod.Phys. 90 (2018) 015004 [arXiv:1705.00141]"，一个字符串包含 journal + volume + arXiv ID

**裁剪字段**:
- `pdf_url`, `source_url` — LLM 不下载文件，需要时从 recid 推导
- `inspire_url`, `arxiv_url`, `doi_url` — 同上，URL 从 ID 可构造
- `publication_type[]`, `document_type[]` — 冗长数组，`publication_summary` 已覆盖
- `arxiv_categories[]` — 完整分类列表 (含 cross-list)，`arxiv_primary_category` 足够决策
- `earliest_date` — `year` 已覆盖
- `citation_count_without_self_citations` — 非决策必需

**每条 paper 从 ~600 bytes → ~220 bytes，裁剪率 ~63%**。

**应用位置** — 在 `formatToolResult` 或各 handler 中:
- `inspire_search` / `inspire_search_next` — 对 `result.papers` 应用 compact
- `inspire_literature` (get_references / get_citations) — 对返回的 paper 列表应用 compact
- `inspire_research_navigator` (discover / field_survey / network / analyze) — 对返回的 paper 列表应用 compact
- `hep_import_from_zotero` — 若返回 paper 列表，应用 compact

**不做**: 不修改 `PaperSummarySchema` 本身。不影响 `inspire_literature(mode=get_paper)` (单篇完整数据合理)。不影响 `hep_inspire_search_export` (已走 artifact)。

### L2: Evidence-first 对齐 (~150 LOC)

将 `deep_research.analyze` 和 `deep_research.synthesize` 改为与 `deep_research.write` 一致的 artifact 模式:

**`inspire_deep_research` handler** (`registry.ts`):

当 `mode=analyze`:
- 完整分析结果写入 artifact: `writeRunJsonArtifact(runId, 'deep_analyze_result.json', result)`
- 返回给 LLM: `{ artifact_uri, summary: { paper_count, equations_found, key_findings: [...top 3...] } }`
- **`run_id` 为必需参数** (analyze 模式) — 如果不提供 run_id，发出 next_actions 提示先创建 run

当 `mode=synthesize`:
- 完整综述写入 artifact: `writeRunJsonArtifact(runId, 'deep_synthesize_result.json', result)`
- 返回给 LLM: `{ artifact_uri, summary: { theme_count, paper_count, open_questions: [...] } }`

**`inspire_critical_research` handler** (`registry.ts`):

当 `mode=evidence` 或 `mode=analysis`:
- 同样写入 artifact + 返回 URI + 摘要

**关键参考**: 查看现有 `mode=write` 和 `mode=theoretical` 如何写入 artifact 并返回 URI。对齐相同模式。

**不做**: 不改 `mode=write` (已正确)。不改 `inspire_parse_latex` (已正确)。

### L3: Dispatcher 安全网 (~120 LOC)

在 `formatToolResult` 末尾添加全局 size guard:

```typescript
const MAX_INLINE_BYTES = 40_000;   // ~10K tokens, 正常上限
const HARD_CAP_BYTES = 80_000;     // ~20K tokens, 绝对上限

function formatToolResult(name, result, args) {
  // ... 现有 string / markdown 路径 ...

  const json = JSON.stringify(result);  // L0: 无缩进
  const size = Buffer.byteLength(json, 'utf-8');

  // 快速路径: 小结果直接返回
  if (size <= MAX_INLINE_BYTES) {
    return { content: [{ type: 'text', text: json }] };
  }

  // 超标: 写入 artifact + 返回 URI + 摘要
  const runId = extractRunIdFromResult(result, args);
  const artifactName = `${name}_result_${Date.now()}.json`;

  if (runId) {
    const ref = writeRunJsonArtifact(runId, artifactName, result);
    const summary = autoSummarize(result, name);
    return {
      content: [
        { type: 'text', text: JSON.stringify({
          _result_too_large: true,
          size_bytes: size,
          artifact_uri: ref.uri,
          artifact_name: artifactName,
          summary,
        }) },
        { type: 'resource_link', uri: ref.uri, name: artifactName,
          mimeType: 'application/json' },  // L4
      ],
    };
  }

  // 无 run context: 硬截断 (safety net)
  if (size > HARD_CAP_BYTES) {
    const truncated = json.slice(0, HARD_CAP_BYTES);
    return {
      content: [{ type: 'text', text: truncated + '\n... [TRUNCATED, original: ' + size + ' bytes]' }],
    };
  }

  return { content: [{ type: 'text', text: json }] };
}
```

**`autoSummarize(result, toolName)`**: 通用 summarizer
- 检测常见结构: `{ papers: [...] }`, `{ results: [...] }`, `{ hits: [...] }`, 纯数组
- 提取 `total` + 前 N 项 (compact)
- 返回 `{ total_items, shown_items, highlights: [...], statistics?: {...} }`
- 各工具可注册自定义 summarizer (可选)

**阈值常量** 定义在 `packages/shared/src/constants.ts`:
```typescript
export const MAX_INLINE_RESULT_BYTES = 40_000;
export const HARD_CAP_RESULT_BYTES = 80_000;
```

### L4: `resource_link` 输出 (~50 LOC)

当 tool result 包含 `hep://` URI (检测 `artifact_uri` 或以 `hep://` 开头的字段值) 时，在 MCP response 的 `content` 数组中追加 `resource_link` 内容块:

```typescript
{ type: 'resource_link', uri: 'hep://runs/abc/artifact/x.json', name: 'x.json', mimeType: 'application/json' }
```

这让 MCP-aware client (如 Claude Desktop) 可以直接 lazy-load 资源，不需要额外 tool call。

**应用位置**: `formatToolResult` 统一处理 (扫描 result 中的 `hep://` URI)。

**不做**: 不为每个 handler 手动添加 `resource_link`。

## 实施顺序

```
1. L0: 紧凑序列化 (dispatcher.ts + formatters.ts)
   ↓ build + test (确认无回归)
2. L1: compactPaperSummary + 应用到各 handler
   ↓ build + test
3. L2: deep_research + critical_research artifact 化
   ↓ build + test
4. L3: Dispatcher 安全网 (constants.ts + dispatcher.ts autoSummarize)
   ↓ build + test
5. L4: resource_link 输出
   ↓ build + test (全量)
```

每层独立可验证，逐步缩小结果体积。

## 测试策略

新增测试文件: `packages/hep-mcp/tests/resultEnvelope.test.ts`

| 测试场景 | 预期 |
|----------|------|
| 小结果 (<40KB) | 直接返回，无 envelope |
| 中等结果 (40-80KB, 有 run_id) | artifact + URI + summary |
| 大结果 (>80KB, 无 run_id) | 硬截断 + size 提示 |
| `compactPaperSummary` | 保留 recid/arxiv_id/title/authors(3)/year/citations/texkey/publication_summary，裁剪其余 |
| `inspire_search_next` markdown 格式 | 正确使用 `formatSearchResultMarkdown` |
| `deep_research.analyze` | 结果写入 artifact，返回 URI + summary |
| `resource_link` 生成 | `hep://` URI 在 result 中 → content 含 resource_link 块 |
| 现有 945 tests | 零回归 |

## 执行约束

1. 先读 Serena 记忆 `architecture-decisions` + `codebase-gotchas` 获取上下文
2. 按 L0 → L1 → L2 → L3 → L4 顺序实施
3. 每层完成后 `pnpm -r build && pnpm -r test` 确认零回归
4. 全部完成后执行双模型收敛检查:
   - **Codex**: `gpt-5.3-codex` xhigh（代码实现审核）
   - **Gemini**: `gemini-3.1-pro-preview`
   - 使用 `review-swarm` skill
5. 收敛后提交 (单次 commit)
6. 更新 `meta/REDESIGN_PLAN.md` 和 `meta/remediation_tracker_v1.json`

## 不做 (边界)

- 不修改 `PaperSummarySchema` / `PaperSchema` Zod 定义 — compact 是投影，不是 schema 变更
- 不做 LLM-based summarization (确定性提取足够)
- 不做 GraphQL-style `fields` 参数 (over-engineering)
- 不做客户端 context clearing (那是 Anthropic API 层的事，与 MCP server 无关)
- 不改已正确走 artifact 的工具 (`mode=write`, `parse_latex`, `search_export`, `render_latex` 等)
- 不改 `get_paper` (单篇完整数据合理，~2-5KB)

---

# Batch 4B — Phase 1 收尾 + Phase 2A 启动

## 前置状态

- Batch 4A: H-13 (MCP Result Handling Reform) ✅
- Phase 1 完成: 14/22

## 本批目标

完成 Phase 1 高价值残余项 + 启动 Phase 2A 运行时可靠性双核。

关键路径: **M-14a + NEW-R02 + UX-06** (独立并行) → **NEW-RT-02 + NEW-RT-03** (独立但概念成对)

### 1. M-14a: 日志脱敏层 (~80 LOC)

参考 `meta/REDESIGN_PLAN.md` M-14a 节。

**TS 侧**:
- `packages/shared/src/redaction.ts`: `redact(text: string): string`
  - 正则替换: API key (`sk-...`, `key-...`), Bearer token, 用户路径 (`/Users/<name>/`, `/home/<name>/`)
  - 纯函数，无副作用

**Python 侧** (临时 stopgap):
- `packages/hep-autoresearch/src/hep_autoresearch/toolkit/redaction.py`: Python 镜像
- `logging_config.py`: 日志输出经过 `redact()` 层

**不做**: 不集成到 dispatcher (Phase 2 trace-jsonl 时集成)。不做 config-driven 模式列表 (硬编码正则足够)。

### 2. NEW-R02: TS `as any` CI 门禁 (~30 LOC)

参考 `meta/REDESIGN_PLAN.md` NEW-R02 节。依赖 NEW-R02a ✅。

基于已有的 `meta/scripts/check_loc.py` CODE-01.4 实现，新增 diff-scoped 检查:
- `meta/scripts/check_as_any.sh` (或扩展现有 CI 脚本): `git diff --cached` / `git diff origin/main...HEAD` 中新增的 `as any` / `.catch(() => {})` → 非零退出
- 存量 254 个 `as any` **不触发** (diff-scoped)
- 集成到 `Makefile` 作为 `lint` 子目标

**不做**: 不清理存量 `as any` (Phase 2 H-16b)。不做 eslint rule (grep 足够)。

### 3. UX-06: 研究会话入口协议 (纯文档)

参考 `meta/REDESIGN_PLAN.md` UX-06 节。

- `meta/protocols/session_protocol_v1.md`: Agent 行为规范文档
  - 阶段枚举: 选题(idea) → 文献(literature) → 推导+计算(derivation) → 写作(writing) → 审稿修订(revision)
  - 每阶段: 推荐工具列表、前置条件检查、典型交互模板
  - 用户意图识别: "我想研究 X" → 进入选题阶段并给出指引
- `skills/hepar/SKILL.md`: 引用 session_protocol

**不做**: 不写代码。不修改 dispatcher。这是给 Agent 的行为规范，由 SKILL.md / CLAUDE.md 引用即可。

### 4. NEW-RT-02: MCP StdioClient Reconnect (~100 LOC) — Phase 2A

参考 `meta/REDESIGN_PLAN.md` NEW-RT-02 节。依赖 H-19 ✅。

**Scope Audit 优先级 #1 (欠工程化 Gap #1)**。

在 `packages/orchestrator/src/` 新增 `mcp-client.ts`:
- 检测 MCP stdio 子进程断连 (exit / crash / EPIPE / timeout)
- 使用 `retryWithBackoff` (H-19) 控制重启节奏
- 自动重启子进程 + reinitialize MCP session
- 重启后 pending 请求重试 (或返回 UPSTREAM_ERROR 让上层决定)
- 配置: `maxReconnects` (default 3), `reconnectPolicy: RetryPolicy`

**关键文件**:
- `packages/orchestrator/src/mcp-client.ts`: 新增
- 依赖: `packages/shared/src/retry-policy.ts`, `packages/orchestrator/src/retry.ts`
- 参考 Python 侧: `packages/hep-autoresearch/.../mcp_stdio_client.py`

**不做**: 不实现完整的 session state 恢复 (如 subscriptions)。不引入外部 MCP client library。保持 stdio transport only。

### 5. NEW-RT-03: OTel-aligned Span Tracing (~150 LOC) — Phase 2A

参考 `meta/REDESIGN_PLAN.md` NEW-RT-03 节。依赖 H-02 ✅。

**Scope Audit 优先级 #3 (欠工程化 Gap #3)**。

手写轻量 Span 接口 (参考 OTel 语义约定，不安装 SDK):

**shared**:
- `packages/shared/src/span.ts`: `Span` interface + `SpanStatus` enum
  ```typescript
  interface Span {
    trace_id: string;
    span_id: string;
    parent_span_id?: string;
    name: string;
    start_time: string;   // ISO 8601
    end_time?: string;
    duration_ms?: number;
    status: 'OK' | 'ERROR' | 'UNSET';
    attributes?: Record<string, string | number | boolean>;
  }
  ```

**orchestrator**:
- `packages/orchestrator/src/tracing.ts`: `SpanCollector` class
  - `startSpan(name, traceId?, parentSpanId?)` → returns `ActiveSpan`
  - `ActiveSpan.end(status)` → 计算 duration，写入 JSONL
  - JSONL writer: append-only 写入 `<run_dir>/spans.jsonl`

**hep-mcp dispatcher 集成**:
- `packages/hep-mcp/src/tools/dispatcher.ts`: `handleToolCall()` 中
  - 用现有 `extractTraceId()` 获取 trace_id
  - 创建 span → 执行 handler → end span
  - 错误时 span.status = 'ERROR'

**不做**: 不安装 `@opentelemetry/api` 或完整 OTel SDK。不做 span export 到外部后端。不做 sampling。

## 执行约束

1. 先读 Serena 记忆 `architecture-decisions` + `codebase-gotchas` 获取上下文
2. 按此顺序: M-14a → NEW-R02 → UX-06 → NEW-RT-02 → NEW-RT-03
3. 每项完成后跑对应测试；全部完成后 `pnpm -r build && pnpm -r test` 确认零回归
4. 双模型收敛检查 (Codex gpt-5.3-codex + Gemini 3.1-pro)
5. 收敛后提交 (单次 commit 包含全部 5 项)
6. 更新 tracker

## Batch 4 完成后 Phase 1 残余

| ID | 状态 | 说明 |
|----|------|------|
| M-01 | pending | Artifact 命名规范 (low, Batch 5 候选) |
| M-18 | pending | 配置管理统一 (low, Batch 5 候选) |
| M-19 | **BLOCKED** | 依赖 H-17 (Phase 2) |
| NEW-R03b | **deferred** | Python 退役路径，Scope Audit 建议 defer |
| NEW-R04 | pending | Zotero 去重 (~2300 LOC, Batch 5 候选) |
| UX-01 | pending | 笔记/Contract 分离 (Batch 5 候选) |
| UX-05 | BLOCKED on UX-01 | 随 UX-01 |

## Batch 5 预览 (Phase 1 扫尾 + Phase 2B 启动)

- M-01 + M-18 (Phase 1 低成本完结项)
- NEW-R04 (Zotero 去重，纯 wins)
- UX-01 + UX-05 (UX 配对项)
- NEW-CONN-02 (Review feedback next_actions, Phase 2B ~60 LOC)
- NEW-IDEA-01 (idea-core MCP 桥接, Phase 2B ~400-800 LOC, 关键 Pipeline 连通项)
