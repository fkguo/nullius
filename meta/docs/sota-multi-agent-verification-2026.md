# SOTA: Multi-Agent Verification for LLM-based Scientific Research Systems (2026)

> **作用**: 本文档服务三个目的：
> 1. **设计决策依据** — RT-01（三模式工作流）和 RT-04（Innovation ↔ idea-generator 桥接）的 SOTA 文献基线
> 2. **架构理论验证** — research-team 当前独立验证架构的 SOTA 支撑（含 A2A 通信评估）
> 3. **潜在发表方向** — HEP + LLM 现有发表格局与本项目的差异化空间
>
> **更新日期**: 2026-03-02 (文献 [1]–[19] + 新颖性分析 + 发表策略 + 详细设计)

---

## 核心结论摘要

1. **强单 agent ≈ 简单多 agent**：在大多数基准任务中，优化良好的单 agent 与多 agent 的性能差距极小；多 agent 的收益主要来自**独立验证**和**角色专业化**，而非并行数量。
2. **验证角色 > 生成角色**：专门用于 review/critique 的独立 agent（"verifier"）是多 agent 系统中最有价值的角色，显著提升正确率。这是 research-team `peer` 模式的理论依据。
3. **串行 leader 模式有早停优势**：leader 模式（增量验证 + 连续失败早停）在深度推导链任务上 token 效率优于 peer，但在宽泛审核任务上无优势。
4. **LLM-as-Judge 需校准**：多 agent 系统中的 convergence 判定如果依赖 LLM 评审，需要有配对一致性校准；纯启发式解析（当前 `check_team_convergence.py` 方式）比无校准 LLM judge 更稳定。
5. **异步并行有实际工程收益**：并行多 agent（`packet_only` 模式）在 wall-clock 时间上优于串行，但需要严格隔离以防交叉污染（RT-02 clean-room gate 已覆盖）。
6. **自由辩论（MAD）对验证任务有害，但结构化协作有益**：NeurIPS 2025 研究表明，multi-agent debate 的性能收益绝大部分来自 Majority Voting（独立输出聚合），而非相互通信本身。通信引入的 sycophancy（顺从偏差）直接破坏验证独立性。但 AIED 2025 研究 [17] 表明，peer-to-peer collaboration（共享中间过程 + 交叉验证，不交换最终答案）准确率优于 debate 且更稳定。**本项目采用 Semi-permeable Clean Room 设计**：拒绝 MAD，引入结构化协作（方法讨论/文献分享/约定对齐），通过 Information Membrane 阻止结论泄露。
7. **跨 provider 独立验证 + 结构化协作 > 同质 provider 的任何交互模式**：本项目 research-team 的跨 provider 配置天然隔离训练数据和 RLHF 偏好，叠加 Information Membrane 的内容类型过滤，使独立性保证强于纯隔离方案（因方法对齐减少 trivial 分歧），远强于任何自由辩论方案。

---

## 第一部分：工作流与编排 SOTA

### [1] "Rethinking the Value of Multi-Agent Workflow: A Strong Single Agent Baseline" (2026-01)
**arXiv**: 2601.12307

**核心发现**:
- 在 SWE-Bench、HumanEval 等编程基准上，经过精心调优的单 agent（ReAct + reflection）与多 agent（debate、cascade）性能相近。
- 多 agent 的实际提升来源于**独立视角的验证**，而非角色数量。

**对 RT-01 的影响**:
- `peer` 模式（两个独立 reviewer）已覆盖最高价值的多 agent 场景。
- `leader` 和 `asymmetric` 仅在特定场景增加价值（见 §适用场景矩阵）。
- 注意：此结论针对同质 provider 内 agent，跨 provider 场景见 §架构差异说明。

---

### [2] "Understanding Multi-Agent LLM Frameworks: A Unified Benchmark and Experimental Analysis (MAFBench)" (2026-02)
**arXiv**: 2602.03128

**核心发现**:
- 跨 15 个基准的系统评估表明，多 agent 框架在**数学推理**和**代码验证**子任务上相对单 agent 有 5–15% 提升，但在文档摘要、QA 等任务上无显著差异。
- `leader-follower` 架构在推理链较深（>5 步）的任务上有早停收益。

**对 RT-01 的影响**:
- `leader` 模式适合 HEP 中的多步推导（Feynman 图计算、重整化流程），不适合宽泛文献审核。
- 推导步骤数 ≤ 3 时，`peer` 和 `leader` 无显著差异。

---

### [3] "Multi-Agent Code Verification via Information Theory" (2025-11, rev. 2025-12)
**arXiv**: 2511.16708

**核心发现**:
- 将 verifier agent 与 generator agent 分离，并用互信息度量两者输出的一致性，比简单多数投票收敛更快、假阳性更低。
- 独立 verifier 对 generator 的"知识盲化"（asymmetric 隐藏 leader 结果）是提升独立性的有效手段。

**对 RT-01 的影响**:
- `asymmetric` 模式隐藏 leader 结果的设计（`build_team_packet.py` 按步骤构建，verifier 不可见 leader 答案）有信息论依据。
- convergence gate 应检查两个 verifier 的独立一致性，而非仅检查是否"都通过"。

---

### [4] "WorkflowPerturb: Calibrated Stress Tests for Evaluating Multi-Agent Workflow Metrics" (2026-02)
**arXiv**: 2602.17990

**核心发现**:
- 未经校准的 convergence 指标（如简单 LLM judge "agree/disagree"）在 perturbation 测试下假阳性率高达 30–40%。
- 基于结构化输出解析的启发式 gate（如当前 `check_team_convergence.py` 中的 `pass/fail/ready` 解析）比无校准 LLM judge 更稳健。

**对 RT-01 的影响**:
- 当前 `check_team_convergence.py` 的启发式解析方法是**正确选择**，不应替换为 LLM judge。
- 增加 mode-aware 检查时，同样应保持确定性解析，不引入 LLM 判定。

---

### [5] "MAS-ProVe: Understanding the Process Verification of Multi-Agent Systems" (2026-02)
**arXiv**: 2602.03053

**核心发现**:
- 过程验证（process verification，即验证每个推导步骤而非只验证最终结果）显著提升 multi-agent 系统对错误的早期拦截。
- 对于长推导链，step-level verification > result-level verification。

**对 RT-01 的影响**:
- `leader` 模式的 step-by-step 增量验证（outline → step N → integration）有坚实的实验依据。
- `early stop`（连续 2 CHALLENGED）能有效节省无效计算。

---

### [6] "AOrchestra: Sub-agent Orchestration Framework" (2026-02)
**arXiv**: 2602.03786

**核心发现**:
- 在 Terminal-Bench 2.0 上，专业化子 agent 编排（task decomposition + specialized roles）比通用单 agent 提升约 12%。
- 编排收益主要来自角色专业化（不同 agent 承担不同能力），而非数量本身。

**对 RT-01 的影响**:
- `leader` 中的 "leader proxy 执行" + "verifier 独立推导" 角色分工有实证支持。
- 但过度复杂的编排（>3 角色）在 HEP 推导任务中无实质收益，应保持 2–3 角色。

---

### [7] "BOAD: Hierarchical Multi-Agent SWE Approach" (2025-12, rev. 2026-01)
**arXiv**: 2512.23631

**核心发现**:
- 层级化 agent（上层管理 idea pool，下层执行具体任务）显著降低重复探索率。
- idea pool 的结构化表示（带 claim + falsifiability score）比自由文本 idea list 更有效去重。

**对 RT-04 的影响**:
- `INNOVATION_LOG.md` 的纯文本表示不足以支撑 idea-generator 的去重逻辑。
- breakthrough lead 应映射到 `idea_card_v1` 的结构化字段（`thesis_statement`, `claims`, `testable_hypotheses`）才能支持 Elo/BFTS 排序。
- `--idea-source` 注入应使用 JSON 结构（`seed_pack_v1` 或直接 `idea_card_v1` 列表），而非 Markdown 文本注入。

---

## 第二部分：Agent 间自由辩论（MAD）的评估

> **背景**: 本节评估 Multi-Agent Debate (MAD)——agent 交换完整答案后争论对错——这一特定交互形式。结论：**MAD 有害，应拒绝**。
> 注意：本节的结论仅适用于自由辩论，不适用于结构化协作（见 §第四部分）。

### [8] "Debate or Vote: Which Yields Better Decisions in Multi-Agent LLMs?" (NeurIPS 2025 Spotlight)
**OpenReview**: iUjGNJzrF1

