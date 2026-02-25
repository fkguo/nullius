# Review Packet: REDESIGN_PLAN v1.8.0 — Scope Audit + Pipeline 连通性收敛落地

## 变更摘要

Version bump: 1.7.0-draft → 1.8.0-draft
Files: meta/REDESIGN_PLAN.md (+549/-294 lines), meta/remediation_tracker_v1.json (+1462/-294 lines)

## 修改类型

### 全局约束新增
- **质量优先原则**: 写入 §全局约束 — 不设 max_cost_usd / max_llm_tokens, budget tracking 仅 observability
- **无向后兼容负担**: 补充 "字段设为 optional 以兼容旧数据——如果语义上应该 required，就直接 required"

### 现有项修改 (Task 1A, 13 项)
| 项目 | 修改 | 来源 |
|------|------|------|
| H-01 | 简化: McpError += retryable + retry_after_ms, 不创建独立 AutoresearchError 信封 | 3/3 |
| H-04 | 标注 done + 冻结不扩展 (Codex 保留意见) | 2/3 |
| H-15a | 标注 done + 冻结不扩展 | 3/3 |
| H-17 | deferred → Phase 2 | 3/3 |
| M-22 | deferred → Phase 3 | 3/3 |
| NEW-R09 | CUT (hep-autoresearch 整体退役) | 3/3 |
| NEW-05a | Re-scoped: Stage 1-2 done, Stage 3 not_started (Phase 2-3 增量) | 勘误 |
| UX-02 | 升级为 Computation Contract + evidence format spec | 2/3 + CONN |
| UX-04 | 扩展为 workflow schema + 添加 NEW-R15-impl 依赖 | 2/3 |
| EVO-01 | 添加依赖: UX-02, UX-04, NEW-R15-impl, NEW-COMP-01 | 2/3 |
| EVO-03 | 添加依赖: NEW-IDEA-01 | 2/3 |

### 新增项 (Task 1B, 15 项)
| 项目 | Phase | LOC 估计 | 依赖 |
|------|-------|---------|------|
| NEW-CONN-01 | P1 | ~100 | H-16a |
| NEW-CONN-02 | P2 | ~60 | — |
| NEW-CONN-03 | P2 | ~250 | NEW-COMP-01, NEW-01 |
| NEW-CONN-04 | P2B | ~150 | NEW-IDEA-01 |
| NEW-CONN-05 | P3 | ~100 | NEW-CONN-03 |
| NEW-IDEA-01 | P2 | ~400-800 | H-01, H-02, H-03, H-16a |
| NEW-COMP-01 | P2 late | ~200 | C-02, NEW-R15-impl |
| NEW-COMP-02 | P3 | ~500 | NEW-COMP-01, C-02 |
| NEW-WF-01 | P2 | ~100 | UX-04 |
| NEW-SKILL-01 | P3 | ~200 | — |
| NEW-RT-01 | P2 early | ~250 | NEW-R15-impl |
| NEW-RT-02 | P2 early | ~100 | H-19 |
| NEW-RT-03 | P2 mid | ~150 | H-02 |
| NEW-RT-04 | P2 late | ~200 | NEW-RT-01 |
| NEW-RT-05 | P3 | ~500 | NEW-RT-01, NEW-RT-03 |

### 依赖新增
- UX-04 → NEW-R15-impl
- EVO-01 → UX-02, UX-04, NEW-R15-impl, NEW-COMP-01
- EVO-03 → NEW-IDEA-01
- NEW-CONN-01 → H-16a
- NEW-CONN-03 → NEW-COMP-01, NEW-01
- NEW-CONN-04 → NEW-IDEA-01
- NEW-CONN-05 → NEW-CONN-03

## 关键设计决策

1. **ComputationEvidenceCatalogItemV1**: 并行 schema，不修改 EvidenceCatalogItemV1 (LatexLocatorV1 是 required, synthetic locator 会破坏验证器)
2. **next_actions**: hint-only (221+ 次使用, 33 个文件, 从不自动执行), 遵循 { tool, args, reason } 惯例
3. **Pipeline A/B 统一**: Phase 2 MCP → Phase 2B hint → Phase 3 实现 → Phase 4 退役
4. **CLI-First**: Phase 1-2 CLI agents 作 agent loop, Phase 3+ AgentRunner
5. **不引入框架**: SDK 管 model interaction, 自建管 domain state

## 上下文文件
- `meta/REDESIGN_PLAN.md` (修改后, ~2600 行)
- `meta/remediation_tracker_v1.json` (修改后, 135 items)
- `meta/docs/scope-audit-converged.md` (三模型收敛报告)
- `meta/docs/scope-audit-dual-mode-converged.md` (CLI-First 收敛报告)
- `meta/docs/pipeline-connectivity-audit.md` (双模型 R4 收敛)

Please review both files carefully and produce your verdict.
