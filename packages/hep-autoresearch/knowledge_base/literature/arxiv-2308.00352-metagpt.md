# MetaGPT — Hong et al. (2023)

RefKey: arxiv-2308.00352-metagpt
arXiv: 2308.00352 [cs.AI]
Links:
- arXiv: https://arxiv.org/abs/2308.00352

## 为什么与本项目相关

MetaGPT 把“多 agent 协作”产品化成类似软件团队的分工（角色、文档产物、交接）。我们做科研 agent 的核心也是多角色分工与产物契约，只是产物从“PRD/代码”换成“推导/计算/证据/论文”。

## 可借鉴的创新点（可执行层面）

1) **角色分工 + 产物驱动**
   - 每个角色产出结构化文档，降低协作摩擦。
2) **把协作过程固化为流程**
   - 不是“随便聊”，而是按固定阶段推进。

## 对我们设计的直接映射

- 把科研流程也做成“文档产物驱动”的 pipeline：
  - Planner 输出 acceptance criteria
  - Executor 输出 manifest/summary/analysis
  - Reviewer 输出结构化审阅（schema）
- 把“handoff”作为一等能力（我们已经在当前 orchestrator 设计里落了多人接管/交接语义）。

Verification status: metadata-only (仅抓取标题/作者；未精读全文)