**核心发现**:
- 将 Multi-Agent Debate (MAD) 分解为 Majority Voting 和 inter-agent Debate 两个组件，跨 7 个 NLP 基准系统评估各自贡献。
- **关键结论：Majority Voting 单独就能解释 MAD 的绝大部分性能提升；Debate 单独并不改善期望正确率。**
- inter-agent 通信本身不带来收益，但引入额外的 sycophancy 风险。

**对本项目架构的意义**:
- 现有设计（独立并行输出 → 聚合判定）已经等价于 Majority Voting，是多 agent 收益的真正来源。
- 引入 A2A 通信不会带来额外收益，反而引入 sycophancy 问题。

---

### [9] "Can LLM Agents Really Debate?" (2025-11)
**arXiv**: 2511.07784

**核心发现**:
- 系统评估表明，LLM agent 在 debate 中表现出明显的 **sycophancy**（顺从偏差）：看到对方立场后，agent 倾向于同意而非独立推理。
- 真正的 debate（批判性推理 + 立场分歧）在当前 LLM 中难以稳定实现。

**对本项目架构的意义**:
- 若引入 A2A 通信，Member B 看到 Member A 的输出后，独立验证的价值大幅下降。
- 现有 clean-room 隔离（Member A 与 Member B 互不见对方输出）是防 sycophancy 的有效设计。

---

### [10] "CONSENSAGENT: Towards Efficient and Effective Consensus in Multi-Agent LLM Interactions Through Sycophancy Mitigation" (ACL 2025)
**ACL Anthology**: 2025.findings-acl.1141

**核心发现**:
- Sycophancy 是限制 multi-agent debate 效率和准确性的核心问题；agents 相互强化错误答案，导致需要更多 debate 轮次才能收敛。
- CONSENSAGENT 提出动态 prompt 优化缓解 sycophancy，达到 SOTA 基准表现。
- **修复 sycophancy 的本质是让 agent 在通信中更像独立判断**——即退化回独立验证。

**对本项目架构的意义**:
- 缓解 sycophancy 的努力本质上是重建独立性，而本项目原生设计已提供更强的独立性保证（clean-room + 跨 provider）。

---

### [11] "When Identity Skews Debate: Anonymization for Bias-Reduced Multi-Agent Reasoning" (2025-10)
**arXiv**: 2510.07517

**核心发现**:
- Agent-to-agent 通信引入两种身份偏差：Sycophancy（过度跟随对方）和 Self-bias（过度坚持自身先前输出）。
- 缓解方案：匿名化 agent 身份（去除"这是我的输出"/"这是对方的输出"标记）。
- **修复后的系统本质上等价于独立验证**：agent 不知道输出来自谁，退化为对内容本身的独立判断。

**对本项目架构的意义**:
- 本项目的独立验证设计（无身份标记、无共享 context）天然规避了身份偏差。
- 这进一步确认：在 A2A 通信系统中花大量工程工作"修复偏差"，不如一开始就使用独立验证设计。

---

### [12] "Auditing Multi-Agent LLM Reasoning Trees Outperforms Majority Vote and LLM-as-Judge" (2026-02)
**arXiv**: 2602.09341

**核心发现**:
- 提出 AgentAuditor + ACPO 训练策略，专门对抗 majority-cue sycophancy（审判者被多数意见影响）。
- 即使是 LLM-as-Judge 本身也受 sycophancy 影响，需要专门训练才能保持独立性。

**对本项目架构的意义**:
- 进一步支持 convergence gate 使用**确定性解析**而非 LLM judge 的决策（[4] 的补充证据）。
- "专门训练的 auditor"路线工程成本极高，不适合本项目的 agile 定位。

---

## 第三部分：HEP + LLM 现有发表工作

> **背景**: 本节记录 HEP 领域 LLM 相关的已发表论文，用于评估本项目的潜在发表空间与差异化定位。

### [13] "Automating High Energy Physics Data Analysis with LLM-Powered Agents" (ML4PS @ NeurIPS 2025)
**arXiv**: 2512.07785

**概述**: 以 Higgs 玻色子双光子截面测量（ATLAS Open Data）为案例，用 LLM-based supervisor-coder agent + Snakemake 工作流管理器实现 HEP 数据分析自动化。基准测试覆盖 GPT-5 系列、Claude 系列、Gemini 系列和主流开源模型。

**与本项目的差异**:
- 聚焦**数据分析/代码生成**，非理论推导验证
- 单 agent + 工作流管理器架构，无独立验证机制
- 不涉及跨 provider 独立性

---

### [14] Multi-Agent System with Verification Roles for HEP Anomaly Detection (2025-09)
**arXiv**: 2509.08535

**概述**: Researcher + Coder + Code Reviewer + Logic Reviewer 四 agent 架构，应用于 LHC Olympics 数据集异常检测，最优方案达到人类 SOTA 水平。

**实际架构（经原文核实）**:
- **全部 OpenAI**：论文 §3.3 明确写道 "this comparison will be restricted to high-performing models from OpenAI"，测试模型为 GPT-4o、o4-mini、GPT-4.1、GPT-5，**无跨 provider 设计**
- **A2A 串行链**：Researcher 通过 `handoff_to_coder` 工具调用 Coder，Coder 的输出再传给 Reviewer——即后一个 agent 始终能看到前一个 agent 的输出
- **同 provider sycophancy 风险**：Reviewer 看到 Coder 已完成的代码后，倾向于认可（共享训练偏好 + 可见上下文双重加强 sycophancy）
- 比较维度是不同 OpenAI 模型间的**性能差异**（稳定性/成本/准确率），而非验证独立性

**与本项目的差异**:

| 维度 | [14] | 本项目 |
|------|------|--------|
| Provider | 全 OpenAI（同质） | 跨 provider（异构，通过 RT-03 runner 层） |
| Agent 通信 | A2A 串行链（handoff 工具传递上下文） | 完全隔离（clean-room，Member A/B 互不见输出） |
| 独立性保证 | 无——共享 provider 训练偏好 + A2A 上下文 | 有——不同 provider RLHF 天然隔离 + 并行无交叉 |
| 验证任务 | 数据分析/代码生成（运行 Python 脚本） | 理论推导验证（数学推导、Feynman 图） |
| Convergence | 无 gate 机制 | 确定性结构化解析 gate（`check_team_convergence.py`） |
| Sycophancy | 有且未处理 | clean-room 隔离天然防止，asymmetric 盲化进一步强化 |

---

### [15] "HEPTAPOD: Orchestrating High Energy Physics Workflows Towards Autonomous Agency" (2025-12)
**arXiv**: 2512.15867 | Fermilab-Pub-25-0923

**概述**: HEP 工作流编排框架，LLM 作为工作流协调者调用领域专用工具，强调 human-in-the-loop 和 schema 校验操作，支持模拟、数据分析等常规任务。

**与本项目的差异**:
- 工具编排导向，非理论推导验证
- 无独立验证/收敛判定机制
- human-in-loop 粒度粗（无步骤级验证）

---

### [16] "GRACE: an Agentic AI for Particle Physics Experiment Design and Simulation" (2026-02)
**arXiv**: 2602.15039

**概述**: 面向实验设计和核/高能物理探测器配置的 simulation-native agent，多后端支持（Claude/GPT/Ollama），对探测器配置推理和物理约束验证。

**与本项目的差异**:
- 实验设计侧（探测器几何、模拟），非**理论计算**验证
- 无 multi-agent 独立验证机制

---

### 本项目的差异化空间

综合 [13]–[16]，现有 HEP + LLM 论文的共同盲区：

| 维度 | 现有工作 | 本项目独有 |
|------|---------|---------|
| 任务类型 | 数据分析、代码生成、工作流编排、实验设计 | **理论推导验证**（Feynman 图、重整化、微扰展开） |
| 验证机制 | 无，或同 provider A2A 串行链（[14]） | **跨 provider 独立并行验证** + 结构化收敛 gate |
| Provider 独立性 | 全部限于单一 provider（[14] 明确仅 OpenAI） | 多 provider 天然训练数据/RLHF 隔离 |
| 验证模式分类 | 无 | peer / leader / asymmetric 三模式 + 适用场景矩阵 |
| Sycophancy 应对 | 未处理（[14] A2A 链直接传递上下文） | clean-room 隔离天然防止，asymmetric 盲化强化 |
| Convergence gate | 无（结果由单 agent 或人工判断） | 确定性结构化解析（`check_team_convergence.py`） |

**关键对比（[14] vs 本项目）**：

