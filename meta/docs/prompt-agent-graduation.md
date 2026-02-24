# Prompt: Agent Graduation — REDESIGN_PLAN + Tracker 扩充

> 本 prompt 用于新开 Claude Code 对话，扩充 REDESIGN_PLAN.md 和 remediation_tracker_v1.json，
> 将 research-team、idea-core、hepar 从"编排角色"升级为"持久策略 Agent"。
> 完成后需经 Codex (gpt-5.3-codex, xhigh) + Gemini (默认模型) 双模型审核迭代收敛。

---

## 背景

Autoresearch 生态圈当前是一个 **Compound AI System**——多个 LLM + 领域工具 + 审批门禁的编排平台。
核心组件（research-team、idea-core、hepar）目前是**无状态角色**：被调用时执行，执行后遗忘。

升级目标：让这三个组件获得**持久策略**能力——记住历史、适应行为，从而在第 N 次 run 时比第 1 次更聪明。

判定标准（角色 → Agent 的分界线）：

| 属性 | Role（现状） | Agent（目标） |
|------|-------------|-------------|
| 状态 | 无状态（每次重建） | 持久状态跨 session |
| 策略 | 固定 system prompt | 根据历史自动调整 |
| 失败处理 | 报错退出 | 查询失败库 → 换策略重试 |

---

## 需要修改的文件

1. `autoresearch-meta/REDESIGN_PLAN.md`
2. `autoresearch-meta/remediation_tracker_v1.json`

---

## 具体变更要求

### 变更 1: 新增 RT-05 — Workstream 持久策略 (Phase 2)

**位置**: Phase 2 (深度集成), research-team 系列

**设计要点**:
- 定义 `workstream_strategy_v1.json` schema：记录每个 workstream 的擅长领域、失败方向、偏好方法
- run 结束时自动更新策略文件（写入有效/无效的策略选择）
- run 开始时读取策略文件注入 system prompt（让 workstream 行为因历史而不同）
- 不依赖 REP SDK（EVO-17），可在 RT-02/RT-03 完成后独立执行
- 实现语言取决于 NEW-05a 进度

**Tracker 条目**:
```json
"RT-05": {
  "title": "Workstream 持久策略 (Agent Graduation: research-team)",
  "status": "pending",
  "complexity": "medium",
  "assignee": null,
  "depends_on": ["RT-02", "RT-03"],
  "source": "agent-graduation",
  "note": "workstream_strategy_v1 schema + run-end 写入 + run-start 注入; 不依赖 EVO-17"
}
```

### 变更 2: 扩展 NEW-05a scope — idea-engine 预埋 Agent 接口

**位置**: Phase 0, NEW-05a 条目的 note 中补充

**设计要点**:
- idea-core → TS idea-engine 迁移时，设计 spec 中预埋 scan/propose/learn 三个方法接口
- scan: 增量扫描 INSPIRE 新文献
- propose: 交叉现有 idea 库，主动生成研究提案
- learn: 从已完成 run 的结果反馈中更新评估模型
- 这些接口在 Phase 0 只是 spec/skeleton，实际实现在 Phase 4

**Tracker 变更**: 在 NEW-05a 的 note 中追加 "(scope 扩展: idea-engine spec 预埋 scan/propose/learn Agent 接口，实际实现延至 Phase 4)"

### 变更 3: 新增 EVO-22 — hepar 策略决策节点 (Phase 4)

**位置**: Phase 4 (长期演进)

**设计要点**:
- 在 hepar 工作流的 3-5 个关键分叉处引入基于 StrategyState 的自动选择
- 关键分叉候选：计算方法选择、文献搜索策略、写作风格/结构、审稿回应策略
- 决策依据来自 EVO-17 REP SDK 的 StrategyState
- 每次决策记录日志（decision_log），供后续策略更新和人类审查
- 保留人类 override 能力（审批 gate 仍为 fail-closed）

