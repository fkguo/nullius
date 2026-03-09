# Pipeline Connectivity Audit — 双模型 R4 收敛

> 审计日期: 2026-02-25
> 审核模型: Codex (gpt-5.2, xhigh) + Gemini (gemini-3.1-pro-preview)
> 收敛轮次: R4 (R1: 4 blocking → R2: 4 blocking → R3: 2 blocking → R4: 1 trivial → CONVERGED)

## 审计范围

从 **文献调研** → **idea 生成** → **计算** → **交叉检验** → **写论文** → **评审** → **修改** → **自主研究** 的完整研究流程，检查是否存在孤岛和缺失连接。

## 发现: 5 个孤岛

### Island 1: idea-core (Python)
- 纯 Python 包，无 MCP 工具暴露
- `campaign.generate_batch()` / `search.step()` / `eval.run()` 无法被 TS 编排器调用
- 连接方案: NEW-IDEA-01 (MCP 桥接) + NEW-05a Stage 3 (TS 重写)

### Island 2: computation + hep-calc (CLI-only)
- CLI skill 模式 (SKILL.md + shell entry)，不参与 MCP 工具链
- 计算结果 (headline_numbers.json, acceptance_check.json) 无法注入 writing evidence pipeline
- 连接方案: NEW-COMP-01 (设计) + NEW-CONN-03 (evidence 翻译层)

### Island 3: Literature Discovery (无 next_actions)
- `inspire_search`, `inspire_research_navigator` 返回结果但不建议下一步
- 用户必须手动决定 "搜索完了做什么"
- 连接方案: NEW-CONN-01 (hint-only next_actions)

### Island 4: Cross-validation (LaTeX-only 输入)
- `hep_run_build_measurements` 和 `hep_project_compare_measurements` 只消费 LaTeX evidence
- 计算结果的数值无法参与交叉检验
- 连接方案: NEW-CONN-05 (Phase 3, deferred)

### Island 5: TS Orchestrator (无 pipeline DAG)
- `packages/orchestrator/` 是 scaffold，缺少声明式工作流定义
- 无法驱动多阶段自主研究
- 连接方案: NEW-WF-01 (workflow schema) + NEW-RT-01 (AgentRunner)

## 关键 Schema 发现

`EvidenceCatalogItemV1` (packages/hep-mcp/src/vnext/evidence.ts) 是 **LaTeX 特有的**:

```typescript
export interface EvidenceCatalogItemV1 {
  version: 1;
  evidence_id: string;
  project_id: string;
  paper_id: string;        // Required — 计算结果无 paper_id
  type: EvidenceType;
  locator: LatexLocatorV1;  // Required — 计算结果无 LaTeX 定位器
  text: string;
  normalized_text?: string;
  citations?: string[];
  meta?: Record<string, unknown>;
}
```

**R3 → R4 演化**: 最初提议扩展此 schema 添加 `source_type` 字段。Codex R3 正确指出 `locator: LatexLocatorV1` 是 required 字段，synthetic locator 会破坏验证器或 locator 消费者。R4 改为并行 schema。

## 收敛方案: ComputationEvidenceCatalogItemV1

```typescript
interface ComputationEvidenceCatalogItemV1 {
  version: 1;
  evidence_id: string;           // e.g., "compute:run_tag:headline_001"
  source_id: string;             // namespaced: "compute:<run_id>:<skill_tag>"
  source_type: "computation";
  type: "measurement" | "acceptance_check" | "computation_summary";
  locator: ComputationLocatorV1; // { artifact_uri, json_pointer, artifact_sha256 }
  text: string;                  // human-readable text representation
  normalized_text?: string;
  value?: number;                // numeric value (for measurements)
  uncertainty?: { plus: number; minus: number };
  unit?: string;
  meta?: Record<string, unknown>;
}
```

- JSON Schema SSOT: `meta/schemas/computation_evidence_catalog_item_v1.schema.json`
- Codegen: TS + Python types via NEW-01 pipeline (`make codegen`)
- 文件名: `computation_evidence_catalog_v1.jsonl` (Codex R4 命名修正)
- BM25 index builder 合并两类 evidence (~30 LOC)
- LaTeX-only 消费者按 `paper_id` 过滤，自然跳过计算 evidence

## 收敛方案: NEW-CONN 项目

### NEW-CONN-01 (Phase 1, ~100 LOC)
**Discovery next_actions hints**

向 `inspire_search`, `inspire_research_navigator`, `inspire_deep_research` (mode=analyze→synthesize→write 链), `hep_import_from_zotero` 返回 JSON 添加 hint-only `next_actions`。确定性规则 (papers.length > 0 + cap 10 recids)。遵循现有 `{ tool, args, reason }` 惯例。不自动执行。

依赖: H-16a (已完成)

### NEW-CONN-02 (Phase 2, ~60 LOC)
**Review feedback next_actions**