[14] 的架构本质是"同一个聪明人扮演多个角色"——四个 agent 全部来自 OpenAI，通过 `handoff_to_coder` 工具串行传递上下文，Reviewer 看到 Coder 的完整输出后给出反馈。这与 NeurIPS 2025 Spotlight [8] 批评的"debate without real independence"是同一类问题。

本项目的架构是"来自不同学派的专家独立鉴定"——跨 provider 天然训练隔离 + clean-room 无共享上下文 + 并行独立输出，正是 [8] 指出的 Majority Voting 最优路径。

**潜在论文核心假设**（已升级，见 §第六部分 发表策略）：
> 在 multi-agent LLM 验证任务中，存在一类"半渗透"通信架构——按消息的语义内容类型（而非来源角色或正确性）决定渗透率——其验证准确率高于完全隔离（因方法对齐减少 trivial 分歧）且高于完全通信/debate（因结论不泄露消除 sycophancy 触发源）。

---

## 第四部分：自由辩论 vs 结构化协作的关键区分（2026-03-02 修订）

> **背景**: 上述 §第二部分 [8]–[12] 的结论专门针对 Multi-Agent Debate (MAD) 这一特定交互形式——"交换完整答案后争论对错"。
> 但人类科研中的交流模式根本不是 debate。研究组内的日常协作——方法讨论、文献分享、约定对齐、定向求助——
> 不破坏验证独立性，反而提高研究质量和效率。本节区分两种交互模式，并引入"结构化协作"设计。

### [17] "Exploring Communication Strategies for Collaborative LLM Agents in Mathematical Problem-Solving" (AIED 2025)
**arXiv**: 2507.17753

**核心发现**:
- 系统对比四种 dual-agent 交互模式：teacher-student (52.33%)、peer-to-peer collaboration (**54.10%**)、reciprocal peer teaching (51.95%)、critical debate (52.76%)；单 agent 基线 47.43%。
- **Peer-to-peer collaboration（共享中间结果 + 交叉验证）准确率最高且标准误差最低 (SE=3.91)**，比 debate 更好、更稳定。
- 对话行为分析表明：statements (S)、acknowledgment (ACK)、hints (H) 是协作推理中最关键的对话行为。

**对本项目的意义**:
- 直接反驳"所有 A2A 通信都有害"的过度泛化。peer-to-peer collaboration ≠ debate。
- 关键区分：sharing intermediate results（分享中间过程）≠ arguing about final answers（争论最终答案）。
- 为 Phase 0 (Method Alignment) 和 Phase 2 (Targeted Consultation) 提供实验依据。

---

### [18] "Talk Isn't Always Cheap: Understanding Failure Modes in Multi-Agent Debate" (ICML MAS Workshop 2025)
**arXiv**: 2509.05396

**核心发现**:
- Debate 可导致准确率随轮次**下降**——即使能力更强的模型占多数。
- 模型在看到 peer 推理后频繁从正确答案转向错误答案，倾向于同意而非质疑。
- 这些失败模式来自 sycophancy、social conformity 和 model/task type 的交互。

**对本项目的意义**:
- 进一步确认自由辩论（MAD）的有害性——[8] 的补充证据。
- 但注意：此论文测试的也是 debate（交换完整答案后争论），不是 structured collaboration（分享方法建议）。
- 本项目应拒绝 debate，但不应因此拒绝所有形式的 agent 间交流。

---

### [19] "On the Resilience of LLM-Based Multi-Agent Collaboration with Faulty Agents" (OpenReview 2025)
**OpenReview**: bkiM54QftZ

**核心发现**:
- 层级化结构 A→(B↔C) 在含错误 agent 场景下 resilience 最优（性能下降仅 5.5%）。
- Challenger（质疑机制）和 Inspector（审查 agent）可恢复 96.4% 的错误。

**对本项目的意义**:
- 层级化结构化协作 > 自由辩论 > 完全隔离（在 resilience 维度）。
- Inspector 角色可类比为 Phase 2 中的信息屏障过滤器。

---

### 两种 A2A 交互模式的对比

| 维度 | 自由辩论（MAD） | 结构化协作 |
|------|----------------|-----------|
| 信息流 | 交换**完整答案**，争论对错 | 交换**方法、困惑、参考文献**，不暴露结论 |
| 目的 | 说服对方接受自己的结论 | 解决具体困难、拓展思路、对齐约定 |
| 独立性影响 | 严重破坏（看到完整答案后必然受影响）| 增强（方法启发不等于结论泄露）|
| 人类类比 | 两人各写完论文后互相批判 | 走廊讨论"这个积分你会怎么处理？" |
| sycophancy 风险 | 高（[8][9][18]） | 低（问的是 HOW 不是 WHAT）|
| SOTA 证据 | 有害（[8][9][10][11][18]） | 有益（[17] peer-to-peer > debate）|

### Semi-permeable Clean Room（半渗透洁净室）

> **新概念（2026-03-02）**: 本项目提出的第三条路径——既非完全隔离，也非自由通信。

现有 SOTA 仅有两个极端：完全隔离（[8] 推荐）和完全通信（[8]–[12] 批评）。
CONSENSAGENT [10] 的"动态 prompt 优化"本质上是在修补 debate 的 sycophancy，而非重新设计信息流。

**Information Membrane（信息膜）**: 类比生物膜的选择性通透，不同类型的信息有不同渗透率。

| 信息类型 | 渗透率 | 示例 | 理由 |
|---------|--------|------|------|
| 方法建议 | **PASS** | "建议用 Gauss-Kronrod 而非 trapz" | 不泄露结论值 |
| 文献指引 | **PASS** | "见 [Smith 2023] eq.(3.14) 的处理" | 指引方向但不暴露答案 |
| 约定选择 | **PASS** | "我用 $\overline{MS}$ scheme" | 对齐前提，减少 trivial 分歧 |
| 陷阱警告 | **PASS** | "注意 $m\to 0$ 的 IR 发散" | 帮助避免浪费时间在已知陷阱上 |
| 收敛判据 | **PASS** | "grid refinement 是必要的" | 提高验证质量 |
| 数值结果 | **BLOCK** | "我算出来是 3.14159" | 直接泄露结论 → sycophancy |
| 完整推导 | **BLOCK** | "我的推导过程是 A → B → C" | 暴露推导路径 → 丧失独立性 |
| 判定结论 | **BLOCK** | "我认为正确答案是 Y" | 直接触发 sycophancy |
| 代码输出 | **BLOCK** | "运行结果表明..." | 间接泄露结论 |
| 同意声明 | **BLOCK** | "我同意你的结果" | debate 核心失败模式 |

**关键创新**: 渗透率按**内容类型**定义，而非按阶段或角色——使系统行为可预测、可审计。

### 五阶段协作模型

```
Phase 0: Method Alignment（方法对齐，新增）
  ├── 双方收到：问题描述 + 文献清单（不含已知答案）
  ├── 各自独立输出：建议的方法路径、约定选择、预期难点
  ├── 编排器：编译为 Method Landscape 注入后续 packet
  └── 信息膜：PASS 方法/约定/文献；BLOCK 结论预判

Phase 1: Independent Work（独立工作，现有 clean-room，不变）
  ├── 完全隔离，互不见对方工作进展
  └── 输出：各自的推导报告 + 代码实现

Phase 2: Targeted Consultation（定向咨询，新增，可选）
  ├── 触发条件：member 在报告中标记 FLAG/UNCERTAIN
  ├── 格式：结构化 Q&A（非自由讨论）
  │   ├── 问题必须是 HOW 类型（"你怎么处理 branch cut？"）
  │   ├── 不得是 WHAT 类型（"你的结果是多少？"）
  │   └── 编排器自动过滤（Information Membrane）
  └── 信息膜：PASS 方法建议/文献指引；BLOCK 数值结果/完整推导

Phase 3: Independent Completion（独立完成，回到 clean-room）
  ├── 基于 Phase 2 的方法启发独立修正+完成
  └── 完全隔离

Phase 4: Convergence Gate（现有确定性解析，不变）

Phase 5: Divergence Resolution（分歧解决，原"有限 A2A"扩展）
  ├── 将双方 CHALLENGED 理由互相可见
  └── 各自独立修正后重新进入 Phase 4
```

---

## 适用场景矩阵（2026-03-02 修订）