**Tracker 条目**:
```json
"EVO-22": {
  "title": "hepar 策略决策节点 (Agent Graduation: orchestrator)",
  "status": "pending",
  "complexity": "high",
  "assignee": null,
  "depends_on": ["EVO-17"],
  "source": "agent-graduation",
  "note": "3-5 个工作流分叉点引入 StrategyState 自动选择 + decision_log; 人类 override 保留"
}
```

### 变更 4: 全局约束段补充 Agent 化方向声明

**位置**: REDESIGN_PLAN.md 全局约束段（紧跟"无向后兼容负担"之后）

**内容**:
```markdown
> **Agent 化方向**: 生态圈核心组件（research-team、idea-engine、hepar）计划从无状态编排角色渐进升级为持久策略 Agent。
> 判定标准：组件在第 N 次 run 时，能基于前 N-1 次的历史自动调整行为。
> 渐进路径：Phase 2 (RT-05 workstream 策略) → Phase 4 (EVO-22 hepar 决策节点) → Phase 5 (EVO-17 REP SDK 全面 Agent 化)。
> 在 EVO-20 (跨周期记忆图谱) 就绪前，通过 Serena write_memory 过渡性记忆协议积累跨 session 知识（见工作区 CLAUDE.md）。
```

### 变更 5: 依赖拓扑总览更新

在 REDESIGN_PLAN.md 的依赖拓扑 ASCII 图中，Phase 2 补充 RT-05，Phase 4 补充 EVO-22。

---

## 验收条件

1. REDESIGN_PLAN.md 中新增条目的描述完整（现状、动机、目标结构、验收检查点）
2. remediation_tracker_v1.json 中新增条目的 depends_on 正确无循环
3. plan_version 递增（在当前版本基础上 +1 minor）
4. 依赖拓扑 ASCII 图已更新
5. 全局约束段已补充 Agent 化方向声明

---

## 双模型审核

完成上述变更后，执行双模型收敛审核：

### 审核 prompt 准备

将变更后的 REDESIGN_PLAN.md 相关段落提取为 review packet，附上以下 reviewer system prompt：

```
You are a strict technical reviewer for a multi-component AI research platform redesign plan.

Review focus:
1. Dependency correctness: Are depends_on chains acyclic and complete?
2. Scope clarity: Are new items precisely scoped (not overlapping existing items)?
3. Feasibility: Are Phase placements realistic given prerequisites?
4. Consistency: Do new items follow the existing naming/numbering conventions?
5. Value assessment: Does agent graduation genuinely add value, or is it premature abstraction?

Output format:
Line 1: READY or NOT_READY
Then: ## Blocking Issues / ## Non-Blocking Suggestions
```

### 执行

```bash
OUT_DIR=autoresearch-meta/.review/agent-graduation-r1

# Prepare review packet
# (将变更后的 REDESIGN_PLAN.md 全局约束段 + 新增条目段 + tracker diff 合并为 packet.md)

python3 skills/review-swarm/scripts/bin/run_dual_task.py \
  --out-dir "$OUT_DIR" \
  --claude-system "$OUT_DIR/reviewer_system.md" \
  --claude-prompt "$OUT_DIR/packet.md" \
  --gemini-prompt "$OUT_DIR/gemini_prompt.txt" \
  --claude-model opus \
  --gemini-model gemini-3-pro-preview \
  --check-review-contract \
  --fallback-mode auto \
  --fallback-order codex,claude
```

如果任一模型返回 NOT_READY + blocking issues，修正后提交 R+1，直到收敛。
最大 5 轮。

---

## 不做的事

- 不修改 Phase 0-1 的任何条目（基础设施不变）
- 不新增 idea-core 的独立条目（通过扩展 NEW-05a scope 实现）
- 不重组 Phase 结构（只追加条目，不移动现有项）
- 不实现任何代码（本轮只修改文档和 tracker）
