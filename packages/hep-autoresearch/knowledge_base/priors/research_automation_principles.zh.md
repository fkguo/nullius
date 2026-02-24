# Research automation priors（研究自动化的基本假设与原则）

RefKey: priors-research-automation-principles
Last updated: 2026-02-01

## 1) 我们默认的工程假设

- 研究流程可以被拆成“可执行步骤 + 可验证产物”，并用门禁保证质量。
- LLM 的强项是语言与策略搜索；“可信度”来自工具调用、产物契约与独立复核，而不是模型自信。
- 任何自动化都必须允许人类插手与回滚；默认不要做不可逆操作。

## 2) Evidence-first（核心原则）

任何可影响结论的断言，都必须至少满足之一：
- 可复现计算产物指针（artifact path + 字段/键）
- 可复核推导步骤（notebook 中不跳步的 derivation）
- 明确标记 `UNVERIFIED`，并给出验证计划与 kill criterion

## 3) Reproducibility contract（最小产物契约）

每次 run 至少落盘：
- `manifest.json`（命令/参数/版本/输出）
- `summary.json`（定义明确的统计摘要）
- `analysis.json`（headline numbers + 误差/不确定度说明）
- `logs/`（关键日志）

## 4) 多代理复核（最低配）

关键里程碑默认要求：
- 两个“独立视角”的复核（可双模型，也可人+模型）
- 不收敛则回退：修正步骤/输入/假设/实现，而不是“解释过去”

## 5) 自动改稿边界

- 自动改稿必须输出 diff，并保证可编译。
- 新增的关键结论/数字必须能指向证据；否则拒绝写入正文（或显式标记为待验证）。

