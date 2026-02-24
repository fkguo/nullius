# Approval gates（默认人类同意点）

结论：**默认需要**。除非用户明确选择“全自动/自担风险模式”，否则在高风险/高成本/高外部性步骤前都应设置人类同意点（approval gate）。

本文件把“什么时候必须问用户同意”写成项目政策，供未来 Orchestrator/CLI 实现为强制门禁。

## 1) 为什么默认要同意点？

科研自动化的失败通常不是“模型不会写字”，而是：
- 跑了不该跑的重计算（成本/时间不可控）
- 改了不该改的文件（尤其是论文正文/关键代码）
- 访问了不该访问的网络来源（可信度/隐私/合规）
- 提前给出“结论/新意”并被幻觉污染（声誉风险）

因此默认策略是：**先计划→用户同意→再执行**。

## 2) 默认同意点（建议）

下表是本项目建议的默认同意点；对应你提出的节点，我们统一为 5 类动作：

| 动作类别 | 例子 | 默认是否需要同意 | 备注 |
|---|---|---:|---|
| A1 大规模检索 | 关键词扩展、引用网络扩张、跨域 general search | 是 | 目的：控制网络“广撒网”与噪声；并让用户确认检索范围与预算 |
| A2 写/改代码 | 新增/改动 `src/`/`toolkit/`/脚本，或改变计算逻辑 | 是 | 目的：避免“写了很多但方向不对”；同意点通常基于一个可审阅的实现计划 |
| A3 跑算力/长任务 | 多参数扫描、拟合、生成大量事件、GPU 训练 | 是 | 目的：预算控制（时间/核数/内存/GPU），并要求先跑 toy/audit slice |
| A4 改论文/改稿 | 改 `paper/` 或用户指定 LaTeX 工程 | 是 | 目的：避免误改；强制 diff + 可编译 + 引用/证据门禁 |
| A5 写结论/宣称新意 | “我们发现…”、“与文献不一致原因是…” | 是 | 目的：把“结论”作为高风险输出；必须基于 artifacts/引用，并经过 Reviewer 收敛 |

### 2.1 Timeout 行为（必须明确，默认不得“沉默即同意”）

任何 gate 一旦触发，Orchestrator 都必须写入 `pending_approval`（并落盘审批包），同时定义：

- `timeout_at`：到期时间（或 `timeout_seconds`）
- `on_timeout`：超时动作

安全默认（建议）：

- **禁止** `auto_approve`（沉默不等于同意）
- 默认 `on_timeout = block`：保持暂停，等待人类处理；并在 `status` 中明显提示“已超时”
- 可选 `on_timeout = reject`：自动中止该动作并回到 Planner 重新规划（仍需落盘原因）
- 可选 `on_timeout = escalate`：仅升级提醒/优先级（仍保持暂停）

建议默认 timeout（可配置；以 `safe` 模式为例）：

| Gate | 建议 timeout | 建议 on_timeout |
|---|---:|---|
| A1 mass_search | 24h | block |
| A2 code_changes | 48h | block |
| A3 compute_runs | 48h | block |
| A4 paper_edits | 7d | block |
| A5 final_conclusions | 7d | block |

配置入口（计划；由 Orchestrator 执行）：
- schema：[`specs/approval_policy.schema.json`](../specs/approval_policy.schema.json)
- 示例：[`templates/approval_policy.safe.example.json`](../templates/approval_policy.safe.example.json)

相关状态契约见：[`docs/ORCHESTRATOR_STATE.md`](ORCHESTRATOR_STATE.md)。

### 2.2 失败模式与恢复（MVP）

必须明确（避免“未定义状态机”导致挂死或误执行）：

- **Timeout 触发时的行为（默认 safe）**：
  - timeout 触发 → 写入 ledger 事件 `approval_timeout`
  - `run_status` 保持 `awaiting_approval`（或进入 `paused`），并明确提示“已超时”
  - 仍 **不得** 自动继续执行（禁止沉默即同意）
- **Orchestrator 崩溃/重启**：
  - `pending_approval` 必须持久化在 `.autopilot/state.json`
  - 重启后必须回到 `awaiting_approval`（不得改变为 approved）
- **人类 abort**：
  - 必须把 run 标记为 `failed`（或 `aborted`），并写入原因与回滚指针（如适用）

可测试验收点（建议最小 3 个）：
- G-T1：pending approval 状态下 kill Orchestrator → 重启后仍为 `awaiting_approval`
- G-T2：timeout 到期后不得继续执行；状态/ledger 中可见 `approval_timeout`
- G-T3：reject/abort 后不得继续执行该动作；必须回到 Planner/或标记失败

