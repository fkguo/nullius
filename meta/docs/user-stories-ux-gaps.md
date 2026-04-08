# User Stories & UX Gap Analysis

> 版本: 0.1.0-draft (2026-02-22)
> 状态: 历史讨论草稿；未自动升格为当前公开 authority
> 背景: 基于当时 REDESIGN_PLAN 草案的使用体验分析；其中对 plan item / 计数的引用现在只按历史上下文理解

---

## 目的

当时 REDESIGN_PLAN 草案中的 107 项规划从实现角度定义了"建什么"，但缺少从用户/agent
视角出发的端到端使用叙事。本文档通过 user story 检验规划的完整性，
识别使用体验层面的缺口，并提出补充建议。

---

## US-01: 理论物理博士生的首次完整研究

### 角色
张三，理论物理博士生，熟悉 QFT 但不熟悉编程框架。通过 Claude Code 交互。

### 场景
张三想计算 Higgs → γγ 在 SMEFT 框架下的 one-loop correction，
从文献调研到论文输出。

### 期望流程

```
张三: "我想研究 h→γγ 在 SMEFT 下的 one-loop 修正"

── 阶段 1: 选题与规划 ──

Agent:
  1. 调用 idea-core campaign.init 建立研究 campaign
  2. search.step + eval.run 探索研究空间
  3. 生成 IdeaCard: thesis, hypotheses, compute_plan
  4. 展示给张三: "我找到了以下研究方向，推荐 X，理由是..."
     → [A0 GATE] 张三审批 idea

── 阶段 2: 文献与基础 ──

Agent:
  5. hep_project_create 建立 MCP 项目
  6. inspire_search + zotero_add 搜集文献
     → [A1 GATE] 张三审批文献检索范围
  7. hep_project_build_evidence 构建证据库
  8. 向张三展示文献综述摘要

── 阶段 3: 推导与计算 ──

Agent (research-team):
  9. Member A (Claude) + Member B (Gemini) 各自独立推导
  10. 生成 research_notebook.md: 完整推导过程
      → 张三可随时阅读，理解推导逻辑
  11. 生成 computation/ 目录:
      - mathematica/feynman_diagrams.wl (FeynArts 驱动)
      - mathematica/one_loop_amplitude.wl (FeynCalc 符号计算)
      - julia/loop_integrals.jl (数值积分)
      - manifest.json (运行顺序 + 依赖)
      → [A2 GATE] 张三审批代码
  12. hep-calc 执行计算
      → [A3 GATE] 张三审批计算参数
  13. Convergence gate: 两个 Member 的结果是否一致
  14. 结果写回 research_notebook.md:
      - 解析结果 (公式)
      - 数值结果 (表格 + 图)
      - 交叉验证 (已知极限比对)

── 阶段 4: 论文写作 ──

Agent:
  15. 从 research_notebook + evidence 自动构建论文大纲
  16. 逐节撰写 (hep_run_writing_* 管线)
      → [A4 GATE] 张三审批论文内容
  17. hep_export_paper_scaffold → paper/ 目录
      → 张三: 打开 paper/main.tex，用 LaTeX 编辑器查看

── 阶段 5: 审稿与修订 ──

Agent:
  18. referee-review skill 生成模拟审稿意见
  19. paper-reviser 根据意见修订
      → 产生 paper_v2/ (tracked changes + diff)
      → [A5 GATE] 张三审批最终结论
  20. 如需进一步修改 → paper_v3/ ...
```

### 当前覆盖情况

