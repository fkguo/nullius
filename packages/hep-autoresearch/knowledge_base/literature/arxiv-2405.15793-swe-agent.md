# SWE-agent — Yang et al. (2024)

RefKey: arxiv-2405.15793-swe-agent
arXiv: 2405.15793 [cs.SE]
Links:
- arXiv: https://arxiv.org/abs/2405.15793
- TeX snapshot (local): [00_abstract.tex](../../references/arxiv/2405.15793/source/sections/00_abstract.tex)

## 为什么与本项目相关

你提到的“自动写代码/自动复现/自动修 bug”在工程上最难的是：如何把 LLM 的输出约束到安全、可回滚、可验证的修改上。SWE-agent 是非常典型的“agent-computer interface”路线：把 agent 的行动空间限制在可控的操作集合里，并用外部验证（tests/logs）闭环纠错。

## 可借鉴的创新点（可执行层面；来自 TeX 精读）

1) **受限行动空间（agent-computer interface）**
   - 不允许随意“做任何事”，而是通过受控命令/文件 diff 操作。
2) **以验证为中心的迭代**
   - 失败→定位→修复→再测，形成可靠闭环。
3) **ACI 设计原则（对我们是直接可复用的工程准则）**
   - actions 要简单易懂（少选项、短文档）
   - actions 要“紧凑/高效”（关键操作尽量一条 action 完成）
   - environment feedback 要信息量高但简洁（避免把 token 预算耗在噪声上）
   - guardrails 可减少错误传播、加速恢复（例如语法检查/结构化编辑）

## 对我们设计的直接映射

- A2（code changes）门禁的落地范式：
  - 修改前：必须给出 patch plan（目标文件、验证方式、回滚策略）
  - 修改后：必须跑最小验证（tests/compile/audit slice）
- Orchestrator 的状态/ledger 要能记录每次“尝试-失败-修复”的轨迹，用于后续 L3 autopatch 库沉淀。
- ACI → 我们的工程实现：report.md + approval gates + schema 校验可以视为“为科研 agent 设计的接口层”，目标同样是：更少噪声、更可控的 actions、更可审计的反馈。

Verification status: deep-read (TeX snapshot; 摘要 + ACI 设计原则已核查)
What was checked:
- 摘要：SWE-bench/HumanEvalFix 的定位与 pass@1 headline（用于理解其“interface 改进”的量级）
- ACI 章节：actions 简单/紧凑、反馈简洁、guardrails 抑制错误传播的原则（可直接迁移到科研工作流）
