# 2026-02-01 — Autopilot scope + build strategy

Purpose: 记录“为什么这样规划”以及我们选择的实现顺序，便于后续复核与避免目标漂移。

## Decision 1: 以“复现优先（reproduction-first）”作为可靠性锚点

理由：
- 复现有明确验收标准（误差/差异来源/参数一致性），能形成工程化 eval case。
- 在复现过程中会自然暴露：隐含假设、版本差异、数值稳定性问题，这些正是“科研加速工具”必须解决的痛点。

## Decision 2: 先做门禁与产物契约，再扩展自动推导

理由：
- 自动推导最容易产生“看起来很像但其实错”的结果；没有门禁与证据链就不可控。
- 门禁（可编译/引用/证据/复核）与 artifacts 契约一旦稳定，会反过来提升后续推导与写作的可靠性。

## Decision 3: 复用现有能力（MCP + skills），避免重写

映射：
- 文献抓取/索引 → `hep-research-mcp`
- 复核收敛 → `research-team` / `review-swarm`
- 计算编排与可审计输出 → `hep-calc`
- 写作/改稿闭环与卫生检查 → `research-writer`

## Next actions

- 扩充 literature coverage matrix（至少补齐：agentic research in physics、自动复现、LLM+CAS、paper revision systems）。
- 定义 eval suite 的最小 3 个 case（ingest / revise / reproduce-toy）。

