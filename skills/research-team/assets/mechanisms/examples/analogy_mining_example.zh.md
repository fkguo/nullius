# Example — Analogy Mining（ZH 示例）

Project: <PROJECT_NAME>  
Date: 2026-01-14  
Owner: leader  
Profile: `theory_only`

## 0) 结构签名（示例）

- 对象：两扇区（slow/fast）耦合的有效理论
- 约束：因子化/幂次计数/重求和（RG）
- 小参数：$\lambda \ll 1$
- 关键结构：Wilson line / shearing 坐标等价类
- 输出：可控的 LP 解耦 + NLP 修正算符

## 1) 候选源领域（示例）

| Candidate | Why it matches signature | What falsifies quickly? |
|---|---|---|
| SCET | soft/collinear 因子化结构一致 | 找不到可对齐的幂次计数/算符基 |
| WKB/多尺度 | slow/fast 展开形式相似 | 展开参数与物理量无法对齐 |

## 2) 最小文献锚点（示例）

- SCET：标准综述（待写入 `knowledge_base/literature/`）

## 3) 映射表（示例）

| Source object | Target object | Mapping rule | Scope | Test |
|---|---|---|---|---|
| collinear field | drift-wave sector | $k_y\sim O(1)$ | HM toy | check propagator |
| soft field | zonal sector | $k_y=0$ | strong shear allowed | check Jacobian=1 |

## 4) 最小验证（示例）

- V1：Jacobian 是否为 1（不可压缩流）
- V2：常剪切下 Kelvin 模式是否复现

Kill criteria（示例）：
- if 映射无法通过任意一个最小验证（V1/V2）或需要引入未声明的新小参数才能成立，则否决该类比
