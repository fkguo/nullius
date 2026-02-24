# Writing MCP：Draft Path 最短闭环（Draft JSON → LaTeX → Pack）

Draft Path：你在 MCP 外部（本地 LLM / 人工）产出结构化 `ReportDraft/SectionDraft` JSON；MCP 负责**确定性渲染**与**硬验证（verifier）**，最后导出 `research_pack.zip`。

## 适用场景与限制

- 适用：你已经有草稿内容（或让外部 LLM 生成内容），需要可复现的渲染/导出闭环。
- 限制：
  - MCP 不会在本路径里“自动修复”引用/原创性问题；验证失败会直接报错，需要你回到上游修改 JSON。
  - **事实句（`type: "fact"`）必须提供 `recids`**；否则 verifier 会报 `missing_citation`。
  - 导出阶段要求 `master.bib` 覆盖 LaTeX 里出现的所有 citekey：若内容里有 `\\cite{...}`，则必须在 `writing_master.bib` 或 `bibliography_raw.json` 中找到对应 BibTeX；**任意缺失都会导致** `hep_export_project` hard fail。

## 5 步 Recipe（不含一次性环境安装/启动）

### Step 1：创建 project/run

```json
{ "tool": "hep_project_create", "args": { "name": "my-writing", "description": "draft-path" } }
```

```json
{ "tool": "hep_run_create", "args": { "project_id": "<project_id>" } }
```

### Step 2：准备 allowlist + BibTeX（推荐）

`allowed_citations`（recid tokens）的来源（任选其一或组合）：

1. 从 INSPIRE 搜索结果：`inspire_search` / `hep_inspire_search_export`
2. 从已有论文引用：`inspire_literature(mode=get_references)`
3. 手动指定：你明确知道要引用的论文 recid

recid token 格式：

- `"627760"` 或 `"inspire:627760"` 都可（建议统一用 `"inspire:<recid>"`）

为了让导出包中的 `master.bib` 覆盖到被引用的 citekeys（避免 export 失败），推荐运行 `hep_run_build_citation_mapping`，写出：
- `allowed_citations.json`
- `citekey_to_inspire.json`
- `bibliography_raw.json`

示例（把你的 corpus recids 放进 `allowed_citations_primary`；`identifier` 可以是 recid / arXiv / DOI）：

```json
{
  "tool": "hep_run_build_citation_mapping",
  "args": {
    "run_id": "<run_id>",
    "identifier": "arXiv:XXXX.XXXXX",
    "allowed_citations_primary": ["inspire:627760", "inspire:1833986"],
    "include_mapped_references": true
  }
}
```

> 提示：若你在 Step 4 没传 `allowed_citations`，`hep_render_latex` 会自动读取 run artifact `allowed_citations.json`；同理，若没传 `cite_mapping` 会自动读取 `citekey_to_inspire.json`（若存在）。

### Step 3：（可选，但强烈推荐）构建写作证据（P1+：`continue_on_error` + source status）

如果你需要后续做 evidence 检索/回放（或调试 source 失败原因），先构建 writing evidence：

```json
{
  "tool": "hep_run_build_writing_evidence",
  "args": {
    "run_id": "<run_id>",
    "continue_on_error": true,
    "latex_sources": [{ "identifier": "arXiv:XXXX.XXXXX" }]
  }
}
```

- `continue_on_error`：默认 `false`。设为 `true` 时，单个 source 失败不会中断整个 run，但会被记录为 `failed/skipped`。
- `writing_evidence_source_status.json`：每个 source 的 `success/failed/skipped`、`error_code`、`duration_ms`、`items_extracted` 及汇总统计（用于定位“为什么没抽到/为什么失败”）。

### Step 4：外部 LLM 输出 `ReportDraft` JSON → `hep_render_latex`（硬门）

外部 LLM / 人工产出 `ReportDraft`（示例）：

```json
{
  "version": 1,
  "title": "Recent Progress on Exotic Hadrons",
  "sections": [
    {
      "version": 1,
      "title": "Introduction",
      "paragraphs": [
        {
          "sentences": [
            {
              "sentence": "The discovery of the X(3872) in 2003 by Belle opened a new era in hadron spectroscopy.",
              "type": "fact",
              "is_grounded": true,
              "recids": ["627760"]
            }
          ]
        }
      ]
    }
  ]
}
```

渲染（verifier 会硬失败：missing/unauthorized/orphan citations）：

```json
{
  "tool": "hep_render_latex",
  "args": {
    "run_id": "<run_id>",
    "draft": { "...": "ReportDraft JSON here" }
  }
}
```

### Step 5：`hep_export_project`

```json
{ "tool": "hep_export_project", "args": { "run_id": "<run_id>" } }
```

会生成并打包：
- `coverage_report.json`
- `rendered_latex_verification.json`
- `report.tex` / `report.md`
- `master.bib`
- `research_pack.zip`

## 常见失败与修复（按阶段）

### A) source 失败（Step 3：evidence build）

- 查看 `writing_evidence_source_status.json`：定位是下载失败/解析失败/预算限制/类型过滤等。
- `continue_on_error=false` 时：首个失败会导致 tool 直接失败；改为 `true` 可先拿到部分产物用于排障。

### B) verifier 失败（Step 4：render）

- `missing_citation`：事实句没有 `recids`（或为空）→ 为每个事实句补齐 `recids`（或将该句改为非 grounded 类型）。
- `unauthorized_citation`：引用不在 allowlist → 把该 recid 加入 `allowed_citations`（或修订文本）。
- `orphan_citation`：内容里出现 `\\cite{...}` 但 attribution 里没有对应 citation → 不要在 `sentence`/`sentence_latex` 里手写 `\\cite{...}`；让系统根据 `recids` 生成引用。
- `Missing allowed_citations`：未提供 allowlist 且 run 中无 `allowed_citations.json` → 运行 `hep_run_build_citation_mapping` 或在 `hep_render_latex` 里显式传 `allowed_citations`。

### C) export 失败（Step 5）

- `Missing BibTeX entries for one or more cite keys`：说明 LaTeX 里有 citekey 没有对应 BibTeX → 先生成/补齐 `writing_master.bib`（例如走 `inspire_deep_research(mode=write)` 路径），或确保 `bibliography_raw.json` 覆盖到所有被引用的 citekeys。