| 场景 | 推荐模式 | 协作类型 | 理由 |
|------|---------|---------|------|
| 宽泛证据审核、文献 review | `peer` | Phase 0 only | 方法对齐有价值；验证阶段保持独立 |
| 多步数学推导（>3 步）| `leader` | Phase 0 + Phase 2 | 方法对齐 + 遇到困难时定向咨询；验证独立性由信息膜保证 |
| 争议 claim / 关键步骤独立验证 | `asymmetric` | Phase 0 only | asymmetric 的盲化与 Phase 2 冲突；仅允许预对齐 |
| 简单单步 QA | `peer` | 无 | leader/asymmetric 无额外收益，协作成本不值得 |
| 收敛失败后的争议解决 | `leader`/`peer` | Phase 5 | CHALLENGED 理由互相可见；各自独立修正 |
| 方法选择分歧（算法/scheme）| `leader` | Phase 0 重点 | 方法对齐是核心价值——避免 trapz vs Gauss-Kronrod 级别的 trivial 分歧 |

---

## 设计决策记录

| 决策 | 结论 | 依据 |
|------|------|------|
| `peer` 作为同质 provider 场景的默认 | **适用** | [1][2] |
| **`leader` 作为 research-team 主流程的默认** | **修订（2026-03-02）** | 见 §架构差异说明 |
| convergence gate 使用确定性解析，不用 LLM judge | **保持** | [4][12] |
| `asymmetric` 隐藏 leader 结果 | **保持** | [3][11] |
| RT-04 使用结构化 JSON 而非文本注入 | **新增约束** | [7] |
| `leader` early stop: 连续 2 CHALLENGED | **保持** | [5] |
| step-level verification 优于 result-level | **新增约束（leader 模式必须逐步）** | [5] |
| ~~不引入 A2A 通信框架~~ | ~~确认不引入~~ | ~~[8][9][10][11]~~ |
| **拒绝自由辩论（MAD）** | **确认拒绝（2026-03-02 修订）** | [8][9][10][11][18] |
| **引入结构化协作（Semi-permeable Clean Room）** | **新增（2026-03-02）** | [17][19] + 科研实践类比 |
| **Information Membrane：方法可共享，结论不可共享** | **新增约束（2026-03-02）** | 对 [8] sycophancy 的工程缓解 |
| **clean-room 用于验证阶段（Phase 1/3），不用于全流程** | **修订（2026-03-02）** | [8][17] |

---

## 架构差异说明（2026-03-02）

### SOTA 文献场景 vs 本项目架构

上述 SOTA 文献（[1][2]）的"单 agent vs 多 agent"对比假设的是**同质 provider 内**的 agent 编排（如 OpenAI 内部多 agent）。

本项目的 research-team 是**跨 provider 异构 ensemble**（通过 RT-03 runner 层配置，见 `meta/REDESIGN_PLAN.md` §RT-03）：
- team leader：主推导 provider（通过 `--member-a-runner` + `--member-a-api-base-url` 配置）
- team members：独立验证 provider（通过 `--member-b-runner` 配置，可接不同 provider）

| 维度 | SOTA 文献场景 | 本项目架构 |
|------|-------------|----------|
| Provider 独立性 | 共享底层模型 / RLHF 偏好 | 通过 runner 层配置为不同 provider，训练数据/偏好相互独立 |
| 角色对称性 | peer（对等）是常见设置 | leader（主推导）+ members（独立验证）是实际使用模式 |
| 知识盲化 | 需人工隐藏 | 跨 provider 天然隔离（无 shared context） |
| 能力互补 | 有限（同质模型） | 可利用不同 provider 的能力差异（推理 vs 细节 vs 宽泛检索） |

**`leader` 默认的结论**：对于跨 provider 异构 ensemble + 有明确 leader 角色的场景，`leader` 模式比 `peer` 更匹配实际语义。`peer` 保留用于纯对等场景（如两个 reviewer 无需 leader 的 review-swarm 场景）。**`research_team_config.json` 中 `workflow_mode` 字段的默认值应为 `leader`**。

### research-team 的实际运行机制（2026-03-02 修订）

当前每个 member 是一次**单轮 LLM 调用**（非有记忆的 agentic loop）。规划中的五阶段模型（RT-05）将引入多轮调用，但每轮仍是独立的 LLM 调用，不使用 A2A 消息传递框架：

```
run_team_cycle.sh（当前）
├── Member A → bash run_claude.sh / run_openai_compat.sh  [独立子进程]
│              system prompt + packet → one-shot response → member_a_report.md
│
└── Member B → bash run_gemini.sh / run_claude.sh / run_openai_compat.sh  [独立子进程]
               system prompt + packet → one-shot response → member_b_report.md
               （packet_only 模式：与 Member A 并行运行，互相完全隔离）

协调层: check_team_convergence.py（确定性解析，非 LLM judge）
```

```
run_team_cycle.sh（规划：RT-05 Semi-permeable Clean Room）
├── Phase 0: Method Alignment
│   ├── Member A → alignment prompt → method_a.md
│   ├── Member B → alignment prompt → method_b.md
│   └── compile_method_landscape.py → method_landscape.md [信息膜过滤]
│
├── Phase 1: Independent Work（现有 clean-room，不变）
│   ├── Member A → work packet + landscape → member_a_report.md
│   └── Member B → work packet + landscape → member_b_report.md
│
├── Phase 2: Targeted Consultation（可选，FLAG 触发）
│   ├── extract_consultation_flags.py → questions_a.json, questions_b.json
│   ├── filter_consultation_response.py [信息膜过滤]
│   └── 各自收到经过滤的咨询答复
│
├── Phase 3: Independent Completion（clean-room）
│   ├── Member A → revision packet + consultation → member_a_final.md
│   └── Member B → revision packet + consultation → member_b_final.md
│
└── Phase 4/5: Convergence Gate + Divergence Resolution（现有，增强）
```

关键区别于 AutoGen/LangGraph 的 A2A 消息传递：
- **不使用 agent 间直接通信**——所有信息流经编排器的 Information Membrane
- **不使用 shared memory / shared context**——每轮调用都是独立的 one-shot
- **不使用 debate / argumentation 协议**——Phase 2 是结构化 Q&A，不是辩论

---

## 第五部分：新颖性分析 — Information Membrane 与先行研究的关系（2026-03-02）

> **背景**: 本节系统对比 Semi-permeable Clean Room + Information Membrane 与现有最接近先行研究的关系，
> 明确哪些要素确实新颖、哪些有部分先例，为发表策略提供依据。
> 调研覆盖 10+ 组搜索，涵盖：信息论通信约束、内容类型过滤、访问控制/信息屏障、通信拓扑、推理路径共享、
> 生物膜类比在 AI 中的应用等维度。

### 最接近的先行研究（按相关度排序）

#### [PA-1] MetaGPT (ICLR 2024) — 角色订阅过滤

**arXiv**: 2308.00352

**机制**: 全局共享消息池 + 角色按 profile 订阅相关信息。角色只接收与自身职责相关的消息，避免信息过载。
结构化输出（文档/图表），非自由文本对话。

**与 Information Membrane 的差异**:
- MetaGPT 按 **WHO**（角色需要什么）过滤；Information Membrane 按 **WHAT**（消息的语义内容类型）过滤
- MetaGPT 不区分"方法建议"和"数值结果"——同一角色的所有输出同等可见
- MetaGPT 的目标是效率（避免信息过载）；Information Membrane 的目标是独立性保护（防 sycophancy）
- MetaGPT 的过滤是全有或全无（订阅则全可见）；Information Membrane 是同一来源的输出按内容类型部分通过

---

#### [PA-2] "Voting or Consensus?" (ACL Findings 2025) — All-Agents Drafting

**arXiv**: 2502.19130

**机制**: 提出 All-Agents Drafting (AAD)——每个 agent 先独立起草初始方案，再进入互动。
Collective Improvement (CI) 通过迭代精炼结构化协作，防止过度通信导致答案趋同。

**与 Information Membrane 的差异**:
- AAD 是 debate 框架内的**单步前置**（独立起草 → 进入辩论），不是多阶段模型
- 没有 content-type 分类——进入辩论后信息无过滤，完整答案仍然可见
- CI 控制的是**通信轮次**（何时停止），不是**通信内容**（什么可以说）
- 无 Phase 2 定向咨询机制
- **最接近要素**: AAD 的"独立起草"与 Phase 0 "Method Alignment" 的独立性保证精神一致

---

#### [PA-3] "Collaborative Memory" (2025-05) — 动态访问控制

**arXiv**: 2505.18279

**机制**: Private/shared 双层记忆，细粒度读写策略 + 双向访问图。
每个记忆片段携带不可变 provenance 属性，支持回溯权限检查。
自称"第一个显式处理细粒度访问不对称性的多 agent、多用户记忆共享框架"。

