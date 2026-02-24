# OpenCode & OpenClaw 设计模式调研笔记 —— 面向 Autoresearch 生态圈的采纳分析

> **日期**: 2026-02-19
> **调研目标**: 深入分析 OpenCode (anomalyco/opencode) + oh-my-opencode 和 OpenClaw (openclaw/openclaw) 的架构设计，提取可采纳的设计模式，服务于 Autoresearch 的三大目标：高质量自动研究、多 Agent 并行运行、断线可恢复 (resume)
> **与已有调研的关系**: 本文件是 `idea-generator/docs/plans/2026-02-12-opencode-hepar-compatibility.md` 和 `idea-generator/docs/plans/2026-02-12-ideasearch-openclaw-deep-dive.md` 的后续深化，聚焦于**生态圈级架构采纳**而非单组件集成

---

## 1. 调研对象概述

### 1.1 OpenCode (anomalyco/opencode)

- **定位**: 开源 AI coding agent 平台 (TypeScript, ~106K stars)
- **架构**: Client-Server 分离，SQLite 持久化，多会话隔离，5 种内置 agent
- **关键特征**: Session 持久化 + 自动压缩 (compaction)、Plugin 体系、Permission 分级、MCP 支持

### 1.2 oh-my-opencode (code-yeongyu/oh-my-opencode)

- **定位**: OpenCode 之上的多 Agent 编排框架 (~32K stars)
- **架构**: 7+ 神话命名 agent (Sisyphus/Prometheus/Atlas/Momus/Metis/Oracle/Hephaestus)
- **关键特征**: Intent 分类门禁、6-Section 委派协议、Todo 延续强制、Session 恢复钩子、Notepad 跨任务知识积累

### 1.3 OpenClaw (openclaw/openclaw)

- **定位**: 开源个人 AI 助手网关平台 (TypeScript, MIT)
- **架构**: Gateway 中心控制平面 + WebSocket 协议 + 15+ 消息通道 + 子 Agent 分层嵌套
- **关键特征**: 全隔离 Agent 工作区、Broadcast Group 并行、JSONL 转录持久化 + 纯文本记忆 + 向量+BM25 混合搜索、ClawHub 技能注册中心

---

## 2. 已有调研覆盖 vs 本次新增

| 主题 | 2026-02-12 调研覆盖 | 本次新增 |
|---|---|---|
| OpenCode Server API | ✅ 端点族 + Permission 模型 | + SQLite Schema 细节 + Compaction 机制 + Crash Recovery |
| OpenCode Agent 体系 | ✅ Role/Team 映射 | + oh-my-opencode 7 agent 完整设计哲学 |
| OpenClaw 控制平面 | ✅ Broadcast Groups + Tool Policy | + Sub-Agent 嵌套 (depth 1-5) + announce chain + sessions_send 协议 |
| OpenClaw 记忆系统 | ❌ 未覆盖 | + JSONL 转录 + BM25+向量混合搜索 + 时间衰减 + MMR |
| Oh-my-opencode 意图分类 | ❌ AGENTS.md 有简述 | + 6 种意图类型 + 意图特定工具指南 + AI-Slop 检测 |
| Session Resume | ❌ 未详细覆盖 | + 三种错误类型恢复 + Boulder State 跨会话持久化 |
| 质量门禁模式 | ❌ 未覆盖 | + Momus 4 标准审查循环 + Atlas 验证协议 + 证据基完成标准 |
| 背景 Agent 管理 | ❌ 未覆盖 | + 并发限制 + TTL + 停滞检测 + 队列系统 |
| 长期愿景映射 | ❌ 未覆盖 | + 多 Agent 自主研究社区 → 架构需求分析 |

---

## 3. 可采纳设计模式详析

### 3.1 Session 持久化与崩溃恢复

#### OpenCode 模式

```
SQLite (Drizzle ORM)
  ├── SessionTable: id, project_id, parent_id, summary stats, revert info, timestamps
  ├── MessageTable: id, session_id, JSON data blob
  ├── PartTable: id, message_id, session_id, JSON data blob (tool calls, text, thinking)
  └── TodoTable: session_id, content, status, priority
```

