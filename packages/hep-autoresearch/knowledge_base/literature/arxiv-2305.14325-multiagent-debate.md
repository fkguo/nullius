# Multiagent Debate — Du et al. (2023)

RefKey: arxiv-2305.14325-multiagent-debate
arXiv: 2305.14325 [cs.CL]
Links:
- arXiv: https://arxiv.org/abs/2305.14325

## 为什么与本项目相关

“多代理辩论/交叉质询”是提升 factuality/reasoning 的常见路线。我们已经在工程上把这一点落到了 `research-team`（双成员交叉检验）与 `review-swarm`（clean-room 双审阅）上；这篇论文可以作为“为什么需要独立复核”的外部支撑，并帮助我们设计更细的辩论/对抗用例（anti-gaming）。

## 可借鉴的创新点（可执行层面）

1) **用对抗/辩论暴露错误**
   - 与“单模型自说自话”相比更容易发现漏洞。
2) **把 disagreement 当作信号**
   - disagreement → 触发 escalation 或更多证据检索，而不是强行输出结论。

## 对我们设计的直接映射

- 我们默认把多角色分工当作必选项（Planner/Executor/Reviewer），并把 disagreement 变成门禁触发条件：
  - 任何关键结论若不收敛 → 不允许宣称新意（A5）。
- anti-gaming eval：把“诱导 Reviewer 放水/诱导同意点绕过”作为固定测试用例。

Verification status: metadata-only (仅抓取标题/作者；未精读全文)