默认允许不经同意的动作（低风险）：
- 读文件、做摘要、列计划、做静态检查（link/schema/format）、生成待办清单。
- 小规模、可回滚的写入（例如只在 `knowledge_base/` 写阅读笔记）可以作为默认允许项，但仍建议在首次执行前告知用户“将写入哪些路径”。

A5 触发口径（建议默认规则，后续可配置）：
- 任何包含 “first/novel/new discovery/首次/新发现/据我们所知/优于现有工作/解决了…长期问题/与文献不一致的原因已经确定” 等表达的输出
- 任何对外部工作做“归因式断言”（例如“他们错在…我们对在…”）且没有明确 artifact pointers/引用支撑

## 3) 如何覆盖（显式“全自动”）

推荐把同意策略作为项目配置（未来实现为 `approval_policy.json`），例如：
- `mode: safe`（默认）：A1–A5 都需要同意
- `mode: interactive`：只对 A3/A4/A5 需要同意；A1/A2 在预算阈值内自动
- `mode: full_auto`：尽量自动执行，但仍保留“紧急刹车”（stop file）与 run budget

建议把 `full_auto` 进一步拆成“逐类显式 opt-in”，避免一次开关变成“安全全关”：
- `full_auto.mass_search=true/false`
- `full_auto.code_changes=true/false`
- `full_auto.compute_runs=true/false`
- `full_auto.paper_edits=true/false`
- `full_auto.final_conclusions=true/false`

即使在 full_auto，也必须：
- 记录所有被跳过的同意点（bypass logging）
- 保留回滚机制（见 `docs/EVAL_GATE_CONTRACT.md`）

“宪法保护”（建议）：对核心安全契约的修改不得快进
- 任何修改以下文件的变更，必须强制进入最长延迟窗口（例如 24h）并要求人类复核，不得用 `--force-immediate` 绕过：
  - `specs/approval_policy.schema.json`
  - `docs/APPROVAL_GATES.md`
  - `docs/EVAL_GATE_CONTRACT.md`
  - 以及任何 `*_CONTRACT.md` / `*_GATES.md` 类核心政策文件

> 为什么常用 24h：这类“政策/宪法级”改动的风险来自长期累积（门禁被逐步削弱、审计链被绕开），而不是单次任务是否成功；加入 24h 延迟窗口的目的，是保证人类有现实可用的审阅时间，并降低快速投机/刷指标的空间。该值应当是可配置的默认值，而不是硬编码。

## 4) 门禁自身的验收（必须可测）

approval gates 不是“写在文档里就算有”，必须有可验证的测试用例（早期可以是脚本级/模拟级）：
- 正例：应该触发时确实触发
- 反例：不该触发时不会误触发
- 绕过尝试：分片/批量/提示词诱导不能绕过

最小测试计划（建议作为 M0.5 的退出条件之一；可先写成 eval cases/脚本规格）：

- 通用：
  - G0-1：所有 gate 触发都必须写入 run ledger（append-only）
  - G0-2：一旦 run 开始，gate 分类边界被冻结（agent 运行中不得重定义 A1–A5）

- A1（mass search）：
  - G1-1（正例）：一次检索预计返回 >N（例如 100）必须触发 A1
  - G1-2（绕过）：连续 10 次“50 结果”的分片检索仍必须触发 A1（按累计计数）

- A2（code changes）：
  - G2-1（正例）：对 `toolkit/`/`src/`/scripts 的写操作必须触发 A2
  - G2-2（绕过）：尝试把代码写到非预期目录再移动/拷贝，仍必须触发 A2（按“语义写入”判断）

- A3（heavy compute）：
  - G3-1（正例）：预计 runtime 或资源超过阈值必须触发 A3（阈值可配置）
  - G3-2（绕过）：把大任务拆成多个小任务提交仍必须触发 A3（按累计预算）

- A4（paper edits）：
  - G4-1（正例）：对 `paper/` 或用户指定 LaTeX 工程写操作必须触发 A4

- A5（final conclusions / novelty claims）：
  - G5-1：任何包含“首次/新发现/优于现有工作/与文献不一致原因已确定”等断言的输出，必须触发 A5 或被显式标记 UNVERIFIED

- full_auto：
  - GA-1：full_auto 必须逐类 opt-in；未 opt-in 的类别仍需审批
  - GA-2：full_auto 下任何被跳过的 gate 必须被记录（bypass logging）

无论哪种模式，都建议保留：
- `stop_files`: `.stop`/`.pause`（立即停止自动化循环）
- `max_runtime_minutes` / `max_network_calls`（预算硬上限）
- “先跑 audit slice 再扩展”的分级策略
