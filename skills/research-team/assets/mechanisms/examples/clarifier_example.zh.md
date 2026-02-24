# Example — Pre-task Clarifier（ZH 示例）

Project: <PROJECT_NAME>  
Date: 2026-01-14  
Owner: leader  

Chosen profile: `methodology_dev`

## 1) 最小问答（示例）

1. 问题句：把 research-team 从文档升级为可执行脚手架+门禁，并保持可迁移到 MCP。
2. 可比对输出：可运行的脚本/门禁；可配置 profile；可复现实例与 smoke tests。
3. 证据类型：脚本 CLI + deterministic gates + 通过的 smoke tests + 审阅报告。
4. 可证伪条件：gate 无法给出可修复错误信息；机制不 profile-aware；无法迁移成 tool schema。
5. 主要风险：过度严格导致阻塞；格式/协议不一致导致无法自动化。
6. 外部输入：无（不接入 hep-research-mcp）。

## 2) 里程碑（示例）

### M0 — 机制模板落地
- Deliverables: `mechanisms/*.md`, scaffold 脚本
- DoD: `smoke_test_*` 通过
- Kill: if 经过 1 轮迭代仍无法产出“最小 claim+evidence（可复现）”且门禁报错不可修复，则停下并缩小 scope

### M1 — Claim DAG MVP
- Deliverables: `knowledge_graph/`, 3 个 gate 脚本
- DoD: gates 可配置且报错可修复
- Kill: if schema 变更导致 >=2 个项目反复破坏且无法版本化收敛，则停下并简化接口