**崩溃恢复**: SQLite 是 SSOT。每条消息/Part 在显示前事务性持久化。崩溃最多丢失当前 in-flight LLM 响应。重新打开 session 即可恢复。

**Session 压缩**: 当 token 使用量接近模型上下文限制时，触发 compaction agent 将对话总结为结构化模板 (Goal, Instructions, Discoveries, Accomplished, Relevant files)。旧 tool call 输出按时间逆序裁剪，保留最近 ~40K tokens。

#### OpenClaw 模式

```
JSONL 转录: ~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl
Session 元数据: sessions.json (sessionId, updatedAt, model, token counts)
记忆: memory/YYYY-MM-DD.md (日追加) + MEMORY.md (长期策展)
```

**Pre-compaction 记忆冲刷**: 压缩前触发静默 agentic turn，提醒模型将重要发现写入磁盘。

#### oh-my-opencode 模式

**Boulder State** (跨 Session 持久化):
```json
{
  "active_plan": ".sisyphus/plans/feature-x.md",
  "started_at": "2026-02-19T10:00:00Z",
  "session_ids": ["ses_001", "ses_002", "ses_003"],
  "plan_name": "feature-x"
}
```
存为 `.sisyphus/boulder.json`。新 session 启动时检查是否有活跃 boulder state，可恢复计划。

**Session Recovery Hook** (错误分类恢复):
- `tool_result_missing`: 注入合成 tool_result (cancelled)
- `thinking_block_order`: 重排序 thinking parts
- `thinking_disabled_violation`: 移除 thinking blocks

#### **→ 对 Autoresearch 的采纳建议**

| 现状 | 采纳模式 | 优先级 |
|---|---|---|
| orchestrator_cli 使用 state.json + ledger.jsonl (已有持久化) | 补充 compaction 机制：长 run 自动总结上下文，保留关键 evidence URI | Phase 5 |
| HEPAR 无持久化 checkpoint | 采纳 SQLite 或 JSONL 事务性持久化 (已纳入 EVO-13) | Phase 5 |
| 无跨 session 计划恢复 | 采纳 Boulder State 模式：run_plan.json 独立于 session 存活 | Phase 4-5 |
| 无 pre-compaction 记忆冲刷 | 在 orchestrator run 暂停/中断前自动提取关键发现到 KB | Phase 5 |

---

### 3.2 多 Agent 编排体系

#### oh-my-opencode 7-Agent 设计哲学

| Agent | 希腊神话 | 核心原则 | 对 Autoresearch 的映射 |
|---|---|---|---|
| **Sisyphus** | 推石者 | "你的代码应与资深工程师的不可区分"；意图分类门禁；默认委派 | → 主 Orchestrator (已有 orchestrator_cli) |
| **Prometheus** | 盗火者 | "你是规划者，不是实现者"；面试驱动而非直接生成；Metis 协商 | → Research Planner (idea-core 的搜索策略制定) |
| **Atlas** | 擎天者 | "你从不写代码，你指挥专家"；session_id 延续；Notepad 知识积累 | → Team Orchestrator (HEPAR TeamRoleOrchestrator) |
| **Momus** | 嘲讽神 | "实现方向神圣不可侵犯"；审查文档质量而非设计决策；90% 置信度 | → 双模型审核 (已有 Gemini + Codex) |
| **Metis** | 智慧女神 | 6 意图类型；意图特定工具指南；AI-Slop 检测 | → 已纳入 AGENTS.md 意图分类 |
| **Oracle** | 德尔斐神谕 | 务实极简；单一明确推荐；只读分析 | → Research Advisor (idea-core evaluator) |
| **Hephaestus** | 锻造神 | 目标导向而非配方导向；先探索再执行；2-5 并行探索 agent | → hep-calc / computation executor |