**与 Information Membrane 的差异**:
- Collaborative Memory 面向**记忆管理**（谁能读哪些历史记录）；Information Membrane 面向**实时通信过滤**
- 区分依据是"属于哪个 user 的记忆"（来源/所有权）；Information Membrane 区分的是"方法建议还是数值结论"（语义类型）
- 无 sycophancy 防护目标——不涉及验证独立性
- **最接近要素**: 细粒度访问控制的理念和 provenance 追踪与 Information Membrane 的可审计性共享设计哲学

---

#### [PA-4] Communication Topology (EMNLP 2025) — 稀疏性抑制错误传播

**arXiv**: 2505.23352

**机制**: 提出 EIB-Learner，通过 GNN 模拟 agent 通信，融合稀疏视图（抑制错误传播）和稠密视图（放大有益洞察）
生成最优通信拓扑。适度稀疏的拓扑在错误抑制和有益信息扩散之间取得最优平衡。

**与 Information Membrane 的差异**:
- 拓扑控制 **agent 间的连接**（谁和谁能通信）；Information Membrane 控制 **消息内容**（什么类型的信息可通过）
- 拓扑对每条连接是全通或全断；Information Membrane 对同一连接上的不同消息做选择性通过
- **正交互补**: 拓扑优化和内容过滤可叠加使用——先由拓扑决定连接，再由 Membrane 过滤通过该连接的内容

---

#### [PA-5] SagaLLM (VLDB 2025) — 验证门控消息传递

**机制**: 全局验证 agent 在消息传递前检查合同一致性、依赖满足、跨 agent 一致性、时序正确性。
验证失败则阻止消息传递。

**与 Information Membrane 的差异**:
- SagaLLM 验证消息的**正确性/一致性**（"这个输出合不合规"）；Information Membrane 过滤消息的**语义类型**（"这是方法建议还是结论"）
- SagaLLM 是 pass/reject 门控（整条消息通过或拒绝）；Information Membrane 是内容选择性通过（同一消息中方法部分通过，结论部分 redact）
- **最接近要素**: "验证门控"理念——在消息传递前施加中间层处理

---

#### [PA-6] CONSENSAGENT (ACL 2025) — Sycophancy 缓解

**ACL Anthology**: 2025.findings-acl.1141

**机制**: 动态 prompt 优化——检测 sycophancy 信号后调整 agent prompt，鼓励独立判断。
在 debate 框架内工作，不修改信息流架构。

**与 Information Membrane 的差异**:
- CONSENSAGENT 在 debate 框架**内部**修补 sycophancy；Information Membrane 在架构层面**消除** sycophancy 触发源
- CONSENSAGENT 的 agent 仍能看到对方完整答案；Information Membrane 确保结论不可见
- **关键类比**: CONSENSAGENT 是"给病人吃药"；Information Membrane 是"消除病原体"

---

#### [PA-7] Response Anonymization (2025-10) — 身份匿名化

**arXiv**: 2510.07517

**机制**: 去除 agent 身份标记（"这是我的输出"/"这是对方的输出"），
使 agent 基于内容本身而非来源身份做判断，减少 sycophancy 和 self-bias。

**与 Information Membrane 的差异**:
- 匿名化去除的是 **WHO said it**；Information Membrane 过滤的是 **WHAT was said**
- 匿名化后 agent 仍能看到完整答案（只是不知道谁说的）；Information Membrane 确保结论本身不可见
- **正交互补**: 在 Phase 5（Divergence Resolution）中可叠加使用——共享 CHALLENGED 理由时匿名化来源

---

### 确实新颖的五个要素

| # | 创新点 | 现有最近先行研究 | 本质差异 |
|---|--------|----------------|---------|
| **N1** | **按内容语义类型过滤**（方法 PASS, 结论 BLOCK） | MetaGPT 按角色过滤 [PA-1]；SagaLLM 按正确性验证 [PA-5] | 首次按内容的**语义类别**决定信息渗透率，而非来源/角色/正确性 |
| **N2** | **多阶段渗透率模型**（Phase 0→1→2→3→4/5 各阶段不同规则） | AAD 是 debate 内的单步前置 [PA-2] | 首个完整的多阶段模型，每阶段有明确的渗透率规则 |
| **N3** | **生物膜类比应用于 agent 通信** | 所有"membrane"+"AI"搜索结果为物理膜工程 | 首次将选择性渗透概念从生物学借用到 multi-agent LLM 架构 |
| **N4** | **反 sycophancy 同时保留协作收益的第三条路径** | 完全隔离（丢失协作）vs 自由通信（引入 sycophancy） | 首次在同一框架内解决 isolation-collaboration trade-off |
| **N5** | **科学验证域的 HOW/WHAT 语义区分** | 无 HEP/科学验证领域的 agent 通信过滤研究 | 首次形式化"方法建议"与"结论泄露"在科学验证中的分类标准 |

### 有部分先例的要素

| 要素 | 先例来源 | 本项目的增量 |
|------|---------|------------|
| 独立起草阶段 | AAD [PA-2] | Phase 0 聚焦方法而非解题，输出经信息膜过滤 |
| 细粒度访问控制 | Collaborative Memory [PA-3] | 按语义类型而非所有权；面向实时通信而非记忆管理 |
| 稀疏通信抑制错误 | EIB-Learner [PA-4] | 内容级过滤而非连接级；可与拓扑优化正交叠加 |
| 消息门控/验证 | SagaLLM [PA-5] | 语义类型过滤而非正确性验证；部分通过而非全通/全拒 |
| Sycophancy 缓解 | CONSENSAGENT [PA-6], Anonymization [PA-7] | 架构层面消除触发源，而非事后修补 |

### 新颖性定级

**结论**: Semi-permeable Clean Room + Information Membrane 是对多个独立研究线索的 **新型综合（novel synthesis）**，
提出了一个此前不存在的 **第三条架构路径**。

- **现有两极**: 完全隔离 vs 完全通信（含 debate）
- **第三极（本项目）**: 按语义内容类型的选择性渗透

在调研覆盖的所有文献中，没有任何一篇论文提出过"按内容语义类型（method/result/convention/pitfall vs conclusion/numerical_value/full_derivation）
决定 agent 间信息流渗透率"的架构。搜索"semi-permeable" + "agent" + "communication" 返回的全部是物理膜工程论文——
没有人在 multi-agent LLM 领域使用过这个类比。

**发表价值**: 足以支撑独立论文（不必绑定 HEP 场景），同时 HEP 应用提供差异化的实验验证平台。详见 §第六部分。

---

## 第六部分：发表策略（2026-03-02）

> **背景**: 本节基于 §第三部分（HEP + LLM 差异化空间）和 §第五部分（新颖性分析）制定具体发表策略。
> 目标：建立优先权 + 在合适层级验收。

### 论文定位矩阵

Semi-permeable Clean Room 可支撑两篇独立论文，面向不同社区：

| 论文 | 核心贡献 | 目标社区 | 独立性 |
|------|---------|---------|--------|
| **Paper A: 方法论文** | Information Membrane 架构 + 实验验证 | Multi-Agent LLM (NLP/AI) | 独立于 HEP |
| **Paper B: 应用论文** | 跨 provider 独立验证在 HEP 理论推导上的效果 | HEP + AI (ML4PS) | 引用 Paper A |

### Paper A: Information Membrane — 方法论文

**标题方向**: "Semi-permeable Clean Room: Content-Type Selective Information Barriers for Multi-Agent Verification"

**核心 claim**:
> 在 multi-agent LLM 验证任务中，存在一类"半渗透"通信架构——按消息的语义内容类型（而非来源角色或正确性）
> 决定渗透率——其验证准确率高于完全隔离（因方法对齐减少 trivial 分歧）且高于完全通信/debate
>（因结论不泄露消除 sycophancy 触发源）。

**创新叙事（Introduction 架构）**:
1. **问题**: Multi-agent verification 面临 isolation-collaboration dilemma——完全隔离丢失人类科研中的协作收益，自由通信引入 sycophancy
2. **已有方案的局限**: [PA-6] 事后修补 sycophancy（有效但治标）；[PA-7] 匿名化身份（不过滤内容）；[PA-2] 独立起草（单步，不覆盖全流程）
3. **我们的洞察**: 人类科研组的讨论模式天然区分 HOW（方法讨论）和 WHAT（结论交换）——前者增强质量，后者破坏独立性
4. **Solution**: Information Membrane——按语义内容类型定义渗透率的中间层架构
5. **贡献**: (a) 形式化定义；(b) 五阶段协作模型；(c) 在数学推理 + 科学验证任务上的实验验证

**实验设计**:

| 配置 | 代号 | 描述 |
|------|------|------|
| Single-agent | `SA` | 基线，单个 LLM 独立完成 |
| Full isolation | `ISO` | 双 agent 完全隔离 + convergence gate（现有架构） |
| Membrane Phase 0 only | `MEM-0` | 仅 Method Alignment → 独立工作 → convergence |
| Membrane Phase 0+2 | `MEM-02` | 完整五阶段（包含 Targeted Consultation） |
| Full debate (MAD) | `MAD` | 交换完整答案后多轮辩论（对照组，复现 [8] 设置） |
| Role-filtered (MetaGPT-style) | `ROLE` | 按角色订阅过滤，不按内容类型（ablation） |
| Anonymized debate | `ANON` | 匿名化辩论（对照 [PA-7]） |

**指标**:

| 指标 | 定义 | 核心假设 |
|------|------|---------|
| 校准准确率 | 正确判定正确/错误推导的比例 | MEM-02 > ISO > MAD |
| 假阳性率 | 错误推导被判为正确 | MEM-02 < MAD < ISO |
| 方法多样性 | 双方使用不同方法路径的比例 | MEM-0 > ISO（因方法对齐启发） |
| Trivial 一致率 | 双方选同一 trivial 验证点 | MEM-0 << ISO（因 Phase 0 避免） |
| Token 效率 | 每次正确判定的平均 token 消耗 | MEM-02 ≈ ISO < MAD |
| Sycophancy 率 | Agent 在看到对方信息后改变正确判断 | MEM-02 ≈ ISO << MAD |

**数据集**: 分两类
1. **数学推理** (通用): GSM8K hard / MATH-500 / competition math — 可直接比较 [PA-2] 的 AAD/CI 结果
2. **科学验证** (域特异): 30–50 道 HEP theory benchmark（圈图计算、RG 方程、教材级振幅），Ground truth 来自 PDG/教科书

**跨 provider 子实验**:
- Same-provider: Claude × Claude, GPT × GPT
- Cross-provider: Claude × GPT, Claude × Gemini
- 预期: 跨 provider 的 Membrane 效果 > 同 provider 的 Membrane 效果（训练隔离叠加内容过滤）

**投稿路径**:

| 优先级 | 场所 | 截止日 | 理由 |
|--------|------|--------|------|
| 1 | arXiv 预印本 | ASAP（实验完成后） | 建立优先权；可在论文正文引用 semi-permeable clean room 概念 |
| 2 | EMNLP 2026 | ~6 月 | NLP 主会，systems track 或 findings；[PA-4] 发表于 EMNLP 2025 |
| 3 | NeurIPS 2026 | ~5 月 | 更广泛 ML 社区；Agent/MAS track 越来越多 |
| 备选 | COLM 2026 | ~4 月 | LLM 专属会议，systems/eval 友好 |
| 备选 | ACL 2026 Findings | ~1 月（已过） | 如时间线合适则投 ACL 2027 |

### Paper B: HEP 应用论文

**标题方向**: "Cross-Provider Independent Verification of Theoretical Physics Derivations with LLM Agents"

**核心贡献**:
- HEP theory benchmark dataset（首个面向 LLM 验证的理论物理题目集）
- 跨 provider 异构 ensemble 在 HEP 推导验证上的系统评估
- 域特异发现：哪类 HEP 推导最受益于方法对齐 / 定向咨询

**投稿路径**:

| 优先级 | 场所 | 截止日 | 理由 |
|--------|------|--------|------|
| 1 | ML4PS @ NeurIPS 2026 | ~9 月 | [13] 就在此发表，社区匹配度最高 |
| 2 | AI4Science @ ICML 2026 | ~5–6 月 | 覆盖更广的科学领域 |
| 备选 | ML4Physical Sciences (独立会议) | TBD | 关注该社区 2026 动态 |

### 论文间的依赖关系

```
Paper A (方法论文)
├── 实验需要: Information Membrane V1 实现 (RT-05)
├── 实验需要: HEP benchmark dataset (Paper B 共用)
├── 实验需要: 通用数学推理 benchmark (GSM8K/MATH)
├── 可独立发表: 不依赖 Paper B
│
Paper B (应用论文)
├── 引用 Paper A 的方法和结果
├── 聚焦 HEP 域特异性发现
├── 需要: HEP benchmark dataset
└── 需要: RT-01 (三模式工作流) 已实现
```

### 时间线

```
2026-03:  RT-01 实现（三模式工作流）
2026-04:  RT-05 实现（Information Membrane V1）
2026-04:  HEP benchmark dataset 构建开始
2026-05:  通用数学推理实验（Paper A 初步数据）
2026-06:  HEP 验证实验（Paper A + B 数据）
2026-06:  Paper A 初稿 → arXiv 预印本
2026-07:  Paper A 投 EMNLP 2026 或 NeurIPS 2026
2026-08:  Paper B 初稿 → arXiv 预印本
2026-09:  Paper B 投 ML4PS @ NeurIPS 2026
```

---

## 第七部分：Information Membrane 详细设计（2026-03-02）

> **背景**: 本节是 RT-05 的工程详细设计，作为实施提示词的基础。
> 目标：足够详细以直接指导实现，同时保留论文 Methods 节的素材价值。

### 7.1 内容分类体系（Content Taxonomy）

Information Membrane 的核心是一个**内容分类器**：给定一段文本，判断其属于哪种语义类型，
然后按类型决定渗透率。

#### PASS 类型（安全共享，不破坏验证独立性）

| 类型代号 | 名称 | 定义 | 典型示例 | 理由 |
|----------|------|------|---------|------|
| `METHOD` | 方法建议 | 算法/技术推荐，不含具体结果 | "建议用 Gauss-Kronrod 而非 trapz" | 方法选择 ≠ 结论值 |
| `REFERENCE` | 文献指引 | 论文引用、方程引用、章节指引 | "见 [Smith 2023] eq.(3.14) 的处理" | 指引方向但不暴露答案 |
| `CONVENTION` | 约定选择 | 记号/方案/规范化条件 | "我用 $\overline{MS}$ scheme, $\mu = m_Z$" | 对齐前提，减少 trivial 分歧 |
| `PITFALL` | 陷阱警告 | 已知数学/物理陷阱的提醒 | "注意 $m\to 0$ 的 IR 发散" | 帮助避免无效工作 |
| `CRITERION` | 质量判据 | 数值收敛性/精度标准 | "grid refinement 是必要的" | 提高验证质量 |
| `TOOL` | 工具推荐 | 软件/库的推荐 | "scipy.integrate.quad 比 trapz 更可靠" | 实现建议 ≠ 结果泄露 |
| `ASSUMPTION` | 假设声明 | 所用前提/近似 | "我假设 $m_q \ll \Lambda_{QCD}$" | 前提对齐减少无效分歧 |

#### BLOCK 类型（必须阻止，会触发 sycophancy 或破坏独立性）

| 类型代号 | 名称 | 定义 | 典型示例 | 理由 |
|----------|------|------|---------|------|
| `NUM_RESULT` | 数值结果 | 任何具体数值 | "我算出 $\sigma = 42.7$ pb" | 直接泄露结论 |
| `SYM_RESULT` | 符号结果 | 最终解析表达式 | "$\Gamma = \alpha^2 m / 4$" | 泄露推导终点 |
| `DERIV_CHAIN` | 推导链 | 步骤序列 | "由 A 得 B，代入得 C，因此 D" | 暴露推导路径 |
| `VERDICT` | 判定结论 | 对正确性的判断 | "我认为答案是 Y" | 直接触发 sycophancy |
| `CODE_OUTPUT` | 代码输出 | 程序执行结果 | "运行代码得到..." | 间接泄露结论 |
| `AGREEMENT` | 同意声明 | 表示认同对方 | "我同意你的结果" | debate 核心失败模式 [8][9] |
| `COMPARISON` | 比较声明 | 引用对方工作的相对描述 | "我的结果和你的一致" | 间接泄露 + 趋同信号 |

#### 分类决策规则

```
对于任意文本段 T:
1. 如果 T 包含任何 BLOCK 类型的信号 → BLOCK（保守优先）
2. 如果 T 仅包含 PASS 类型的信号 → PASS
3. 如果 T 无法确定 → BLOCK（ambiguous → 保守）
4. 混合内容（同一段包含 METHOD + NUM_RESULT）→ 尝试分句级处理：
   a. 识别 BLOCK 子句 → 替换为 [REDACTED — contains <类型>]
   b. 保留 PASS 子句
   c. 如果无法可靠分割 → 整段 BLOCK
```

