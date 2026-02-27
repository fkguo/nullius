## [2026-02-26] Graph Compute Layer: 派生节点 + 结构化查询 (Future Extension)

**上下文**: NEW-VIZ-01 设计审查 + GitNexus 项目调研
**发现**: UniversalGraph 渲染层之上未来需要 compute/query 层——从基础图预计算派生节点（claim cluster, citation community, signal pattern 等）+ 结构化查询 API（blast radius, cross-type traversal）。核心原则：预计算 > 实时遍历（对 LLM agent 一次查询完整上下文 vs 多轮遍历可能遗漏）。
**影响**: 不影响 NEW-VIZ-01 实现（派生节点是普通 UniversalNode）。详细设计时机：EVO-20 (Memory Graph) 实现时。已在 `meta/docs/graph-visualization-layer.md` §11 记录。
**关联项**: NEW-VIZ-01, EVO-20, EVO-09, EVO-12a