**6-Section 委派协议** (Atlas 强制):
1. TASK: 原子化、具体的目标
2. EXPECTED OUTCOME: 具体交付物
3. REQUIRED TOOLS: 工具白名单
4. MUST DO: 完整要求清单
5. MUST NOT DO: 禁止事项
6. CONTEXT: 文件路径、模式、约束

**Todo 延续强制器**: 监控 agent 停止事件。如有未完成 todo，2 秒倒计时后注入系统指令 "继续工作，不要停下来"。

#### OpenClaw 子 Agent 分层嵌套

```
Main Agent (depth 0)
  ├── Orchestrator (depth 1): 拥有 sessions_spawn/list/history 工具
  │   ├── Worker A (depth 2, leaf): 无 session 工具
  │   ├── Worker B (depth 2, leaf): 无 session 工具
  │   └── Worker C (depth 2, leaf): 无 session 工具
  └── Direct Worker (depth 1): leaf
```

- 嵌套深度可配 (maxSpawnDepth: 1-5)
- 结果通过 announce chain 回流: depth-2 → depth-1 → main → user
- 并发管理: 每 agent 最大 8 并发子 agent，每父 agent 最大 5 子节点
- Cascade stop: 停止 orchestrator 自动停止所有 worker

**Agent-to-Agent 通信** (sessions_send):
1. Agent A 发消息给 Agent B 的 session
2. Agent B 处理并回复
3. Ping-pong 循环 (最多 maxPingPongTurns=5 轮)
4. 任一方可发 `REPLY_SKIP` 终止
5. 完成后 announce 到目标 channel

#### **→ 对 Autoresearch 的采纳建议**

| 现状 | 采纳模式 | 落入项 |
|---|---|---|
| HEPAR: ThreadPoolExecutor 平铺并行 | 采纳 OpenClaw 分层嵌套 (depth=2~3 足够) + cascade stop | EVO-13 |
| 无 agent 间通信 | 采纳 sessions_send ping-pong (用于 idea debate/peer review) | EVO-04/EVO-13 |
| 委派无结构化模板 | 采纳 6-Section 委派协议，写入 WorkOrder 扩展字段 | EVO-13 |
| 无 Notepad 知识积累 | 采纳 Atlas Notepad (learnings/decisions/issues/problems) 到 run 级 KB | EVO-13 |
| 无 Todo 延续强制 | 采纳 Todo 延续强制器逻辑到 orchestrator run loop | EVO-10 |

---

### 3.3 质量门禁与验证

#### Momus 4 标准审查循环

| 标准 | 阈值 | 描述 |
|---|---|---|
| Work Content Clarity | 90% confidence | 任务描述足以执行，猜测 <10% |
| Verification & Acceptance | 具体可度量 | 每项验收标准有明确通过/失败判定 |
| Context Completeness | 最小化猜测 | 文件路径、约束、模式全部列出 |
| Big Picture & Workflow | 理解全局 | 任务在全局中的位置和影响 |

**平均 7 次拒绝** 后计划才获批准。审查者验证每个引用文件、模拟实现、检测红旗。

#### Atlas 验证协议 (每次委派后强制)

- [ ] LSP diagnostics 项目级 — 零错误
- [ ] Build command — exit 0
- [ ] Test suite — 全部通过
- [ ] 文件存在且匹配要求
- [ ] 无回归

#### 证据基完成标准

| 动作 | 要求的证据 |
|---|---|
| 文件编辑 | `lsp_diagnostics` 在修改文件上清洁 |
| Build 命令 | 退出码 0 |
| 测试运行 | 通过 |
| 委派 | Agent 结果已接收并验证 |

**3 次连续失败协议**: STOP → REVERT → DOCUMENT → CONSULT Oracle

#### **→ 对 Autoresearch 的采纳建议**

| 现状 | 采纳模式 | 落入项 |
|---|---|---|
| 双模型审核 (Gemini + Codex) 面向文档 | 扩展到 idea 质量审查：4 标准循环可直接映射到 idea evaluation | EVO-06 |
| 验收检查点写在 PLAN 但非自动执行 | 采纳 Atlas 验证协议：每步修复后自动运行验收 | Phase 0+ |
| 无"3 次失败回退"策略 | 采纳 3-failure protocol 到 HEPAR TeamRoleOrchestrator | EVO-13 |

