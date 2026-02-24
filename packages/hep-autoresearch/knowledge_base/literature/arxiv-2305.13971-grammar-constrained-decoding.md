# Grammar-Constrained Decoding — Geng et al. (2023)

RefKey: arxiv-2305.13971-grammar-constrained-decoding
arXiv: 2305.13971 [cs.CL]
Links:
- arXiv: https://arxiv.org/abs/2305.13971
- TeX snapshot (local): [acl2023.tex](../../references/arxiv_src/2305.13971/src/acl2023.tex)

## 为什么与本项目相关

科研 agent 的很多关键输出其实应该是**结构化对象**（JSON：计划、预算、artifact 指针、审稿报告、gate 决策）。如果结构化输出靠“提示词约束”，会遇到解析失败、字段缺失、注入、以及不可控的格式漂移。

Grammar-constrained decoding 这类方法的核心价值是：在不训练模型的前提下，用“输出约束”把 LLM 的自由度收敛到某个语法/结构里，提高稳定性与可验证性。

## 可借鉴的创新点（可执行层面；来自 TeX 精读）

1) **结构化输出的硬约束**
   - 减少 schema 不合格输出，提高自动化可用性。
2) **无需 finetuning 的约束机制**
   - 与我们“不做 L4 训练权重”的路线兼容。
3) **Input-dependent grammars（IDG）**
   - 在输出结构依赖输入时（例如候选集合、parse tree 的 leaf=输入 tokens），可用“随输入变化的 grammar”大幅缩小输出空间（对计划/审批/候选选择类输出也有借鉴意义）。
4) **Completion engine（incremental parser）作为通用约束层**
   - 将约束从“专用 trie / FSA 工程”抽象为“写 grammar → 约束解码”，降低工程耦合。

## 对我们设计的直接映射

- 把 schema-validated outputs 当作默认：`specs/*.schema.json`
- 在可用的模型/runner 上，优先启用“JSON mode / function calling / constrained decoding（若可用）”；否则走严格 parser + fail-fast + retry。
- 重要限制（论文明确指出）：真正的 token-level grammar-constrained decoding 需要每步拿到 vocab 分布；纯 API（不暴露 logits）场景不可直接用。对我们来说，更现实的是 **schema 校验 + retry** 或 **function calling**；若要做真 GCD，需要选择支持 logits/本地模型的 runner。
- 把“结构化输出失败率”纳入 eval suite 与回归指标（L2/L3 gate）。

Verification status: deep-read (TeX snapshot; abstract+method 已核查)
What was checked:
- `sections/00_abstract.tex`：GCD 的动机与输入依赖 grammars
- `sections/03_method.tex`：CFG/IDG 定义、incremental parser completion engine、以及 API logits 限制
