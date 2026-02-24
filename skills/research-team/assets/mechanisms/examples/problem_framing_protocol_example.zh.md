# Example — Problem Framing / Problem Framing-R（ZH 示例片段）

Project: <PROJECT_NAME>  
Date: 2026-01-14  
Owner: leader  
Profile: `mixed`

## 0) Problem Interpretation（示例）

- 问题句：在固定 soft 背景下求 collinear 传播子 $G_R$，并据此构造 soft closure $\Pi_s$。
- 输入：soft shear profile $v_s(x,t)$（允许 $O(1)$ 幅度但软梯度小）
- 输出：$G_R$ 的可计算表达式；$\Pi_s$ 的核/导数展开
- scope：HM toy / 后续匹配到 HW/ITG
- anti-scope：不在本轮解决系数的数值匹配
- 失败条件：if 出现符号/归一化歧义且无法通过一个最小判别测试消除，则 fork 成竞争假设并分别推进

## 1) P/D 分离（示例）

Principles:
- P1：$E\times B$ 不可压缩流 → Jacobian=1（source: derivation）
- P2：常剪切 Kelvin 模式（source: literature）

Derivation:
- D1：shearing 坐标变换与拉普拉斯畸变（steps >=3 ...）