---

### 3.4 技能与记忆系统

#### OpenClaw 混合搜索记忆

```
memory/YYYY-MM-DD.md  — 日追加日志
MEMORY.md             — 策展长期记忆
向量搜索: OpenAI/Gemini/Voyage 或本地 GGUF 嵌入
混合搜索: BM25 关键词相关度 + 向量语义相似度
MMR 重排序: 多样性保证（减少冗余结果）
时间衰减: 指数衰减，半衰期可配 (默认 30 天)
```

#### oh-my-opencode 技能系统

- 技能 = Markdown 指令文件 + YAML frontmatter
- 按需加载 (非全部常驻上下文)
- Category + Skill 解耦意图与模型：声明语义意图 ("visual-engineering", "quick")，系统映射到最优模型
- 技能作为 prompt 前缀注入

#### OpenClaw ClawHub 技能注册中心

- 公开注册中心 (clawhub.ai) + 向量搜索
- CLI 驱动: install/search/publish/sync
- 技能声明运行时要求 (env vars, binaries, config)
- 安全分析: 检查声明与实际行为是否匹配

#### **→ 对 Autoresearch 的采纳建议**

| 现状 | 采纳模式 | 落入项 |
|---|---|---|
| knowledge_base/ 纯文件 | 采纳 BM25+向量混合搜索 + 时间衰减 + MMR | Phase 5 (新增或扩展 EVO-09) |
| skills/ 按需手动安装 | 采纳 ClawHub 式注册中心模式 → skills-market 已有雏形 | EVO-12 |
| 无 Category 语义路由 | 采纳 Category 机制：按研究类型 (literature/computation/writing) 路由到最优 agent/model | EVO-13 |

---

### 3.5 断线恢复 (Resume) 完整方案

综合两个框架的最佳实践，Autoresearch 的断线恢复应包含以下层次:

```
Layer 1: Run State 持久化 (已有 state.json + ledger.jsonl)
   ├── state.json: 工作流阶段、分支决策、审批状态
   └── ledger.jsonl: 所有事件的 append-only 日志

Layer 2: Team Execution Checkpoint (EVO-13 新增)
   ├── team_execution_state.json: 团队计划、角色状态、已完成 WorkOrder
   └── checkpoint 策略: 每个 WorkOrder 完成后写 checkpoint

Layer 3: Boulder State (新采纳)
   ├── run_plan.json: 独立于 session 的工作计划
   └── session_ids[]: 所有参与此计划的 session 历史

Layer 4: Pre-interruption Flush (新采纳)
   └── 中断前自动提取关键发现到 knowledge_base/

Layer 5: Session Recovery (新采纳)
   ├── 错误分类: tool_result_missing / timeout / crash
   └── 恢复策略: 注入合成结果 / 从 checkpoint 续行 / 重启 session
```

**恢复流程**:
1. `hepar resume` → 读取 state.json 恢复工作流阶段
2. 检查 team_execution_state.json → 恢复并行团队执行 (跳过已完成角色)
3. 检查 run_plan.json → 恢复跨 session 计划进度
4. 注入上次中断的上下文总结到新 session

---

## 4. 差距分析：当前生态圈 vs 采纳后目标

### 4.1 当前能力矩阵

