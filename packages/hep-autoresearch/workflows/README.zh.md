# workflows/

本目录存放“可执行/可验收”的 workflow 蓝图（比 `docs/WORKFLOWS.md` 更结构化）。

约定：
- 每个 workflow 文档都必须包含：输入、产物、门禁、最小可行范围（MVP）、扩展路线（v1/v2）。
- 任何新增自动化能力，都必须对应：
  1) 更新某个 workflow 文档（或新增一个 workflow），以及
  2) 新增/更新至少 1 个 eval case（`evals/`）。

当前 workflow 列表：
- `ingest.md`：文献入口（INSPIRE/arXiv/DOI → references + reading note）
- `reproduce.md`：复现主结果（reproduction-first）
- `computation.md`：通用计算 DAG（run_card v2）→ 可审计产物 + resume
- `draft.md`：草稿写作（从 Draft_Derivation/KB 到可编译草稿）
- `revision.md`：审稿→改稿闭环（LaTeX）
- `paper_reviser.md`：paper-reviser 集成 + 验证闭环（A–E；Step C 走 A1 门禁）
- `derivation_check.md`：推导与一致性检查（含数值/极限对照）
- `C1_literature_gap.md`：MCP INSPIRE 文献发现（Phase C1，生成可审计 discovery bundle）
- `C2_method_design.md`：方法设计脚手架（Phase C2，生成可运行的 computation 插件项目）
