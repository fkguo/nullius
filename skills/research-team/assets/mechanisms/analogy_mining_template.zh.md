# Analogy Mining（ZH：跨学科结构类比挖掘模板）

Project: <PROJECT_NAME>  
Owner: <YOUR_NAME>  
Date: <YYYY-MM-DD>  
Profile: `<PROFILE>`  （options: `theory_only | numerics_only | mixed | exploratory | literature_review | methodology_dev | custom`）  

目标：把“我直觉上像 X”的想法变成可审计的映射：结构签名 → 候选源领域 → 最小文献锚点 → 映射表 → 最小验证 → 写入 Claim DAG（含 fail-fast）。

---

## How to use（与主流程绑定）

- 把“最小文献锚点”落实到 `knowledge_base/literature/`（每条锚点最终应有 KB 笔记 + 外部链接）。
- 把“最小验证”产物登记为 Evidence（路径必须存在），并在下一轮 team packet 里引用。
- 把“通过/未否定”的类比写成可证伪 claim（带阈值 kill criteria），否则不要进入主推导链。

## 0) 结构签名（Structure Signature）

用“结构而非术语”描述你当前问题的骨架（尽量少写背景叙述）：

- 状态变量/对象类型：<fields/operators/distributions/...>
- 约束/对称/守恒：<symmetries/invariants/constraints>
- 小参数/标度结构：<epsilon, lambda, scaling regimes>
- 典型方程形态：<PDE/ODE/integral equation/variational principle>
- 关键奇点/非解析结构：<poles/branch cuts/turning points/boundary layers>
- 输出/可比对量：<observables/diagnostics>

## 1) 候选源领域（Candidate Source Domains）

列 3–7 个候选“源领域/经典模型/数学结构”，并为每个候选写一句“为什么像”：

| Candidate | Why it matches signature | What would falsify analogy quickly? |
|---|---|---|
|  |  |  |

## 2) 最小文献锚点（Minimal Literature Anchors）

每个候选至少给 1 个锚点（可先写 bibkey/链接/书名章节；后续放入 `knowledge_base/literature/`）：

- Candidate A anchor:
- Candidate B anchor:

## 3) 映射表（Mapping Table）

把“源领域”的对象映射到“目标问题”的对象。要求：每行都可检验（可推导/可计算/可查文献）。

| Source object | Target object | Mapping rule | Scope/assumptions | Test |
|---|---|---|---|---|
|  |  |  |  |  |

## 4) 最小验证（Minimal Validation）

只做 1–3 个最小验证即可（fail-fast 优先）：

- V1（一致性/极限/维度/符号）：<what you check, expected pass/fail>
- V2（toy model / 数值 sanity）：<...>
- V3（文献对照）：<...>

把验证产物登记为 Evidence（路径必须存在）：
- `knowledge_graph/evidence_manifest.jsonl`: add entries `type=analogy_validation`

## 5) 写入 Claim DAG（最低要求）

如果类比通过最小验证（或至少未被否定），把它写成一个明确 claim：

- Claim statement（可证伪）：
- Dependencies（requires 哪些已有 claims/priors）：
- Kill criteria（至少 1 条，写清阈值）：
- Linked trajectories（本轮 tag）：

写入：
- `knowledge_graph/claims.jsonl`
- `knowledge_graph/edges.jsonl`（用 `supports/requires/competitor/contradicts` 等边连接）

## 6) Fail-fast Checklist（必须勾选）

若以下任一项为真，则立即停止投入或 fork 成竞争假设：

- [ ] 映射依赖“词语相似”而非结构等价
- [ ] 关键量的维度/标度无法对齐
- [ ] 最小验证出现明确反例（V1/V2/V3 任一 fail）
- [ ] 类比只能解释已知现象，无法产生新的可判别预测