| 能力 | OpenCode/OMOC | OpenClaw | Autoresearch 现状 | 差距 |
|---|---|---|---|---|
| Session 持久化 | SQLite 事务性 | JSONL 转录 | state.json + ledger.jsonl | ⚠️ HEPAR 无持久化 |
| 崩溃恢复 | 最多丢 1 条回复 | Gateway 重启丢 announce | orchestrator_cli 可恢复，HEPAR 不可 | ❌ |
| Context 压缩 | 自动 compaction + pruning | Pre-compaction flush + 自动压缩 | 无 | ❌ |
| 多 Agent 并行 | Background Agent Manager | Sub-Agent 嵌套 (5 层) | HEPAR ThreadPoolExecutor (1 层) | ⚠️ 仅 1 层 |
| Agent 间通信 | Session ID 延续 + 背景 agent | sessions_send ping-pong | 无 | ❌ |
| 意图分类 | Metis 6 类型 | 无 | AGENTS.md 5 类型 (Metis 式) | ✅ 已覆盖 |
| 质量门禁 | Momus 4 标准 + Atlas 验证 | 无 | 双模型审核 | ⚠️ 覆盖文档，未覆盖代码 |
| 技能生命周期 | 动态 prompt 注入 + Category 路由 | ClawHub 注册中心 | skills-market 手动安装 | ⚠️ 手动 |
| 记忆搜索 | SQLite + pruning | BM25+向量+时间衰减+MMR | 纯文件 knowledge_base | ❌ |
| 跨 session 计划 | Boulder State | Session store + announce | 无 | ❌ |
| Todo 延续强制 | 2s 倒计时重注入 | 无 | 无 | ❌ |

### 4.2 采纳优先级排序

**P0 (直接影响核心目标 "多 Agent + Resume")**:
1. Team Execution Checkpoint (→ EVO-13)
2. 分层嵌套 Agent + Cascade Stop (→ EVO-13)
3. Session Recovery 错误分类 (→ EVO-13)
4. 6-Section 委派协议 (→ EVO-13 WorkOrder 扩展)

**P1 (提升研究质量)**:
5. 证据基完成标准 (→ Contract 扩展)
6. 3 次失败回退协议 (→ EVO-13)
7. Notepad 跨任务知识积累 (→ EVO-13)

**P2 (提升自进化能力)**:
8. Todo 延续强制 (→ EVO-10)
9. Category 语义路由 (→ EVO-13)
10. 混合搜索记忆 (→ 独立项或 EVO-09 扩展)

**P3 (长期基础设施)**:
11. Boulder State 跨 session 计划 (→ Phase 5)
12. Pre-interruption Flush (→ Phase 5)
13. ClawHub 式技能注册 (→ EVO-12)

---

## 5. 对长期愿景的架构需求分析

### 5.1 长期愿景描述

> 除了人类使用之外，建立多 Agent 自动研究的社区，试验 Agent 自主科研的能力：从一组大量文献出发，多个 Agent 自由挑选课题进行研究，发布研究结果，这些结果成为后续研究的基础——类似于人类的 arXiv 库 (如 hep-th)。观察 Agent 研究社区的自主进化程度。

### 5.2 架构需求分解

要支撑这一愿景，需要以下能力:

#### A. 文献池与研究结果库 (Agent-arXiv)

| 需求 | 描述 | 现有基础 |
|---|---|---|
| 文献导入 | 从 hep-th arXiv 批量导入作为初始知识库 | ✅ INSPIRE + Zotero 集成 |
| 研究结果发布 | Agent 完成研究后将结果发布为标准格式产物 | ⚠️ ArtifactRef 就绪但无"发布"语义 |
| 结果可引用 | 已发布结果可被其他 Agent 引用为 evidence | ⚠️ evidence_mapper 面向人类论文 |
| 搜索与发现 | Agent 可搜索文献池中的已有研究 | ⚠️ INSPIRE 面向外部，缺内部搜索 |
| 质量分级 | 已发布结果有质量评分 (peer review by agents) | ⚠️ integrity_report 设计就绪 |

#### B. Agent 研究员社区

| 需求 | 描述 | 现有基础 |
|---|---|---|
| Agent 注册与能力声明 | 每个 Agent 声明研究领域和能力 | ⚠️ NEW-07 Agent Card |
| 自主选题 | Agent 基于兴趣/能力/文献池自主选择课题 | ❌ 需要 idea-core island 机制扩展 |
| 并行独立研究 | 多个 Agent 同时进行不同课题 | ⚠️ EVO-14 跨 Run 并行 |
| 研究协作 | Agent 可邀请其他 Agent 参与 (peer review, computation) | ❌ 需要 A2A sessions_send 式协议 |
| 资源竞争与分配 | 有限计算/token 预算的公平分配 | ⚠️ EVO-14 资源感知调度 |