| 步骤 | PLAN 覆盖 | 缺口 |
|---|---|---|
| 1-3 idea-core | ✅ EVO-01 (Phase 5), idea-core engine | idea-core 目前仅有 RPC schema，无可运行实现 |
| 4 展示 idea | ❌ | 无标准的 idea 展示格式给人类 |
| 5-6 MCP 项目 | ✅ hep_project_create, inspire_search | |
| 7-8 evidence | ✅ hep_project_build_evidence | |
| 9-10 推导 | ⚠️ research-team 输出 Draft_Derivation.md | 格式不适合人类阅读 (见 GAP-01) |
| 11 计算代码 | ❌ | 无结构化代码输出目录 (见 GAP-02) |
| 12 hep-calc | ✅ hep-calc skill | 与 research-team 的衔接无标准化 |
| 13 convergence | ✅ research-team convergence gate | |
| 14 结果展示 | ⚠️ evidence/*.md, artifacts/*.png | 散落，无统一结果视图 (见 GAP-03) |
| 15-16 论文写作 | ✅ writing pipeline (~20 tools) | 工具过多 (NEW-06 Phase 3 整合) |
| 17 论文输出 | ✅ hep_export_paper_scaffold | 但从未在实际项目中完整运行 |
| 18 审稿 | ✅ referee-review skill | |
| 19 修订 | ✅ paper-reviser skill | 无 v2/v3 版本追踪 (见 GAP-04) |
| 20 迭代 | ❌ | 审稿→修订→再审稿循环无自动化 (见 GAP-05) |

---

## US-02: Agent 自主执行一轮完整研究 (无人值守)

### 角色
Autoresearch Agent (Claude Code)，在 `full_auto` approval policy 下运行。

### 场景
Agent 收到 IdeaCard (已通过 A0)，需要自主完成从文献到论文的全流程。

### 期望行为

```
输入: IdeaCard (thesis + compute_plan + claims)
输出: paper_scaffold.zip + research_notebook.md + computation/ + integrity_report

Agent 内部决策流:

1. 查询 orch_policy_query: "A1 mass_search 是否需要审批?"
   → policy 返回: auto_approve (full_auto mode)

2. 执行文献检索 (INSPIRE/Zotero/PDG)
   → 写入 evidence pool

3. 规划计算:
   - 读取 IdeaCard.minimal_compute_plan
   - 选择工具: FeynArts (图) + FeynCalc (振幅) + LoopTools (数值)
   - 生成 computation/manifest.json

4. 执行 research-team cycle:
   - Member A/B 独立推导
   - Convergence gate 检查
   - 失败 → 自动 rerun (M0-r2, M0-r3)
   - 成功 → research_notebook.md 更新

5. 执行 hep-calc:
   - 消费 computation/manifest.json
   - 产出 artifacts/runs/<TAG>/

6. 诚信检查 (EVO-06):
   - param_bias_checker: 参数选择偏见?
   - approx_validator: 近似适用范围?
   - novelty_verifier: 是否已知结果?
   - cross_check: Ward 恒等式验证
   → 生成 integrity_report

7. 写作:
   - 从 notebook + evidence + artifacts 构建论文
   - RDI gate: integrity_report 无 blocking 项才允许 publish

8. 自审稿 + 修订:
   - referee-review → review.json
   - paper-reviser → paper_v2
   - 再次 referee-review → 如果 READY，完成

9. 记录进化信号:
   - ResearchEvent 流 → EVO-18 信号引擎
   - 成功/失败策略 → EVO-20 Memory Graph
   - 可复用模式 → EVO-12a 技能提案
```

### 当前覆盖情况

| 步骤 | PLAN 覆盖 | Agent 自主性缺口 |
|---|---|---|
| 1 policy 查询 | ❌ | 无运行时策略查询接口 (见 GAP-06) |
| 2 文献 | ✅ | |
| 3 计算规划 | ⚠️ EVO-01 package_selector | 无 manifest.json 标准 (见 GAP-02) |
| 4 research-team | ✅ | |
| 5 hep-calc | ✅ | 与 manifest.json 的衔接待定 (见 GAP-02) |
| 6 诚信 | ✅ EVO-06 | |
| 7 写作 | ✅ | 工具调用顺序依赖 skill 自然语言 (见 GAP-07) |
| 8 审稿循环 | ❌ | 无自动 review→revise 循环 (见 GAP-05) |
| 9 进化信号 | ✅ EVO-17/18/20 | |

---

## US-03: 人类审阅 Agent 产出的研究结果

### 角色
张三 (同 US-01)，Agent 完成了一轮计算，张三需要检查结果是否正确。

### 场景
Agent 报告"one-loop 计算完成"，张三需要验证推导和数值结果。

### 期望体验

```
张三: "给我看计算结果"

Agent 展示 (结构化视图):

━━━ 研究笔记 (research_notebook.md) ━━━

## 1. 推导过程

从 SMEFT Lagrangian 出发:
  $\mathcal{L}_{SMEFT} = \mathcal{L}_{SM} + \sum_i \frac{C_i}{\Lambda^2} O_i$

[完整推导链，无跳步，每步有物理解释]

...经过 Feynman 参数化和 dim-reg 后得到:
  $$\Gamma(h\to\gamma\gamma) = \frac{\alpha^2 m_h^3}{256\pi^3 v^2} |A_{SM} + A_{SMEFT}|^2$$

## 2. 数值结果

| Wilson 系数 | 分支比修正 (%) | 不确定度 |
|---|---|---|
| $C_{HB}$ = 1.0 | +3.2 | ±0.1 (数值) |
| $C_{HW}$ = 1.0 | +5.7 | ±0.2 (数值) |
| $C_{HWB}$ = 1.0 | -1.4 | ±0.1 (数值) |

## 3. 交叉验证

| 验证项 | 结果 | 状态 |
|---|---|---|
| SM 极限 ($C_i → 0$) | 与 PDG 值偏差 < 0.01% | ✅ |
| Ward 恒等式 | 满足至 $10^{-12}$ | ✅ |
| 文献比对 (arXiv:2103.XXXXX) | 偏差 < 1% | ✅ |

## 4. 图表

[图: Wilson 系数 vs 分支比修正 — 嵌入 PNG/SVG]
[图: 参数扫描热力图]

━━━ 计算代码 ━━━

computation/
├── mathematica/one_loop_amplitude.wl    ← 符号计算 (可在 Mathematica 中打开)
├── julia/numerical_scan.jl              ← 数值扫描 (Julia 1.10+)
└── manifest.json                        ← 运行说明

━━━ 机器验证 ━━━

integrity_report: 全部通过 (4/4 checks)
reproducibility: 一键重跑命令: `julia numerical_scan.jl --config scan_config.json`
```

### 当前覆盖情况

| 需求 | 现状 | 缺口 |
|---|---|---|
| 完整推导 | Draft_Derivation.md (机器格式) | 不适合人类阅读 (GAP-01) |
| 数值结果表格 | evidence/*.md (散落) | 无统一视图 (GAP-03) |
| 交叉验证 | EVO-06 integrity checks | 结果不在 notebook 中展示 |
| 图表 | artifacts/*.png (散落) | 不嵌入 notebook (GAP-03) |
| 计算代码 | 无结构化目录 | GAP-02 |
| 一键重跑 | REPRO_CAPSULE 有命令 | 但在 Draft_Derivation 中，非独立入口 |

---

## 识别的设计缺口 (GAP)

### GAP-01: 人类可读研究笔记

**现状**: Draft_Derivation.md 同时承担"研究笔记"和"机器 contract"两个角色，
格式被 REPRO_CAPSULE、tier tags、headline 格式等机器约束主导，人类阅读体验差。

**建议**: 分离为两个文档:
- `research_notebook.md` — 人类可读的叙事性研究笔记
  - 自由的 LaTeX 公式 (不受 Markdown 数学卫生规则限制)
  - 嵌入图表和数值结果
  - 物理直觉和推导动机的叙述
  - 引用计算代码和 artifacts
- `Draft_Derivation.md` — 降级为纯机器 contract
  - REPRO_CAPSULE, headlines, tier tags
  - 从 notebook + artifacts 自动提取/生成

**影响范围**:
- research-team skill: Member A/B 输出写入 notebook，gate 检查器从 notebook 提取 contract
- hep-autoresearch context_pack.py: 改为读取 notebook (人类编辑入口) + contract (机器检查入口)
- w3_revision.py: 从 contract (而非 notebook) 提取 headlines
- 建议 Phase: 1 (与 NEW-06 工具整合同期)

### GAP-02: 结构化计算代码目录

**现状**: 计算代码散落在 research-team 的 Markdown 输出中，不可直接运行。
hep-calc 可执行计算但其输入/输出与 research-team 无标准化衔接。

**建议**: 定义标准 `computation/` 目录结构:
```
computation/
├── manifest.json              ← 代码清单 + 运行顺序 + 依赖 + 工具要求
├── mathematica/               ← Wolfram Language 脚本
│   └── *.wl
├── python/                    ← Python 脚本 (SymPy, pySecDec 等)
│   └── *.py
├── julia/                     ← Julia 脚本 (LoopTools.jl 等)
│   └── *.jl
└── configs/                   ← 参数配置文件
    └── *.json / *.yaml
```

`manifest.json` schema:
```json
{
  "steps": [
    {
      "id": "feynman_diagrams",
      "tool": "mathematica",
      "script": "mathematica/feynman_diagrams.wl",
      "depends_on": [],
      "expected_outputs": ["diagrams.pdf", "diagrams.m"]
    }
  ],
  "environment": {
    "mathematica": ">=13.0",
    "julia": ">=1.10"
  }
}
```

**衔接**:
- research-team 产出代码时写入 `computation/` 而非 Markdown 代码块
- hep-calc 消费 `manifest.json` 执行计算
- EVO-01 package_selector 生成 manifest

**建议 Phase**: 2 (依赖 EVO-01 的计算类型枚举)

### GAP-03: 统一结果展示

**现状**: 数值结果、图表、交叉验证结果散落在 evidence/*.md、artifacts/*.png、
各种 .json 中。人类无法在一个地方看到所有结果。

**建议**: research_notebook.md (GAP-01) 承担此职责:
- 推导结果 (公式) 直接写在 notebook 中
- 数值结果 (表格) 直接写在 notebook 中
- 图表: 以相对路径引用 `![](artifacts/runs/<TAG>/figure.png)`
- 交叉验证: 从 EVO-06 integrity_report 提取摘要写入 notebook

**不另建新文档** — notebook 就是人类的"结果总览"。

### GAP-04: 论文版本追踪

**现状**: 论文修订无 v1/v2/v3 版本追踪。paper-reviser 产出 original.tex → clean.tex + diff，
但无持久化版本链。

**建议**: 定义论文版本目录结构:
```
paper/
├── v1/                        ← 初稿
│   ├── main.tex
│   ├── sections/
│   └── paper_manifest.json
├── v2/                        ← 修订稿 (响应审稿意见)
│   ├── main.tex
│   ├── sections/
│   ├── changes_v1_to_v2.diff
│   ├── tracked_changes.tex    ← latexdiff 产出
│   └── paper_manifest.json
├── review/
│   ├── review_v1.json         ← referee-review 对 v1 的意见
│   └── review_v2.json         ← referee-review 对 v2 的意见
└── response/
    └── response_to_review_v1.tex  ← 逐条回复审稿意见
```

**建议 Phase**: 3 (与 NEW-06 写作管线整合同期)

### GAP-05: 审稿→修订自动循环

**现状**: referee-review 和 paper-reviser 是独立 skill，之间无自动衔接。
人类需要手动触发: 审稿 → 看意见 → 触发修订 → 再审稿。

**建议**: 定义 `review_cycle` 编排协议:
1. referee-review → review.json (VERDICT + evidence_requests)
2. 如有 evidence_requests → 自动执行证据补充
3. paper-reviser → paper_v(N+1) (consume review.json)
4. referee-review → review_v(N+1).json
5. 如果 VERDICT = READY → 完成
6. 如果 VERDICT = NOT_READY 且 N < max_rounds → 回到步骤 3
7. 如果 N >= max_rounds → 人类介入

**建议 Phase**: 5 (EVO-01/02/03 端到端自动化的一部分)

### GAP-06: Agent 运行时策略查询

**现状**: Agent 不知道当前 approval policy 是什么。需要猜测或硬编码行为。
NEW-R15 定义了 orch_run_* 工具但无 policy 查询。

**建议**: 扩展 NEW-R15，增加:
- `orch_policy_query(action, context)` → 返回是否需要审批 + 历史先例
- Agent 可在运行时动态调整行为

**建议 Phase**: 2 (与 NEW-R15-impl 同期)

### GAP-07: 结构化工具编排 recipe

**现状**: Agent 依赖自然语言 skill (SKILL.md) 理解工具调用顺序。
不同 agent (Claude/Codex/Gemini) 对 skill 的理解可能不一致。

**建议**: 定义 `workflow_recipe_v1.schema.json`:
```json
{
  "id": "literature_to_evidence",
  "steps": [
    {"tool": "inspire_search", "params_template": {...}},
    {"tool": "hep_project_build_evidence", "depends_on": ["inspire_search"]},
    {"gate": "A1", "on_reject": "stop"}
  ]
}
```

Agent 加载 recipe 文件 (机器可读) 而非解析 SKILL.md (自然语言)。

**建议 Phase**: 3 (与 NEW-06 同期，作为工具整合的补充)

### GAP-08: 延迟脚手架生成

**现状**: research-team `scaffold_research_workflow.sh` 默认创建 ~20+ 文件，
包括 INNOVATION_LOG.md、knowledge_graph README、多个 prompt 文件等。
很多在项目初期用不到。虽有 `--minimal` 和 `prune_optional_scaffold.py`，
但默认行为仍是全量生成。

**建议**: 反转默认行为:
- 默认 = minimal (仅核心 5 文件: CHARTER, PLAN, NOTEBOOK, AGENTS, .mcp.json)
- 按需生成: 当 research-team cycle 首次运行时自动补充 prompts/ + team config
- 当 KB 首次使用时自动补充 knowledge_base/ 结构
- 当计算首次执行时自动补充 computation/ 结构

**保留** `--full` 选项供需要完整脚手架的场景。

**建议 Phase**: 1

### GAP-09: 研究会话入口协议

**现状**: 107 项规划中没有定义"人类用户第一次打开 Claude Code 时应该看到什么"。
用户不知道从哪里开始，不知道有哪些 skill 可用，不知道典型流程是什么。

**建议**: 定义 `session_protocol_v1`:
- 用户首次输入研究意图时，agent 自动展示流程概览
- 明确当前所处阶段 (选题/文献/计算/写作/修订)
- 展示可用操作和推荐下一步
- 不是代码实现——是 agent 行为规范 (类似 AGENTS.md 但面向用户交互)

**建议 Phase**: 1

---

## 优先级排序

| GAP | Phase | 理由 |
|---|---|---|
| GAP-09 会话入口协议 | 1 | 不需要代码，定义 agent 行为规范即可 |
| GAP-01 研究笔记分离 | 1 | 直接改善人类最常接触的文档 |
| GAP-08 延迟脚手架 | 1 | 减少初始认知负担 |
| GAP-06 策略查询 | 2 | 与 NEW-R15 同期 |
| GAP-02 计算代码目录 | 2 | 依赖 EVO-01 计算类型枚举 |
| GAP-03 统一结果展示 | 2 | 依赖 GAP-01 notebook |
| GAP-07 编排 recipe | 3 | 与 NEW-06 同期 |
| GAP-04 论文版本追踪 | 3 | 与写作管线整合同期 |
| GAP-05 审稿循环 | 5 | 端到端自动化的最后一环 |

---

## 与现有 REDESIGN_PLAN 的映射

| GAP | 新增/扩展 | 关联现有项 |
|---|---|---|
| GAP-01 | **新增 UX-01** | research-team skill, context_pack.py, w3_revision.py |
| GAP-02 | **新增 UX-02** | EVO-01 (package_selector), hep-calc |
| GAP-03 | UX-01 的一部分 | EVO-06 (integrity_report 摘要嵌入) |
| GAP-04 | **新增 UX-03** | hep_export_paper_scaffold, paper-reviser |
| GAP-05 | **扩展 EVO-03** | referee-review, paper-reviser |
| GAP-06 | **扩展 NEW-R15** | approval_policy.schema.json |
| GAP-07 | **新增 UX-04** | NEW-06, SKILL.md |
| GAP-08 | **新增 UX-05** | research-team scaffold_research_workflow.sh |
| GAP-09 | **新增 UX-06** | 所有 skill 的上层协议 |

---

## 附录: 当前输出架构 vs 建议架构

### 当前
```
project/
├── Draft_Derivation.md          ← 机器 contract + 人类笔记 (混合，难读)
├── RESEARCH_PLAN.md             ← 任务板
├── PROJECT_CHARTER.md           ← 目标/约束
├── PREWORK.md                   ← 文献矩阵
├── INNOVATION_LOG.md            ← 创新记录 (常空)
├── PROJECT_MAP.md               ← 导航
├── AGENTS.md                    ← 工作流锚点
├── knowledge_base/              ← KB (多文件，常半空)
├── prompts/                     ← team 提示词 (初始化即生成)
├── team/runs/<TAG>/             ← team cycle 输出 (多文件，部分无用)
├── artifacts/runs/<TAG>/        ← 计算制品 (JSON + PNG)
├── evidence/                    ← 证据笔记 (散落)
├── reports/draft.md             ← 单一报告
└── (无 paper/ 目录)
```

### 建议
```
project/
├── research_notebook.md         ← 人类阅读入口 (推导 + 结果 + 图表)
├── Draft_Derivation.md          ← 机器 contract (自动生成，人类不编辑)
├── computation/                 ← 结构化可运行代码
│   ├── manifest.json
│   ├── mathematica/
│   ├── python/
│   └── julia/
├── paper/                       ← 论文输出 (带版本)
│   ├── v1/
│   ├── v2/
│   └── review/
├── artifacts/runs/<TAG>/        ← 计算制品 (不变)
├── PROJECT_CHARTER.md           ← 目标/约束 (不变)
├── RESEARCH_PLAN.md             ← 任务板 (不变)
├── AGENTS.md                    ← 工作流锚点 (不变)
│
│  ── 以下按需生成 (GAP-08) ──
│
├── knowledge_base/              ← KB 首次使用时生成
├── prompts/                     ← team cycle 首次运行时生成
└── team/runs/                   ← team cycle 输出
```
