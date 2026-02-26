# Prompt: EVO-20 研究记忆扩展设计

> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`
> 涉及文件均在 `meta/` 子目录下（原 autoresearch-meta，已迁入 monorepo）。
> 完成后需经 Codex (gpt-5.3-codex, xhigh) + Gemini (默认模型) 双模型审核迭代收敛。

---

## 背景

EVO-20 (Cross-Cycle Memory Graph) 已完成设计 (design_complete)，schema 在
`meta/schemas/memory_graph_{node,edge,event}_v1.schema.json`。

当前节点类型全部是**代码进化**概念（signal/gene/capsule/outcome/skill/module/test/approval_pattern），
**没有覆盖研究记忆**——即 agent 在进行物理研究时积累的跨 run 知识。

缺少研究记忆导致：
- research-team workstream 每次 run 从零开始，不知道哪个模型擅长什么
- idea-core 评分标准不会随实际研究成败校准
- hepar 不记得哪些计算方法对哪类问题有效/无效
- 被否定的研究方向会被反复尝试

## 第零步: 检查 idea-core outcomes 是否已记录

在开始变更前，检查以下位置是否已有 idea-core outcomes 相关记录：

1. `meta/REDESIGN_PLAN.md` — 搜索 "idea_outcome" / "idea outcome" / "评分校准"
2. `meta/remediation_tracker_v1.json` — 检查是否有相关条目
3. `meta/schemas/` — 检查是否已存在 `idea_outcome` 相关 schema
4. `meta/docs/` — 检查是否有 idea-core outcomes 设计文档
5. `meta/DESIGN_DEBT.md`（如存在）— 检查是否列为设计债务

如果以上均未找到记录，则 idea-core outcomes 仅在对话中讨论过但未落地。
本 prompt 的变更 1 中 `idea_outcome_payload_v1.schema.json` 将首次正式记录此设计。

关于 idea-core outcomes 的设计意图（来自前序对话）：
- **目的**: idea-core 的评估标准应基于实际研究成败自动校准
- **数据链路**: idea 提出 → idea-core 评分 → hepar 编排 run → 研究结果 → outcome 写回
- **校准机制**: 追踪 "高分 idea 的实际成功率" vs "低分 idea 的实际成功率"，发现哪些评分标准有预测力
- **消费者**: idea-core 评估时读取历史 outcome，调整评分权重
- **写入时机**: run 完成 + 审批通过后，由 hepar 或 idea-core 写入

如果已有部分记录（包括设计债务 DESIGN_DEBT.md 或 serena memory 中），评估是否与上述设计意图一致：
- **一致**: 在变更中引用已有记录，确保对齐
- **冲突**: 在变更中说明并解决
- **仅列为设计债务/未来项**: 本次 EVO-20 扩展将其正式纳入 schema 设计，标注来源

## 需要完成的 7 项变更

### 变更 1: 4 个研究节点类型 Payload Schema

在 `meta/schemas/` 下新建 4 个文件：

| 文件 | 节点类型 | 写入者 | 内容 |
|------|---------|--------|------|
| `research_failure_payload_v1.schema.json` | `research_failure` | hepar (审批后) | 被否定的研究方向、失败原因、排除依据 |
| `computation_strategy_payload_v1.schema.json` | `computation_strategy` | hepar (审批后) | 有效/无效的计算方法、适用问题类型、可靠性评估 |
| `idea_outcome_payload_v1.schema.json` | `idea_outcome` | idea-core | idea 评估分 vs 实际研究结果，用于评分校准 |
| `workstream_profile_payload_v1.schema.json` | `workstream_profile` | research-team (审批后) | 模型在不同任务类型的表现数据、收敛轮次 |

每个 schema 必须包含 `payload_schema_id` 字段（EVO-20 NodeTypeRegistry 对非内置类型的要求）。

设计 payload 字段时参考：
- 现有 `OutcomeNodePayload`（success/quality_score 模式）
- `meta/schemas/strategy_state_v1.schema.json`（数值参数模式）
- CLAUDE.md 中定义的 4 个记忆类别和写入格式

### 变更 2: memory_graph_node_v1 增加 status 字段

研究记忆必须经审批才能生效。在 `meta/schemas/memory_graph_node_v1.schema.json` 中增加：

```json
"status": {
  "type": "string",
  "enum": ["pending", "committed", "rejected"],
  "default": "committed",
  "description": "Node lifecycle status. Research memory nodes start as 'pending' (run artifact), become 'committed' after approval gate, or 'rejected' if run is denied. Code evolution nodes default to 'committed'. Queries default to committed-only."
}
```

注意向后兼容：现有代码进化节点类型 default 为 "committed"，不影响现有消费者。

### 变更 3: memory_graph_node_v1 增加 project_id 字段

研究记忆需要项目维度。增加：

```json
"project_id": {
  "type": ["string", "null"],
  "default": null,
  "description": "Research project scope. null = global (cross-project knowledge). Non-null = project-specific experience. Code evolution nodes typically use null."
}
```

查询约定：先查 project_id 匹配的节点，再查 null（全局），合并结果。

### 变更 4: memory_graph_node_v1 注册新节点类型

在 `allOf` 数组中增加 4 个 if/then 条目，将新节点类型与对应 payload schema 关联。
同时更新 `NodeType` 的 examples 和 description。

### 变更 5: REDESIGN_PLAN.md §EVO-20 scope expansion

在 `meta/REDESIGN_PLAN.md` 的 EVO-20 条目描述中增加 scope expansion 段落，说明：
- 研究记忆扩展的动机（agent graduation: 持久状态 + 策略适应）
- 4 个新节点类型及其消费者
- 节点生命周期（pending → committed/rejected）
- 项目作用域（全局 + 项目级两层）
- Auto-recall 机制（run 启动时自动语义召回相关历史）
- 关键节点 memory flush（不等 run 结束，关键节点自动提取候选记忆）
- 反馈闭环：idea-core → hepar → research-team → outcome → idea-core

### 变更 6: remediation_tracker_v1.json 更新

- `meta/remediation_tracker_v1.json` 中 EVO-20 的 note 追加 scope expansion 描述
- plan_version 递增 minor（检查当前版本后 +1 minor）

### 变更 7: 轻量 JSONL 过渡方案设计

EVO-20 完整实现（SQLite + graph store）在 Phase 5。
在 `meta/REDESIGN_PLAN.md` 中设计一个过渡方案段落：

- 过渡格式：JSONL 文件，每行一个 memory_graph_node_v1 JSON 对象
- 过渡存储：`~/.autoresearch/memories/research_memory.jsonl`（全局）+ `<project>/.memories/research_memory.jsonl`（项目级）
- 过渡写入：run 结束 + 审批通过后，hepar/research-team/idea-core 追加条目
- 过渡读取：run 启动时全文扫描 + 关键词匹配（无向量索引）
- 迁移路径：EVO-20 实现时，JSONL 直接导入 SQLite memory graph

## 约束

- 只修改 `meta/` 子目录（schemas/ + REDESIGN_PLAN.md + tracker）
- 不修改 Phase 0-1 条目
- 不实现任何代码
- Schema 必须遵循 JSON Schema draft 2020-12
- 新增字段不得破坏现有节点类型的语义（status/project_id 均有 default 值）
- 注意：Phase 0 monorepo 迁移正在并行进行中，避免修改 meta/ 以外的文件

## 验收条件

1. 4 个新 payload schema 文件通过 JSON Schema 语法验证
2. 修改后的 memory_graph_node_v1.schema.json 通过语法验证
3. 现有节点类型的 allOf 逻辑不受影响（可用现有测试数据验证）
4. REDESIGN_PLAN.md scope expansion 段落完整描述了 7 项变更
5. depends_on 无循环
6. plan_version 已递增

## 双模型审核

完成上述变更后，执行 Codex + Gemini 双模型审核。

### Reviewer System Prompt

```
You are a strict technical reviewer for JSON Schema design in a multi-component AI research platform.

