# Problem Framing / Problem Framing-R（ZH：顺序审查 + P/D 分离）模板

Project: <PROJECT_NAME>  
Owner: <YOUR_NAME>  
Date: <YYYY-MM-DD>  
Profile: `<PROFILE>`  （options: `theory_only | numerics_only | mixed | exploratory | literature_review | methodology_dev | custom`）  

目标：把“审稿/复核”做成可执行协议，避免跳步、避免争议靠口头妥协收敛。

核心：Problem Interpretation gate + P/D 分离（Principle/Derivation）+ Atomic 标准 + Sequential Review + 外部一致性/悖论通道。

---

## How to use（与主流程绑定；建议一份内容，多处引用）

- 把 “0) Problem Interpretation Gate” 同步到 [PREWORK.md](../PREWORK.md) 的 `## Problem Framing Snapshot`（避免口头/脑内定义漂移）。
- 把 P/D 分离与顺序审查清单同步到 [RESEARCH_PLAN.md](../RESEARCH_PLAN.md) 的里程碑 DoD（验收要有文件/命令/阈值）。
- 把外部一致性/悖论通道的结论写进 `team/runs/<tag>/<tag>_adjudication.md` 并在下一轮 packet 里带上（否则分歧无法闭环）。

硬性建议（用于避免验收流于表面）：
- 失败条件 / kill criteria：至少写 1 条“显式阈值/条件”（例如包含 `if` 或比较符号 `<`, `>`, `!=` 等）。
- 复杂数值问题：先做方法/算法检索与选择（记录在 `knowledge_base/methodology_traces/`），再写代码（避免 brute force）。

## 0) Problem Interpretation Gate（问题解释门）

必须先把“我们在解决什么问题”写成可检验对象：

- 问题句（1 句话）：
- 输入（inputs）：
- 输出（outputs / observables）：
- 适用范围（scope / constraints）：
- 不适用范围（anti-scope）：
- 失败条件（falsification / kill / scope-narrow triggers）：

如果团队对上述任一项存在分歧：立刻进入 Fork（不要继续推导/算图）。

## 1) P/D 分离（Principle / Derivation）

### 1.1 Principles（原则层：可复用、跨任务）

列出你依赖的原则/定理/守恒/不变量/对称性/已知文献结论（每条都要可引用）：

| ID | Principle | Why applicable | Source (paper/book/derivation pointer) |
|---|---|---|---|
| P1 |  |  |  |

### 1.2 Derivations（推导层：本任务特定、逐步可审计）

对每个关键结论，写成原子化步骤：

- D1: <statement>
  - inputs:
  - assumptions:
  - steps (>=3):
  - result:
  - checks (limits/sign/dimension):

## 2) Atomic 标准（必须满足）

一个“原子条目”（claim/evidence/derivation step）必须满足：

- 单一断言：不能把多个结论捆绑
- 明确依赖：写出 requires/supports
- 明确证据：能指向 artifact/推导段/文献锚点
- 符号闭环：结果中出现的每个符号/算符都必须在前文被明确定义或给出映射关系；不得在“结论句/结果式”处首次引入新符号（这是典型跳步来源）
- 可证伪：至少一个 kill criterion 或反例路径

## 3) Sequential Review（顺序审查清单）

按顺序勾选，禁止跳步：

1. [ ] Problem Interpretation 完整且一致
2. [ ] Principles 列全，且每条有 source
3. [ ] 推导链无跳步（关键步骤 >=3）
4. [ ] 符号/记号映射完整（结果中出现的符号都能追溯到前文定义/映射；NR/LO 等极限需给出桥接步骤）
5. [ ] 关键定义一致（同名同物）
6. [ ] 外部一致性检查（已知极限/文献/基准）至少 1 条
7. [ ] 若仍有分歧：进入 Correction 或 Fork（写清判别测试）

## 4) External Consistency / Paradox Channel（外部一致性/悖论通道）

当出现以下任一情况，必须开启该通道，并写入 evidence/trajectory：

- 与已知极限/守恒/文献结论冲突
- 不同推导路径给出不同系数/符号
- 数值结果在合理误差外不一致

记录：
- 冲突描述：
- 可能原因（>=2 个）：
- 最小判别测试（>=1 个）：
- 结论：Correction / Fork / Scope-narrow
