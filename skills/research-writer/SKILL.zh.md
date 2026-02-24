---
name: research-writer
description: （中文说明 / translation）从 `research-team` 项目脚手架或校验一份可用于 arXiv 的 RevTeX4-2（12pt, onecolumn）论文目录；提供 provenance 线索、BibTeX 卫生处理，以及确定性的 Markdown/LaTeX 检查（可选：Claude+Gemini 分节写作）。
---

# Research Writer（中文说明）

> 说明：本文件是 `SKILL.md` 的中文翻译/释义，可能会滞后。**调用契约 SSOT 以 `SKILL.md` 为准。**

面向 agent 的 skill：给定一个 `research-team` 项目根目录（包含 `Draft_Derivation.md`、`knowledge_base/`、`artifacts/`），生成一份**结构自洽、可审计、可迭代**的论文目录，并提供确定性的卫生检查工具。

主要入口：
- `scripts/bin/research_writer_scaffold.sh`：从 `research-team` 项目脚手架生成 `paper/`（默认确定性；可选网络：`--fetch-bibtex`）。
- `scripts/bin/research_writer_draft_sections.sh`：可选分节写作（writer → auditor），写 trace + evidence gate（默认不调用模型；仅 `--run-models` 才调用外部 CLI）。
- `scripts/bin/research_writer_consume_paper_manifest.sh`：对 MCP 导出的 `paper/` 做 fail-fast 校验、Bib 分层卫生处理，并可选 `latexmk` 编译（确定性；无网络/无模型）。

> 备注：`.sh` 是薄封装（wrapper），参数与对应 `.py` CLI 一致；也可以直接用 `.py --help` 查看完整参数面。

默认论文样式：
- RevTeX 4.2，`12pt`，`onecolumn`（英文优先）。

## 依赖

必需：
- `bash`, `python3`

可选（仅在特定流程需要）：
- TeX 工具链（例如 TeX Live/MiKTeX）+ RevTeX 4.2；`latexmk`（用于 consume 的 `--compile`）。
- 网络（仅 `--fetch-bibtex` 会访问 INSPIRE/DOI）。
- 本地 `claude` + `gemini` CLI（仅 `--run-models` 会调用）。

## run-card + export manifest（与 hep-autoresearch 对接）

三个入口都支持可选参数：`--run-card <path>`：
- run-card 作为**不透明 JSON**处理：原样拷贝进输出目录（便于追溯，不要求理解全部字段）。
- 同时会写入 best-effort 摘要（如 `run_id`、`backend`、`approval_trace_id`）到 `paper/run.json`（scaffold/draft-sections）或 `paper/build_trace.jsonl`（consume）。

三个入口也会写一个最小的 `export_manifest.json`，供上层（例如 `hep-autoresearch`）导入并转写为其 `artifacts/` 结构。

## 快速开始：一键 scaffold

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-team-project \
  --tag M1-r1 \
  --out paper/
```

输出（`--out paper/`）：
- `paper/main.tex`
- `paper/references.bib`
- `paper/figures/`
- `paper/latexmkrc`
- `paper/README.md`
- `paper/run.json`
- `paper/export_manifest.json`
- 若 `--run-card`：`paper/run_card.json`（或 `paper/run_card.<sha12>.json`）

## 可选：分节写作（opt-in；writer → auditor）

只有显式传 `--run-models` 才会调用外部 LLM CLI（否则用 `--stub-models` 或 `--dry-run`）。

```bash
bash scripts/bin/research_writer_draft_sections.sh \
  --project-root /path/to/research-team-project \
  --paper-dir paper/ \
  --tag M1-r1 \
  --run-id D1 \
  --all \
  --run-models
```

输出目录：`paper/drafts/<run-id>/`（包含 `run.json`、`trace.jsonl`、`export_manifest.json`；若 `--run-card` 会拷贝 `run_card*.json`）。

## Consume：对 MCP 导出 paper/ 做发布前校验（确定性）

从项目根目录（默认 manifest 路径为 `paper/paper_manifest.json`）：

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh --compile
```

或显式指定：

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh \
  --paper-manifest /path/to/paper/paper_manifest.json \
  --compile
```

输出：
- `paper/build_trace.jsonl`
- `paper/export_manifest.json`
- 若 `--run-card`：`paper/run_card*.json`

## 从 hep-autoresearch 调用（推荐模式）

上层 orchestrator（例如 `hep-autoresearch`）建议：
1) 生成/维护 run-card（记录 prompts/tools/approvals；由上层负责 schema 与审批逻辑）。
2) 调用本工具时传 `--run-card`，确保产物自描述、可追溯。
3) 读取 `paper/export_manifest.json` 并将相关文件复制/快照到上层 `artifacts/`（由上层负责）。

上层 “artifacts triplet”（三件套）示例映射（由上层实现）：
- `artifacts/runs/<run_id>/run_card.json`
- `artifacts/runs/<run_id>/manifest.json`（可存 `paper/export_manifest.json`）
- `artifacts/runs/<run_id>/analysis.json`（可存编译摘要/告警；或 consume 的 `paper/build_trace.jsonl` 提取结果）

