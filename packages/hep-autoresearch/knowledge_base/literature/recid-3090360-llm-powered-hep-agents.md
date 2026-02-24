# Automating High Energy Physics Data Analysis with LLM-Powered Agents — Gendreau-Distler et al. (2025)

RefKey: recid-3090360-llm-powered-hep-agents
INSPIRE recid: 3090360
arXiv: 2512.07785 [physics.data-an]
Links:
- INSPIRE: https://inspirehep.net/literature/3090360
- arXiv: https://arxiv.org/abs/2512.07785
- Code/model (from abstract): https://huggingface.co/HWresearch/LLM4HEP
- TeX snapshot (local): [neurips_2025.tex](../../references/arxiv/2512.07785/source/neurips_2025.tex)

## 为什么与本项目相关

它把“LLM 代理写代码/修错/迭代”放进一个**确定性 workflow manager（Snakemake）**里，并且给出了量化评测维度（成功率、错误分布、成本、API calls 等）。这正是我们强调“可复现性 + eval gate”的方向。

## 可借鉴的创新点（可执行层面；来自 TeX 精读）

1) **Agent + workflow manager 的分工**
   - workflow manager 保证 determinism/reproducibility
   - agent 负责生成/修复分析代码
2) **量化评测指标**
   - success rate、error distribution、成本、平均 API calls
   - 并直接用于比较不同模型/架构的稳定性
3) **“temperature=0 仍不完全确定性”的披露**
   - 指出 top-p/top-k 等默认值与“推理模型内部策略”会带来随机性
   - 这对我们设计“可复现性声明”非常关键：必须把采样参数/模型行为作为可审计要素

## 结构细节（用于“可实现机制”提炼）

### 1) 受控的 DAG 执行层：Snakemake 作为 determinism/provenance 锚点

要点：
- 将 agent 的介入“边界化”：只允许在 DAG 的特定节点执行（例如代码生成、事件选择、验证/修错）。
- 由 workflow manager 负责按规则执行、缓存、记录依赖与产物，降低“对话驱动脚本”的漂移与不可复现。

### 2) 评测维度不只看“能不能跑”，还看稳定性/成本/错误类型

要点：
- success rate：任务级成功率（multi-stage workflow）
- error distribution：失败类型分布（例如语义误解 vs 代码错误等）
- cost + API calls：可用于回归与预算控制（科研场景很关键）

### 3) 对“确定性”的诚实披露（有助于我们做更强门禁）

要点：
- 即使 temperature=0，也可能因为 top-p/top-k 默认值、以及某些 reasoning-oriented 模型内部策略导致输出仍然随机。
- 这提示：我们的 artifacts/ledger 里应该强制记录采样参数、模型/runner 版本，并在关键结论上做稳定性检查（多次 run / cross-model / cross-seed）。

## 对我们设计的直接映射（adopt now / later）

- Adopt now（M1–M2）：
  - 在 Orchestrator 里把“workflow manager/runner（确定性执行）”与“LLM 规划/写代码”明确分层。
  - 把 cost_stats（calls/runtime）作为结构化字段写入 run ledger（我们已有 schema 方向）。
  - 将“非确定性来源”纳入 artifacts 的强制字段（模型、采样参数、runner 版本）。
- Later：
  - 引入 Snakemake/类似工具作为执行后端（在重现性要求高的 analysis workflow 尤其有用）。

## 需要批判性对待/进一步核查

- “最终输出仍有随机性”意味着：我们的系统不能只靠“temperature=0”；需要更强的可重复执行策略与多次 run stability checks。
- 需要核查其评测脚本与基线代码是否足够可移植（环境锁定、数据来源、依赖版本）。

Verification status: deep-read (TeX snapshot; 摘要与方法论/评测设计已核查；代码复跑待办)
What was checked:
- 架构：supervisor–coder agent 与 Snakemake 的职责分离与约束边界
- 指标：success rate / error distribution / costs / API calls 的定义动机
- 可复现性：temperature=0 仍可能随机的原因与启示（需要 ledger/稳定性门禁）
