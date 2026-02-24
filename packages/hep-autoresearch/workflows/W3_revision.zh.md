# W3 — Review → Revision（审稿→改稿闭环）

## 目的

把论文修改变成工程流程：审稿意见结构化、改稿可追溯（diff）、结果可编译、关键新增有证据门禁。

## 输入

- `paper_root`（LaTeX 工程目录）
- `review_profile`（期刊/风格；例如 PRL referee 风格）
- `constraints`（不可改动范围、目标字数、必须保留的段落等）

> 若你还没有可编译 `paper_root`，先走 [W3_draft](W3_draft.md)（从 Draft_Derivation/KB 生成草稿）。

## 输出（产物）

必需：
- `team/runs/<TAG>/...`（审稿报告 + revision plan + 复核/收敛记录）
- 改稿后的可编译 LaTeX（原地或输出到新目录，需在 manifest 中记录）

建议：
- `artifacts/runs/<TAG>/revision/manifest.json`（记录编译命令、diff 路径等）

## MVP v0（现已实现：compile gate + provenance 表）

为了先把“改稿流程的可靠性工程”落地，本项目先实现一个**不依赖外部 LLM** 的 v0 子集：
- 基线可编译检查（compile gate）
- 从 `Draft_Derivation.md` Capsule 的 Headline numbers 提取 provenance 指针
- 自动填入 `paper/main.tex` 的 provenance table（带 diff 与编译日志）

入口：
- 直接 runner：`python3 scripts/run_w3_revision.py --tag <TAG> --paper-root paper --tex-main main.tex --i-approve-paper-edits`
- Orchestrator：`python3 scripts/orchestrator.py run --run-id <TAG> --workflow-id W3_revision`（默认触发 A4）

> 完整的“审稿→改稿→再审”闭环（Reviewer/Planner/Editor 多角色 + 收敛）将在 v1/v2 逐步补齐。

## 步骤（MVP）

1) Reviewer 生成结构化审稿报告（major/minor + 可执行建议）。
2) Planner 生成 revision plan（每条建议 → 文件/段落/修改策略/验收）。
3) Editor 执行修改并输出 diff。
4) 编译与卫生检查（引用、链接、宏、证据门禁）。
5) 再审：直到收敛或触发“需要人类决策”的阻塞点。

## 门禁（验收）

- 论文可编译。
- 引用与链接完整（无断链/无虚构引用）。
- 新增关键结论/数字必须能指向证据（否则不得进入正文或必须标记 UNVERIFIED）。

## 扩展路线

- v1：把审稿意见映射到 claim graph（哪些 claim 被挑战，证据是否充足）。
- v2：自动生成回应信（rebuttal / response-to-reviewers），逐条对应并引用 diff/证据。
