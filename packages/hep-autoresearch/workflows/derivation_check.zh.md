# Derivation + Checker（推导与一致性检查）

## 目的

在不夸大能力的前提下，把“推导与核查”做成可复核产物：推导不跳步、检查可复现、结论可追溯。

## 输入

- `goal`（要得到/核查的量：公式或数值）
- `assumptions`（模型、规范、单位、截断）
- `expected_checks`（维度/极限/对称性/对照数值点等）

## 输出（产物）

必需：
- `Draft_Derivation.md` 中对应章节：推导步骤 + 检查指针
- `artifacts/runs/<TAG>/checks/...`（数值/符号检查产物；至少一个可复现检查）

## 步骤（MVP）

1) 固化 priors（符号/归一化/单位/截断），写入 `knowledge_base/priors/` 并在 notebook 引用。
2) 把推导拆成原子步骤（>=3），写入 notebook body（不放在 Capsule 里）。
3) 若目标公式来自某篇论文（推荐做法）：先把**论文 LaTeX 中的公式**当作 SSOT 做“文本抽取→结构化→比对”。
   - 例：抽取 Eq.(V) 的矩阵条目，转成 $(\tilde a,\tilde b)$ 的系数矩阵，然后与实现逐项对齐。
4) 至少做一个外部一致性检查（不要只做平凡算术）：
   - 极限/维度检查，或
   - 与已知基准（文献/数值）对照，或
   - 独立数值点验证
5) Reviewer 复核：若无法复核，则标记 UNVERIFIED 并给出验证计划与 kill criterion。

## 门禁（验收）

- 推导不跳步（Reviewer 不应指出关键缺口）。
- 至少一个检查产物可复现且能指向 artifacts 指针。
- 若该 workflow 产物被下游数值流程依赖：其回归用例必须作为硬前置（本 workflow fail 时，下游结果视为无意义）。

## 扩展路线

- v1：引入 CAS（通过 `hep-calc`）自动做一部分符号检查/极限展开。
- v2：和 claim graph 联动：把关键 derivation steps 作为 claims，绑定 evidence。