#### C. 自主进化观测

| 需求 | 描述 | 现有基础 |
|---|---|---|
| 研究质量追踪 | 社区研究质量随时间的变化曲线 | ⚠️ run_quality_metrics |
| 知识图谱增长 | 文献引用网络的增长与结构变化 | ❌ 需要 citation graph |
| 原创性度量 | 区分"真正新发现" vs "已知结果复述" | ⚠️ EVO-06 novelty_verifier |
| 失败模式分析 | 社区级失败模式统计与趋势 | ⚠️ EVO-09 failure_library + EVO-10 |
| 进化速率指标 | 从"初始文献"到"N 代研究成果"的知识扩展速率 | ❌ 全新需求 |

### 5.3 OpenCode/OpenClaw 模式对愿景的支撑

| 愿景需求 | 最佳采纳源 | 具体模式 |
|---|---|---|
| Agent 自主选题 | IdeaSearch 多岛搜索 | Island 作为"研究方向"，Agent 自动选择 island 并从文献池中挖掘课题 |
| 并行独立研究 | OpenClaw Sub-Agent 嵌套 | 每个研究项目为独立 session，orchestrator 管理并行 |
| 研究结果发布 | OpenClaw Announce Chain | 研究完成后 announce 到 Agent-arXiv，触发索引更新 |
| Agent 间协作 | OpenClaw sessions_send | Peer review 邀请 = sessions_send + ping-pong 评审循环 |
| 质量门禁 | oh-my-opencode Momus | 每篇"论文"发布前经过 agent peer review (integrity + novelty + correctness) |
| 断线恢复 | OpenCode Session + Boulder State | 长期研究项目跨 session 存活，中断后可从 checkpoint 恢复 |
| 进化观测 | OpenClaw 记忆系统 | 全社区知识以混合搜索 (BM25+向量) 可查询，支持趋势分析 |

---

## 6. oh-my-opencode 各 Agent 设计深度记录

### 6.1 Sisyphus (主 Agent / 编排者)

**核心设计哲学**:
- **代码标准**: "你的代码应与资深工程师的代码不可区分"
- **意图门禁**: 每条消息先分类 (Trivial/Explicit/Exploratory/Open-ended/Ambiguous)
- **默认偏向委派**: 只有极简单任务才亲自执行
- **动态 prompt 构建**: 系统 prompt 根据可用 agent/工具/技能/类别运行时拼装
- **代码库状态分类**: Disciplined / Transitional / Legacy / Greenfield — 据此调整行为
- **反模式强制**: 禁止 `as any`, `@ts-ignore`, diagnostic 抑制

**与 Autoresearch 的映射**: orchestrator_cli 已部分实现意图门禁和委派逻辑。缺失：动态 prompt 构建、代码库状态自适应。

### 6.2 Prometheus (规划)

**核心设计哲学**:
- **身份约束**: "你是规划者，不是实现者"
- **面试驱动**: 不立即生成计划；先面试用户、通过背景 agent 调研代码库，再生成
- **清关检查**: 5 条标准全部通过后才从面试转入计划生成
- **Metis 协商**: 最终计划必须经过 Metis 差距分析

**与 Autoresearch 的映射**: idea-core 的 SearchPolicy 制定过程应采用类似的"先探索后计划"模式，而非直接生成 idea。

### 6.3 Atlas (编排)

**核心设计哲学**:
- **指挥官隐喻**: "你从不写代码。你指挥专家。"
- **Session 延续**: 总是复用 session_id 进行重试 — "重新开始等于擦除记忆"
- **Notepad 协议**: 跨任务知识积累。每次委派前读 notepad，指示子 agent 写入发现
  ```
  .sisyphus/notepads/{plan-name}/
    learnings.md    # 惯例、模式
    decisions.md    # 架构选择
    issues.md       # 问题、陷阱
    problems.md     # 未解决阻塞
  ```
