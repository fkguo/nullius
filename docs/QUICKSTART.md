# QUICKSTART

本指南提供两条最常用路径：
- **Draft Path**：你已准备好结构化草稿数据，追求最短落地路径。
- **Client Path**：你希望走高质量、Evidence-first 的完整写作流程。

> 参数名以当前 Zod schema 为准；请始终以 MCP tool `inputSchema` 为最终准据。

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

4) `inspire_deep_research`（`mode=write`, `options.llm_mode=client`）
- 读取返回中的 `next_actions`，按步骤执行 packet 生成、候选提交、judge 与验证流程。

5) `hep_run_build_writing_critical`（推荐；通常在已有 `writing_claims_table.json` 后执行）
- 关键前置：`recids`（必填）+ `writing_claims_table.json`（默认 claims artifact）
- 生成 `writing_conflicts.json` / `writing_stance.jsonl` / `writing_evidence_grades.json` / `writing_critical_summary.json`

6) `hep_export_project`
- 在通过验证与集成后导出完整项目成果。

## 常见提示

- 若返回 `invalidParams` 且提示缺少 `run_id`：先执行 `hep_project_create` + `hep_run_create`。
- 若 citation verifier 失败：重新执行 `hep_run_build_citation_mapping` 后重试。
- 若 token gate overflow：按返回的 overflow artifact 和 `next_actions` 收敛上下文规模，不要绕过门控。