**关键原则**: **BLOCK 优先于 PASS**。宁可过滤掉有用的方法建议，也不能泄露一个数值结果。
假阳性（有用内容被误 BLOCK）的代价远小于假阴性（结论泄露导致 sycophancy）。

### 7.2 Information Membrane V1 实现（Rule-based）

V1 使用**纯规则**（正则表达式 + 关键词匹配），不依赖 LLM 分类器。理由：
- 确定性：同一输入始终同一结果，可审计
- 无二阶 sycophancy 风险：LLM 分类器本身可能受内容影响产生偏差
- 速度：毫秒级处理，不引入 API 调用延迟

#### BLOCK 检测规则

```python
# 1. 数值结果检测
NUMERIC_PATTERNS = [
    r'=\s*-?[\d.]+(?:\s*[×x]\s*10\s*\^?\s*[+-]?\d+)?',  # = 3.14, = 2.5e-3
    r'≈\s*-?[\d.]+',                                       # ≈ 3.14
    r'(?:result|answer|value|output)\s+(?:is|=|:)\s+',     # "result is ..."
    r'(?:I\s+(?:get|obtain|find|calculate|compute))\s+',    # "I get ..."
    r'(?:gives?|yields?|returns?|produces?)\s+[\d.$\\]',    # "gives 3.14", "yields $\sigma$"
]

# 2. 符号结果检测（最终表达式赋值）
SYMBOLIC_PATTERNS = [
    r'(?:therefore|thus|hence|so)\s+\$[^$]+\$\s*=',        # "therefore $\Gamma$ ="
    r'(?:final|main)\s+(?:result|expression|answer)',        # "final result"
]

# 3. 推导链检测
DERIVATION_MARKERS = [
    r'(?:Step\s+\d+:.*→)',                                  # "Step 1: ... →"
    r'(?:→.*→.*→)',                                         # chain of arrows
    r'(?:substitut(?:e|ing).*(?:get|obtain|find))',         # "substituting ... we get"
]

# 4. 判定/同意检测
VERDICT_PATTERNS = [
    r'(?:I\s+(?:agree|disagree|think|believe|conclude))',
    r'(?:correct|incorrect|wrong|right|matches|consistent)',
    r'(?:my\s+(?:result|answer|calculation)\s+(?:matches|agrees|is consistent))',
    r'(?:CONFIRMED|CHALLENGED)',                            # verdict markers
]
```

#### PASS 检测规则

```python
PASS_INDICATORS = {
    'METHOD': [
        r'(?:suggest|recommend|consider|try|use)\s+(?:using|method|algorithm|approach)',
        r'(?:Gauss-Kronrod|adaptive|Monte Carlo|Vegas|quad|RK45)',  # specific methods
    ],
    'REFERENCE': [
        r'\[[\w\s]+\d{4}\]',                               # [Author 2023]
        r'(?:see|cf\.?|following|refer to)\s+(?:eq|Eq|equation|section|§)',
        r'(?:arXiv|doi|Rev\.\s+\w+|Phys\.\s+Lett)',
    ],
    'CONVENTION': [
        r'(?:I\s+use|my\s+convention|in\s+the\s+\w+\s+scheme)',
        r'(?:MS-bar|overline\{MS\}|on-shell|dimensional\s+reg)',
    ],
    'PITFALL': [
        r'(?:watch\s+out|be\s+careful|note\s+that|beware|caution)',
        r'(?:divergen(?:ce|t)|singular(?:ity)?|branch\s+cut|pole)',
    ],
    'CRITERION': [
        r'(?:convergence|precision|accuracy|tolerance|grid\s+refin)',
        r'(?:significant\s+(?:digits?|figures?))',
    ],
}
```

#### 处理流程

```python
def filter_message(text: str) -> FilterResult:
    """
    返回:
        FilterResult(
            passed_text: str,        # 可安全传递的内容
            blocked_spans: list,     # 被 BLOCK 的片段 + 类型
            classification: dict,    # 每段的分类详情
            audit_log: list,         # 完整决策日志（可审计）
        )
    """
    segments = split_into_segments(text)  # 按段落/句子分割
    result = FilterResult()

    for seg in segments:
        block_signals = detect_block_signals(seg)
        pass_signals = detect_pass_signals(seg)

        if block_signals:
            # BLOCK 优先
            result.blocked_spans.append(BlockedSpan(
                original=seg,
                block_type=block_signals[0].type,
                replacement=f"[REDACTED — contains {block_signals[0].type}]",
            ))
            result.passed_text += result.blocked_spans[-1].replacement + "\n"
        else:
            result.passed_text += seg + "\n"

        result.audit_log.append(AuditEntry(
            segment=seg[:100],  # 截断供审计
            block_signals=block_signals,
            pass_signals=pass_signals,
            decision="BLOCK" if block_signals else "PASS",
        ))

    return result
```

### 7.3 Phase 0: Method Alignment 详细设计

**输入**:
- 问题描述（从 team packet 提取）
- 文献清单（从 packet 提取，不含已知答案）
- System prompt: `assets/system_alignment.txt`

**System prompt 核心指令**:
```
You are in the Method Alignment phase. Your task is NOT to solve the problem,
but to plan HOW you would solve it.

OUTPUT (structured Markdown):
## Suggested Method Path
- Primary approach: ...
- Alternative approach (if applicable): ...

## Convention Choices
- Renormalization scheme: ...
- Regularization method: ...
- Other relevant conventions: ...

## Expected Difficulties
- Potential pitfalls: ...
- Tricky integrals/limits: ...

## Relevant Literature
- Key references: ...

CONSTRAINTS:
- DO NOT compute any numerical values
- DO NOT derive any results or intermediate expressions
- DO NOT express opinions about what the answer should be
- Focus exclusively on HOW, never on WHAT
```

**`compile_method_landscape.py` 处理流程**:

```
输入: method_a.md, method_b.md
├── 1. 对每份输出应用 Information Membrane
│     ├── 过滤掉任何 BLOCK 内容（如果 member 违反指令提前计算）
│     └── 保留 PASS 内容
│
├── 2. 结构化合并
│     ├── "Suggested Methods" section:
│     │     ├── "Member A suggests: ..." (filtered)
│     │     └── "Member B suggests: ..." (filtered)
│     │
│     ├── "Common Conventions" section:
│     │     └── 提取两者共同的约定选择（intersection）
│     │
│     ├── "Divergent Choices" section:
│     │     └── 两者不同的约定/方法（需注意但不构成错误）
│     │
│     └── "Combined Pitfall Warnings" section:
│           └── 两者提到的所有潜在困难（union）
│
└── 输出: method_landscape.md
```

**`method_landscape.md` 注入 Phase 1 packet**: 作为额外 section 附在 team packet 末尾:
```markdown
## Method Landscape (from Phase 0 Alignment)

> This section contains method suggestions from both team members.
> It is provided to help you choose an approach, NOT to constrain your derivation.
> You MUST still derive all results independently.

[method_landscape.md content]
```

### 7.4 Phase 2: Targeted Consultation 详细设计

**触发条件**: `extract_consultation_flags.py` 从 Phase 1 报告中检测 FLAG/UNCERTAIN 标记。

**FLAG 标记规范**（在 member system prompt 中要求）:
```markdown
<!-- FLAG: UNCERTAIN — 对 branch cut 处理不确定 -->
<!-- FLAG: METHOD_QUESTION — 不确定哪种积分方法更适合此类被积函数 -->
<!-- FLAG: CONVENTION_MISMATCH — 不确定对方是否用了同样的规范化 -->
```

**`extract_consultation_flags.py` 处理流程**:
```
输入: member_a_report.md, member_b_report.md
├── 1. 正则扫描 <!-- FLAG: ... --> 标记
├── 2. 提取 flag_type 和 context
├── 3. 生成结构化问题（HOW 类型）
│     ├── 验证: 问题不含 "what is your result" 等 WHAT 模式
│     └── 拒绝: 任何请求对方结果的问题
├── 4. 输出: questions_a.json, questions_b.json
│
无 FLAG → 跳过 Phase 2，直接进 Phase 3（= Phase 1 报告即为 final）
```

**`questions_a.json` schema**:
```json
{
  "member": "A",
  "questions": [
    {
      "flag_type": "UNCERTAIN",
      "context": "branch cut handling in the loop integral",
      "question": "How would you handle the branch cut at z=0 in this type of integral?",
      "source_line": 42
    }
  ]
}
```