- **并行规则**: 探索 agent 总是后台；任务执行永不后台
- **验证强制**: "子 agent 会撒谎。验证一切。"

**与 Autoresearch 的映射**: HEPAR TeamRoleOrchestrator 应采纳 Notepad 和验证强制。当前 HEPAR 缺失跨任务知识传递和结果验证。

### 6.4 Momus (审查)

**核心设计哲学**:
- **实现方向神圣**: 审查文档质量，不审查设计决策
- **自问**: "我在质疑方法还是文档？" — 如果是前者，停止
- **深度验证**: 读每个引用文件，验证每个声明，模拟实现
- **90% 置信度阈值**: 任务描述必须提供足够上下文使猜测 <10%

**与 Autoresearch 的映射**: 双模型审核流程可扩展为 Momus 式审查——不仅审核文档，也审核 idea quality packet。

### 6.5 Oracle (策略顾问)

**核心设计哲学**:
- **务实极简**: "正确方案通常是最不复杂的"
- **单一明确路径**: 一个主推荐，替代方案仅在本质不同时提供
- **工作量标签**: Quick (<1h), Short (1-4h), Medium (1-2d), Large (3d+)
- **只读**: 不能写、编辑或委派。纯分析。

**与 Autoresearch 的映射**: idea-core evaluator 已类似 Oracle — 提供评估但不执行。可采纳工作量标签用于 idea feasibility 评估。

### 6.6 Hephaestus (深度自治执行)

**核心设计哲学**:
- **目标导向**: 给目标，不给配方
- **先探索**: 执行前先发射 2-5 个并行 explore/librarian agent
- **端到端完成**: 不到 100% 完成 (有验证证据) 不停止
- **模式匹配**: 搜索现有代码库以匹配项目风格

**与 Autoresearch 的映射**: hep-calc 计算执行应采纳 Hephaestus 模式 — 先搜索已有程序包，再执行，最后验证。

---

## 7. OpenClaw 独特模式深度记录

### 7.1 Gateway 中心架构

```
Messaging Channels (WhatsApp, Telegram, Slack, etc.)
               |
               v
+-------------------------------+
|           Gateway             |
|    (WebSocket :18789)         |
|    State SSOT                 |
|    Routing                    |
|    Permission                 |
+-------------------------------+
    |         |         |
    v         v         v
  Agent A   Agent B   Agent C
  (isolated  (isolated  (isolated
   workspace) workspace) workspace)
```

**关键**: Gateway 是 SSOT。UI/CLI/移动端都是 thin client。Agent 工作区完全隔离 (文件系统 + 会话 + 认证 + 技能)。

### 7.2 确定性 Binding 路由

```jsonc
{
  "bindings": [
    { "agentId": "theorist", "match": { "channel": "hep-th", "peer": { "kind": "topic", "id": "SUSY-breaking" } } },
    { "agentId": "calculator", "match": { "channel": "hep-th" } },
    { "agentId": "reviewer", "match": { "channel": "review" } }
  ]
}
```

**most-specific-wins**: 精确 peer 匹配 > 父级 peer > Guild+角色 > Channel 级 > 默认。

### 7.3 Idempotency + Challenge Auth

- 所有副作用方法要求 idempotency key (重试安全)
- 设备认证使用 nonce-challenge 签名
- Protocol 版本协商 (minProtocol/maxProtocol)

### 7.4 Pre-compaction Memory Flush

压缩前的静默 agentic turn:
1. 模型被提醒"上下文即将压缩"
2. 自动提取关键发现写入 memory 文件
3. 然后才执行压缩

**对 Autoresearch 的价值**: 长 run (如多周研究项目) 在 context 窗口耗尽前自动保存关键发现，防止信息丢失。

---

## 8. 综合采纳路线图

### 8.1 已由 REDESIGN_PLAN 覆盖的采纳项