`submitReview` 在 `follow_up_evidence_queries.length > 0` 时添加 `next_actions` (建议 `inspire_search` + `hep_run_build_writing_evidence`, max 5 queries, max 200 chars each)；在 `recommended_resume_from` 存在时建议具体 writing 工具。Hint-only。

依赖: 无

### NEW-CONN-03 (Phase 2, ~250 LOC)
**Computation evidence ingestion**

1. 定义 `ComputationEvidenceCatalogItemV1` JSON Schema (SSOT in `meta/schemas/`, codegen via NEW-01)
2. 实现 `hep_run_ingest_skill_artifacts` MCP 工具 (per NEW-COMP-01 spec): 读取 skill SSOT artifacts via ArtifactRef URI, 写入 `computation_evidence_catalog_v1.jsonl`
3. 扩展 `buildRunEvidenceIndexV1` 合并计算 evidence 到 BM25 index (~30 LOC)

依赖: NEW-COMP-01, NEW-01

### NEW-CONN-04 (Phase 2B, ~150 LOC)
**Idea → Run creation**

`hep_run_create_from_idea` 接收 IdeaHandoffC2 URI, 创建 project + run, stage thesis/claims 为 outline seed, 返回 hint-only `next_actions`。纯 staging，无网络调用。

依赖: NEW-IDEA-01

### NEW-CONN-05 (Phase 3, deferred, ~100 LOC)
**Cross-validation → Pipeline feedback**

`hep_run_build_measurements` 和 `hep_project_compare_measurements` 在发现 tension 时返回 `next_actions` 到 review/revision。扩展 measurements 消费计算 evidence。

依赖: NEW-CONN-03

## 现有项修改

| Item ID | 修改 |
|---------|------|
| NEW-WF-01 | 扩展: 定义 entry point variants (from_literature, from_idea, from_computation, from_existing_paper) |
| UX-02 | 追加: computation contract 指定 evidence format spec |
| NEW-COMP-01 | 追加: 包含 `hep_run_ingest_skill_artifacts` 工具规格 (single SSOT) |

## 依赖图

```
H-16a ✅ → NEW-CONN-01 (Phase 1)
NEW-CONN-02 (Phase 2, 独立)
NEW-COMP-01 + NEW-01 → NEW-CONN-03 (Phase 2)
NEW-IDEA-01 → NEW-CONN-04 (Phase 2B)
NEW-CONN-03 → NEW-CONN-05 (Phase 3, deferred)
NEW-WF-01 references: CONN-01, 02, 03 (CONN-04 就绪后追加)
```

## Entry Points (连通后)

| 起点 | 流程 | 连接器 |
|------|------|--------|
| 文献列表 | `inspire_deep_research(mode=write)` → 全流程 | 已有 |
| 关键词搜索 | `inspire_search` → hint → `inspire_deep_research` | NEW-CONN-01 |
| 分析链 | analyze → hint → synthesize → hint → write | NEW-CONN-01 |
| 研究 idea | `hep_run_create_from_idea` → hints → discovery + computation | NEW-CONN-04 |
| 计算结果 | `hep_run_ingest_skill_artifacts` → EvidenceCatalog → writing | NEW-CONN-03 |
| 评审反馈 | `submitReview` → hints → `inspire_search` + `build_evidence` | NEW-CONN-02 |
| 现有论文 | `paper-reviser` / `submitReview` → refinement | 已有 |
| Zotero 集合 | `hep_import_from_zotero` → hint → `inspire_deep_research` | NEW-CONN-01 |
| 自主循环 | workflow schema → orchestrator | NEW-WF-01 + NEW-RT-01 |

## Pipeline A/B 统一时间线

1. **Phase 2**: NEW-IDEA-01 + NEW-COMP-01 → Pipeline A 能力暴露为 MCP
2. **Phase 2-2B**: NEW-CONN-01~04 → 所有阶段通过 hint-only next_actions 连通
3. **Phase 3**: NEW-COMP-02 (完整 Computation MCP), NEW-CONN-05 (交叉检验)
4. **Phase 4**: Pipeline A (hepar CLI) 退役

## next_actions 语义

`next_actions` 是 **hint-only** 建议:
- 221+ 次使用, 33 个文件
- 从不自动执行
- 遵循现有 `{ tool, args, reason }` 惯例
- 客户端 LLM 或人类决定是否跟随

## Codex R4 非阻塞建议 (记录备查)

1. 下游消费者必须显式将计算 evidence 视为独立 source type（不依赖 "无 paper_id" 作为唯一判断）
2. 确认 schema 路径一致性 (`meta/schemas/` vs `autoresearch-meta/schemas/`)
3. 明确 `ComputationLocatorV1.json_pointer` 语义（对非 JSON artifact 考虑 optional 或替代选择器）
4. 考虑计算 evidence 的 playback 审计 UX hook
5. BM25 检索中考虑计算 vs LaTeX evidence 的权重/过滤