Review focus:
1. Schema correctness: Valid JSON Schema draft 2020-12? allOf/if/then discriminators correct?
2. Backward compatibility: Do new fields with defaults break existing node type semantics?
3. Domain fitness: Do research memory payload schemas capture the right data for their use case?
4. Consistency: Do new schemas follow naming/structure conventions of existing ones?
5. Scope: Is this a genuine EVO-20 extension, or should it be a separate item?

Output format:
Line 1: READY or NOT_READY
Then: ## Blocking Issues / ## Non-Blocking Suggestions
```

### 执行

```bash
OUT_DIR=meta/.review/evo20-research-memory-r1

python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir "$OUT_DIR" \
  --system "$OUT_DIR/reviewer_system.md" \
  --prompt "$OUT_DIR/packet.md" \
  --models claude/opus,gemini/default \
  --backend-prompt gemini="$OUT_DIR/gemini_prompt.txt" \
  --backend-output claude=claude_output.md \
  --backend-output gemini=gemini_output.md \
  --check-review-contract \
  --fallback-mode auto \
  --fallback-order codex,claude
```

收敛标准：所有模型 VERDICT: READY，0 blocking issues。最大 5 轮。

## 不做的事

- 不实现 EVO-20 的 SQLite graph store（Phase 5）
- 不实现 auto-recall 代码（只设计接口约定）
- 不修改 packages/ 下的任何代码
- 不新增独立 REDESIGN_PLAN 条目（通过 EVO-20 scope expansion 实现）