| 采纳模式 | 对应项 | 状态 |
|---|---|---|
| Agent 注册 + A2A | NEW-07, EVO-04 | Phase 4-5 |
| 统一编排 (并行+持久化) | EVO-13 | Phase 5 |
| 跨 Run 并行 + Agent 生命周期 | EVO-14 | Phase 5 |
| 进化提案自动闭环 | EVO-10 | Phase 5 |
| Bandit 分发策略运行时 | EVO-11 | Phase 5 |
| 技能生命周期自动化 | EVO-12 | Phase 5 |
| 失败库查询 | EVO-09 | Phase 5 |

### 8.2 尚未纳入 PLAN 但建议采纳的模式

| 采纳模式 | 来源 | 建议落入 | 备注 |
|---|---|---|---|
| 6-Section 委派协议 | oh-my-opencode Atlas | EVO-13 WorkOrder 扩展 | 作为 EVO-13 实现细节 |
| Notepad 跨任务知识积累 | oh-my-opencode Atlas | EVO-13 ControlPlane 扩展 | 作为 EVO-13 实现细节 |
| Todo 延续强制 | oh-my-opencode Sisyphus | EVO-10 | 作为 EVO-10 实现细节 |
| Pre-interruption Flush | OpenClaw | EVO-13 | 作为 EVO-13 实现细节 |
| 3 次失败回退协议 | oh-my-opencode | EVO-13 | 作为 EVO-13 实现细节 |
| 混合搜索记忆 (BM25+向量) | OpenClaw | 独立新项 或 Phase 5 扩展 | 可作为 Agent-arXiv 基础设施 |
| Boulder State 跨 session 计划 | oh-my-opencode | EVO-13 | 作为 EVO-13 实现细节 |
| Agent-arXiv (研究结果库) | 长期愿景 | 独立新项 (Phase 5) | 需要独立设计 |
| Agent 自主选题 | 长期愿景 + IdeaSearch | 独立新项 (Phase 5) | 需要 idea-core island 扩展 |

### 8.3 无需采纳的模式

| 模式 | 来源 | 不采纳原因 |
|---|---|---|
| 15+ 消息通道 | OpenClaw | Autoresearch 不面向消息平台 |
| ClawHub 公开注册 | OpenClaw | 安全风险；skills-market 已有私有方案 |
| Gateway WebSocket 协议 | OpenClaw | Autoresearch 使用 MCP stdio，不需要 WS 网关 |
| Dynamic prompt building | oh-my-opencode | 增加复杂度；Autoresearch 的 prompt 由 evidence packet 决定 |

---

## 9. 与已有 2026-02-12 调研文档的关系

| 2026-02-12 文档 | 本文的增量 |
|---|---|
| `opencode-hepar-compatibility.md` (方案 A/B/C) | 本文不重复集成方案，聚焦于**设计模式提取**。方案 B (API 编排) 仍为推荐路径 |
| `ideasearch-openclaw-deep-dive.md` (Broadcast Groups + IdeaSearch) | 本文补充 OpenClaw 的 **sub-agent 嵌套、记忆系统、pre-compaction flush**；补充 IdeaSearch 与长期愿景的映射 |
| AGENTS.md (oh-my-opencode 覆盖表) | 本文给出 7 agent 的**完整设计哲学**，而非仅覆盖/差距对比 |

---

## 10. 附录：关键来源

### 代码仓库
- [anomalyco/opencode](https://github.com/anomalyco/opencode) — OpenCode 平台 (~106K stars)
- [code-yeongyu/oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) — Agent 编排框架 (~32K stars)
- [openclaw/openclaw](https://github.com/openclaw/openclaw) — 个人 AI 助手网关 (MIT)
- [openclaw/clawhub](https://github.com/openclaw/clawhub) — 技能注册中心

### 已有生态圈调研文档
- `idea-generator/docs/plans/2026-02-12-opencode-hepar-compatibility.md` — OpenCode Runtime Adapter 设计
- `idea-generator/docs/plans/2026-02-12-ideasearch-openclaw-deep-dive.md` — IdeaSearch + OpenClaw 深度调研
- `hep-autoresearch/docs/VISION.zh.md` — 愿景文档
- `hep-autoresearch/docs/ROADMAP.zh.md` — 里程碑计划