**咨询执行**: Member B 收到 A 的问题（反之亦然），在独立 LLM 调用中回答。
System prompt: `assets/system_consultation.txt`:
```
You are answering a targeted consultation question from your team member.
They are asking about METHOD (how to do something), not RESULT (what the answer is).

CONSTRAINTS:
- Answer ONLY the methodological question asked
- DO NOT reveal any of your numerical results
- DO NOT reveal your final expressions or derivation chain
- DO NOT comment on whether their approach is "right" or "wrong"
- Focus on technique, algorithm choice, and mathematical strategy
```

**Response 过滤**: `filter_consultation_response.py` 对回答应用 Information Membrane。
任何 BLOCK 内容替换为 `[REDACTED — consultation response contained <类型>, filtered by Information Membrane]`。

### 7.5 Phase 5: Divergence Resolution 详细设计

**触发**: Phase 4 convergence gate 判定 NOT_CONVERGED 且至少一方有 CHALLENGED verdict。

**信息共享规则**:
```
共享内容（渗透率 PASS for Phase 5 only）:
- CHALLENGED 的理由文本（为什么认为某步错误）
- 具体 challenge 的步骤号/位置

不共享内容（仍然 BLOCK）:
- 各自的完整报告
- 各自的数值结果
- 各自的推导链
```

**处理流程**:
```
1. 从 member_a_report.md 提取所有 CHALLENGED verdict + 理由
2. 从 member_b_report.md 提取所有 CHALLENGED verdict + 理由
3. 应用 Information Membrane 过滤理由文本
4. 生成 divergence_packet_for_a.md (含 B 的 filtered challenge reasons)
5. 生成 divergence_packet_for_b.md (含 A 的 filtered challenge reasons)
6. 各自独立修正 → 重新提交 → Phase 4
```

**匿名化（可选，叠加 [PA-7]）**: Phase 5 共享 challenge 理由时可去除来源标记（"A challenge" → "A team member challenges"），减少身份偏差。

### 7.6 与 RT-01 三模式工作流的集成矩阵

| 工作流模式 | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|-----------|---------|---------|---------|---------|---------|---------|
| `peer` | 可选 | 并行独立 | 可选 | 并行独立 | convergence gate | divergence resolution |
| `leader` | 可选 | leader 推导 + verifier 独立验证 | 可选 | 各自独立完成 | step-level gate | CHALLENGED 理由共享 |
| `asymmetric` | 可选（仅 Phase 0） | leader 推导 + verifier blind 验证 | **禁用** | blind 完成 | critical_steps gate | 仅非 critical 步骤的理由共享 |

**asymmetric 的限制**: Phase 2 与 asymmetric 的盲化机制冲突——咨询回答可能间接泄露 leader 在 critical_steps 上的方向。
因此 asymmetric 模式下 Phase 2 硬禁用，仅允许 Phase 0（方法对齐在推导前发生，不涉及具体步骤结论）。

### 7.7 审计与可追溯性

**每次 Membrane 操作生成审计日志**:

```json
{
  "timestamp": "2026-03-15T14:30:00Z",
  "phase": "phase_0",
  "source_member": "A",
  "target_member": "B",
  "input_hash": "sha256:abc123...",
  "segments_total": 12,
  "segments_passed": 9,
  "segments_blocked": 3,
  "blocked_details": [
    {"type": "NUM_RESULT", "pattern_matched": "=\\s*3\\.14", "line": 7},
    {"type": "VERDICT", "pattern_matched": "I think the answer", "line": 15},
    {"type": "SYM_RESULT", "pattern_matched": "therefore.*=", "line": 23}
  ],
  "membrane_version": "v1_rule_based"
}
```

**日志存储**: `<run_dir>/membrane_audit/phase_{N}_{source}_{target}.jsonl`

**论文价值**: 审计日志提供完整的信息流记录，可用于：
- 实验中分析 BLOCK 率（哪些 Phase/配置的 BLOCK 最频繁）
- 验证 Membrane 的假阳性率（被 BLOCK 的内容中有多少实际是 PASS 类型）
- 可复现性（给定输入 + Membrane 版本 → 确定性输出）

### 7.8 Information Membrane V2 路线图（规划，不在 Batch 4/5 实施）

V2 增加**可选的 LLM 分类器辅助**，用于处理 V1 规则难以覆盖的模糊边界情况：

```
V1 规则检测 → 明确 BLOCK/PASS → 直接决定
V1 规则检测 → 无法确定（ambiguous）→ V2 LLM 分类器 → BLOCK/PASS
```

**V2 约束**:
- 分类器**必须**使用不同于 Member A/B 的模型（避免关联偏差）
- 分类器只做二分类（BLOCK/PASS），不参与内容生成
- 分类结果写入审计日志
- V2 是可选增强，V1 规则始终保留作为 fallback

### 7.9 文件结构与估计

```
skills/research-team/
├── assets/
│   ├── system_alignment.txt           (新, ~50 行)    Phase 0 system prompt
│   ├── system_consultation.txt        (新, ~40 行)    Phase 2 system prompt
│   └── system_divergence.txt          (新, ~30 行)    Phase 5 system prompt
├── scripts/
│   ├── bin/
│   │   ├── compile_method_landscape.py    (新, ~150 行)  Phase 0 编译器
│   │   ├── extract_consultation_flags.py  (新, ~120 行)  Phase 2 FLAG 解析
│   │   └── filter_consultation_response.py (新, ~80 行)  Phase 2 Membrane 应用
│   └── lib/
│       └── information_membrane.py        (新, ~300 行)  Membrane V1 核心
├── tests/
│   ├── test_information_membrane.py       (新, ~200 行)  Membrane 单元测试
│   ├── test_method_landscape.py           (新, ~100 行)  Phase 0 测试
│   └── test_consultation_flags.py         (新, ~80 行)   Phase 2 测试
└── run_team_cycle.sh                      (改, +~200 行) 阶段编排逻辑

总计: ~1350 行新代码 + ~200 行改动
```

### 7.10 渐进启用策略

```
Level 0: --collaboration-phases 1          (默认, 等价于现有 RT-01 行为)
Level 1: --collaboration-phases 0,1        (仅 Method Alignment, 低成本高价值)
Level 2: --collaboration-phases 0,1,2,3    (完整五阶段, 含 Targeted Consultation)
Level 3: --collaboration-phases 0,1,2,3,5  (含 Divergence Resolution)
```

**推荐默认升级路径**: 先在 Level 1 积累经验（Phase 0 成本低，价值可观测），
确认 Method Landscape 质量后升级到 Level 2。Level 3 仅在频繁遇到 convergence 失败时启用。

### 7.11 与 Batch 4 的集成关系

RT-05（Information Membrane）是独立于 Batch 4 的后续实施项，但 Batch 4 的改进为 RT-05 奠定了基础：

| Batch 4 改动 | 为 RT-05 准备了什么 |
|-------------|-------------------|
| 改动 1 (角色分工) | A/B 职责分化 → Phase 0 Method Alignment 的种子：A 报告方法论偏好，B 报告数值方法偏好 |
| 改动 2 (强制不同量) | 验证目标多样性 → Phase 1 独立工作的质量基线 |
| 改动 3 (blind numerics) | 结论隐藏机制 → 等价于 BLOCK 类消息过滤的朴素版本 |
| RT-01 asymmetric | redaction 基础设施 → `filter_message()` 的原型 |
| sidecar 自动触发 | artifact 自动检测 → content classification 的早期信号 |

**实施顺序**: Batch 4（RT-01 + RT-04 + 改动 1-3）→ Batch 5+（RT-05 Information Membrane）→ 实验（Paper A 数据收集）

### 7.12 改动 4（N-version Programming）延后分析

改动 4（独立代码实现 + 静态审查 + 选优执行）在设计讨论中被分析为有价值但成本过高，延后到 RT-05 之后：

**核心价值**: 两个 member 用不同算法独立实现同一计算，静态互审后选优执行。
等价于 N-version programming + pass@k/select 策略。

**延后原因**:
1. `packet_only` 模式下 member 无法测试代码，写出的代码只能做静态比较
2. 需要多阶段编排（并行写 → 静态审 → gate → 执行），当前 `run_team_cycle.sh` 不支持
3. RT-05 Information Membrane 的 Phase 0 (Method Alignment) 是改动 4 的天然前置——
   如果两个 member 未对齐算法选择空间，独立实现可能用了等价的方法（而非真正不同的方法）

**未来路径**: RT-06 或 Batch 6+，在 RT-01 + RT-05 成熟后实施。
可与 `full_access` 模式（member 可执行代码）结合，此时独立实现+运行+比较数值一致性的完整流程才有意义。
