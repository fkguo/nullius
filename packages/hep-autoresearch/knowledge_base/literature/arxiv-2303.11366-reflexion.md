# Reflexion: Language Agents with Verbal Reinforcement Learning — Shinn et al.

RefKey: arxiv-2303.11366-reflexion
arXiv: 2303.11366 [cs.AI]
Links:
- arXiv: https://arxiv.org/abs/2303.11366
- Code: https://github.com/noahshinn024/reflexion

## Key points（来自 TeX 精读）

1) **“自我进化”但不更新权重**
   - Reflexion 用语言反馈（verbal reinforcement）来强化 agent：把任务反馈信号转成“可执行的反思文本”，存入 episodic memory，在后续 trial 作为额外上下文引导决策。
2) **反馈信号来源与形式灵活**
   - 可用标量/二值/自由文本；也可来自外部环境或内部自评（例如 LLM 自评、单元测试等）。
3) **把“试错→总结→再试”显式化**
   - 不是“反复采样直到成功”，而是要求在失败后生成可复用的经验摘要（semantic gradient），以减少重复错误。

## 对本项目的直接启发（高 ROI：不训练模型也能变强）

- L3 自我进化可落地为：把 review 失败、eval 失败、复现失败的“可归因错误 + 修复策略”写入经验库（可版本化、可回滚、可做消融）。
- 经验库必须受门禁：只允许写入“可验证的、能复现修复效果”的条目（例如：关联到某个 eval case 的通过/失败变化）。

## Skepticism / checks to do（后续）

- 反思文本可能引入“错误经验固化”：需要配合回归评测、以及对经验库的消融/灰度启用策略。
- 需要明确 memory 的作用边界：哪些任务适合（可明确反馈的 coding/决策），哪些任务会误导（反馈稀疏或目标不清）。

Verification status: deep-read (TeX snapshot; 摘要+方法动机已核查；实验细节按需补读)
What was checked:
- 摘要：episodic memory + verbal reinforcement 的定义与核心机制
- 引言：反馈来源（环境/自评/单元测试）与“无需权重更新”的定位
