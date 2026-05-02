# QUICKSTART

本指南提供两条最常用路径：
- **Draft Path**：你已准备好结构化草稿数据，追求最短落地路径。
- **Client Path**：你希望走高质量、Evidence-first 的完整写作流程。

本页面向当前最成熟的 domain pack 上手路径，而不是重新定义 root 产品身份。generic lifecycle + workflow-plan front door 仍是 `autoresearch`；这里的 `hep_*` 路径只是在此基础上进入当前最强的 HEP evidence/project/run workflow family。

> 参数名以当前 Zod schema 为准；请始终以 MCP tool `inputSchema` 为最终准据。

## Generic First-Touch（先走 generic front door）

如果你还没初始化外部 project root，先走这一条：

1) `autoresearch init --project-root /absolute/path/to/external-project`
- 建立 `.autoresearch/` lifecycle/control-plane 状态。

2) `autoresearch status --project-root /absolute/path/to/external-project`
- 确认 lifecycle state、审批与后续 workflow-plan / computation 入口可见。

3) `autoresearch workflow-plan --recipe literature_to_evidence`
- 如需高层 literature planning front door，可先完成这一步；随后再按下方 HEP 路径进入当前最强的 domain-pack workflow family。

如果你只想先把一个研究题目收敛成后续 handoff contract，而不启动重流程，可以使用 `research_brainstorm` durable harness：

```bash
autoresearch workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"
```

它会持久化 `.autoresearch/state.json#/plan` 并派生 `.autoresearch/plan.md` read model，输出的 `next_contract` 可建议后续 `literature_landscape`、`literature_gap_analysis`、`derivation_cycle` 或 `review_cycle`，但不会自动升级到这些 recipe。这个 harness 是 planning-only：持久化的 `research_brainstorm.*` step tools 是 handoff authority，不是内置 runnable tool chain。host-native thinking process 不属于这个 recipe 的 contract；它也不是 idea-engine、不是 full research-team、不是新的 root front door。

研究记录约定：`research_notebook.md` 按问题逻辑、推导、claim 和不确定性组织；重要文献 note 必须全文/source-first 阅读，记录 section/page/equation/figure 覆盖，并用 LaTeX math 写科学记号；带日期的 run log、原始检索摘要、下载尝试和控制面观察写入 `research_plan.md` progress log 或 `artifacts/runs/<run_id>/`，再把稳定理解折回 notebook。`run_id` 应是 safe、sortable、readable 的研究标识，如 `20260502T023000Z-m3-branch-scan-r1`；若 `workflow-plan` 未显式传 `--run-id`，派生的 `<recipe>-<phase>` 只作为 planning placeholder。

## Draft Path（最简路径）

1) `hep_project_create`
- 关键参数：`name`（必填），`description`（可选）

2) `hep_run_create`
- 关键参数：`project_id`（必填），`args_snapshot`（可选）

3) `hep_run_build_citation_mapping`
- 关键参数：
  - `run_id`（必填）
  - `identifier`（必填，论文标识）
  - `allowed_citations_primary`（可选；质量优先建议提供人工审核后的 primary allowlist）
  - `include_mapped_references`（可选）

4) `hep_render_latex`
- 关键参数：
  - `run_id`（必填）
  - `draft`（必填，`ReportDraft` 或 `SectionDraft`）
  - `latex_artifact_name`（必填）
  - `section_output_artifact_name`（必填）
  - `verification_artifact_name`（必填）

5) `hep_export_project`
- 关键参数：`run_id`（必填）+ 各导出 artifact 名（按需）

## Client Path（高质量路径）

1) `hep_project_create` → `hep_run_create`
- 先建立 project/run 作为 run-scoped artifacts 的容器。

2) `hep_run_build_citation_mapping`（构建引用白名单）
- 后续写作验证和导出依赖该映射。

3) `hep_run_build_writing_evidence`（**必需**）
- 若缺少该步骤，后续依赖 evidence/embeddings 的流程会 fail-fast。

4) `autoresearch workflow-plan --recipe literature_to_evidence`
- 先在目标外部 project root 执行 `autoresearch init`，然后在该 root 内或通过 `--project-root` 调用；这是一个公开的 stateful front door，会直接通过 `@autoresearch/literature-workflows` 解析 checked-in workflow authority，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。对受限论文集分析使用 `inspire_critical_analysis`、`inspire_classify_reviews`、`inspire_theoretical_conflicts` 等 bounded operators。

> 说明：较底层的 checked-in Python `workflow-plan` consumer 与 internal regression/parser-residue 路径见 `docs/TESTING_GUIDE.md`；不要把它们当成新的 quickstart 默认入口。

5) `hep_export_project`
- 在通过验证与集成后导出完整项目成果。

## 常见提示

- 若返回 `invalidParams` 且提示缺少 `run_id`：先执行 `hep_project_create` + `hep_run_create`。
- 若 citation verifier 失败：重新执行 `hep_run_build_citation_mapping` 后重试。
- 若 token gate overflow：按返回的 overflow artifact 和 `next_actions` 收敛上下文规模，不要绕过门控。
