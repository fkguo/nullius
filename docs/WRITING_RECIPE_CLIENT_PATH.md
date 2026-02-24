# Writing MCP：Client Path（Host LLM 产出候选 → MCP 评审/验证 → 集成/导出）

Client Path：由 **Host LLM（你这边）** 负责生成每个 section 的 **N-best 候选**；MCP 负责：
- 生成与 `internal` 模式一致的 prompts（可复现）
- 接收你提交的候选（Zod 校验 + 可复现 artifacts + Judge/Verifier/Originality）
- 生成审稿回合的 prompt/context，并接收 reviewer report（用于决定是否需要再次迭代）
- 集成所有通过的 sections → `writing_integrated.tex`（并做 LaTeX compile gate）
- 导出 `research_pack.zip`

适用：你希望 **掌控 LLM 调用**（成本/模型/代理/缓存），但仍要 MCP 的“硬门 + Evidence-first 资产落盘”。

## 8 步 Recipe（不含一次性环境安装/启动）

### Step 1：创建 project/run

```json
{ "tool": "hep_project_create", "args": { "name": "my-writing", "description": "client-path" } }
```

```json
{ "tool": "hep_run_create", "args": { "project_id": "<project_id>" } }
```

### Step 2：选定 corpus（recids）

你可以用任意方式拿到 paper identifiers（常用是 recid / arXiv / DOI）。例如用 INSPIRE 搜索：

```json
{ "tool": "inspire_search", "args": { "query": "t:exotic hadrons date:2023->2026", "sort": "mostcited", "size": 25 } }
```

把返回结果中的 recids 作为下一步的 `identifiers`。

> 也可以用 `hep_inspire_search_export`（Evidence-first）把结果写到 run artifact 再读取。

### Step 3：生成写作 packets + client prompts（关键）

```json
{
  "tool": "inspire_deep_research",
  "args": {
    "mode": "write",
    "identifiers": ["inspire:<recid1>", "inspire:<recid2>"],
    "run_id": "<run_id>",
    "options": {
      "llm_mode": "client",
      "topic": "Exotic hadrons",
      "title": "Recent Progress on Exotic Hadrons",
      "target_length": "short"
    }
  }
}
```

输出要点：
- tool result 里会有 `client_continuation.next_actions`（按提示逐步完成：paperset/outline/证据/section candidates/judge 等）
- run artifacts 会写出 `writing_packets_sections.json`（后续 section 写作/集成的索引输入）
- 同时会生成 `writing_master.bib`（用于导出阶段的真实 BibTeX）

### Step 4：为每个 section 生成 N-best 候选（建议跟随 next_actions）

对每个 `section_index`（从 1 开始），建议先创建 candidates packet（它会给出 prompt + evidence context 的 URI，并产出下一步所需的 `next_actions`）：

```json
{
  "tool": "hep_run_writing_create_section_candidates_packet_v1",
  "args": { "run_id": "<run_id>", "section_index": 1 }
}
```

> 备注：如你只想先生成“写作 prompt + evidence context”，也可直接调用 `hep_run_writing_create_section_write_packet_v1`；`create_section_candidates_packet_v1` 在缺失时会自动先补齐 write packet。

然后按返回的 `next_actions`：
- 用 `hep_run_stage_content(content_type='section_output')` 把每个候选的 `SectionOutputSubmission` JSON 写入 run artifact
- 用 `hep_run_writing_submit_section_candidates_v1` 一次性提交 N-best 候选（standard 质量等级至少 2 个；publication 至少 3 个）

> 提示：staging 的 `content` 需要是 JSON 字符串（例如 `JSON.stringify(sectionOutputSubmission)`），避免把大段正文直接塞进 tool args。

### Step 5：Judge 选择最佳候选（每个 section）

```json
{
  "tool": "hep_run_writing_create_section_judge_packet_v1",
  "args": { "run_id": "<run_id>", "section_index": 1 }
}
```

Host LLM 根据 judge prompt 生成 `JudgeDecision`（JSON），然后提交：

```json
{
  "tool": "hep_run_writing_submit_section_judge_decision_v1",
  "args": {
    "run_id": "<run_id>",
    "section_index": 1,
    "judge_decision_uri": "<staging_uri of JudgeDecision JSON>"
  }
}
```

### Step 6：推进写作流水线 + 审稿回合（默认开启）

当所有 sections 都完成 judge 选择后，再次调用 `inspire_deep_research`（同一 `run_id`；可不传 `resume_from`，系统会自动从未完成的 step 继续）：

```json
{
  "tool": "inspire_deep_research",
  "args": {
    "mode": "write",
    "identifiers": ["inspire:<recid1>", "inspire:<recid2>"],
    "run_id": "<run_id>",
    "options": { "llm_mode": "client", "topic": "Exotic hadrons", "target_length": "short" }
  }
}
```

输出要点：
- 若返回里出现 `client_continuation.next_actions`，按其中提示执行（通常包含 `hep_run_writing_submit_review`）。
- 审稿 prompt/context 会写入 run artifacts（如 `writing_reviewer_prompt.md`、`writing_reviewer_context.md`）。

提交 reviewer report（JSON）：

```json
{
  "tool": "hep_run_writing_submit_review",
  "args": {
    "run_id": "<run_id>",
    "reviewer_report": { "severity": "minor", "summary": "..." }
  }
}
```

### Step 7：集成 sections → `writing_integrated.tex`（LaTeX compile gate）

```json
{ "tool": "hep_run_writing_integrate_sections_v1", "args": { "run_id": "<run_id>" } }
```

### Step 8：导出 `research_pack.zip`

```json
{
  "tool": "hep_export_project",
  "args": {
    "run_id": "<run_id>",
    "rendered_latex_artifact_name": "writing_integrated.tex",
    "rendered_latex_verification_artifact_name": "writing_integrate_diagnostics.json"
  }
}
```

## 常见失败与修复

- `section_index not found in writing_packets_sections.json`：先完成 Step 3（生成 packets），并确保你提交的 index 与 packets 一致。
- verifier/originality 失败：按 judge/verifier 返回的 `next_actions` 修复候选，再重新提交候选与 judge。
- `Missing BibTeX entries for one or more cite keys`：通常是你生成的内容里出现了未覆盖的 citekey；优先使用 Step 3 生成的 `writing_master.bib`（默认已写入 run），并避免手写未知 `\\cite{...}`。

## 环境变量（可选）

以下环境变量用于支持 `llm_mode='internal'` 的工具/路径（由 MCP 在本地直接调用 LLM）：

- `WRITING_LLM_TIMEOUT`：单次 LLM 调用超时（毫秒），默认 `90000`（90 秒）
- `WRITING_LLM_MAX_RETRIES`：单次 LLM 调用最大重试次数，默认 `3`

## 成本控制（建议）

> ⚠️ 若你使用会生成 LLM requests 的能力（例如 `inspire_critical_research(mode='theoretical')` 的裁决），请显式设置上限避免成本失控。

- `max_llm_requests`：默认 `50`，上限 `5000`；建议按预算显式设置（例如 `50–200`）
