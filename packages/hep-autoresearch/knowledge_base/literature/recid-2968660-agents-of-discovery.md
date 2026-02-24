# Agents of Discovery — Diefenbacher et al. (2025)

RefKey: recid-2968660-agents-of-discovery
INSPIRE recid: 2968660
arXiv: 2509.08535 [hep-ph]
Links:
- INSPIRE: https://inspirehep.net/literature/2968660
- arXiv: https://arxiv.org/abs/2509.08535
- TeX snapshot (local): [main.tex](../../references/arxiv_src/2509.08535/src/main.tex)

## 为什么与本项目相关

它把“多 agent（LLM instances with subtasks）”用于真实的数据分析任务（LHC Olympics anomaly detection），并强调：
- agent 像人类研究者一样“写代码→跑工具→看结果→迭代”
- 对多模型做稳定性测试
- 目标是自动化 routine analysis components 来对抗工具链复杂度

这与我们项目“多角色分工 + 可复现产物 + 收敛门禁”的定位高度一致。

## 可借鉴的创新点（可执行层面；来自 TeX 精读）

1) **任务定义接近真实科研**
   - 不是 toy demo，而是公开数据集上的真实分析任务。
2) **稳定性测试与多模型比较**
   - 强调“能跑一次 ≠ 可靠”，需要看稳定性与失败分布。
3) **“最优 agent 解接近人类 SOTA”的评估口径**
   - 我们可以借鉴其评估结构，但必须避免夸大：需要把评估条件与 baselines 写进 artifacts。

## 结构化机制（我们可直接借鉴）

1) **四角色分工 + 工具驱动的协作**
   - 论文框架包含 4 个 agent：Researcher / Coder / Code reviewer / Logic reviewer；Researcher 通过 tool handoff 驱动 coder/审阅，并用 task manager 做任务拆分与进度跟踪。
2) **工具面 = 可审计执行面**
   - Researcher 通过工具请求 code（`handoff_to_coder`）、执行 code（`execute_python`）、查看输出文件（`view_text_files` / `view_images`），并通过 `logic_review` 获得逻辑审阅；整体是一个典型的“plan→act→observe→revise”循环。
3) **面向运行的度量体系**
   - 指标不仅包含 physics 结果，也包含运行质量指标（calls、tool calls、python errors、response time、token/cost 等），并用多次 runs 统计稳定性与失败模式（包括格式错误/未完成等）。
4) **prompt 作为一等公民（强敏感性）**
   - 论文明确展示 prompt phrasing 的巨大影响，并把 prompt families/依赖关系作为实验设计的一部分。

## 对我们设计的直接映射（adopt now / later）

- Adopt now（M1–M2）：
  - 把“稳定性/方差”纳入 eval 指标（不仅看 pass/fail）。
  - 把“代码生成 + 工具执行”的循环视作第一类 workflow，并把失败分布沉淀成知识库（L1）。
  - 把 prompt 与 tool list 作为 run-card 字段固定落盘（便于复现与归因）。
- Later：
  - 引入“公开 benchmark suite”作为回归评测集合的一部分（降低投机空间）。
  - 引入 “task manager / task graph” 的显式结构（我们已有 Orchestrator state，但可吸收其任务层抽象）。

## 需要批判性对待/进一步核查

- 需要核查其“稳定性测试”具体怎么做（跑几次、统计口径、是否控制随机性）。
- 需要核查其成功案例是否依赖大量人工提示/手工修补（这影响自动化可移植性）。
- 论文设置是“启动后不再与用户交互”；与我们默认 approval/pause/resume 的交互式科研现实不同，需要对照其优缺点。

Verification status: deep-read (TeX snapshot; agent 结构/工具面/度量体系已核查)
What was checked:
- `main.tex`：General setup（agents+tools+prompts）、metrics 列表、以及 prompt/稳定性讨论相关段落
