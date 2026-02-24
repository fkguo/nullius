# research-writer（Codex skill）

`research-writer` 用于从 `research-team` 项目脚手架生成一份可用于 arXiv 的论文目录：
- RevTeX4-2，`12pt`，`onecolumn`
- 确定性的 provenance 线索接线
- BibTeX 卫生处理（RevTeX4-2）
- 确定性的 Markdown 数学转义检查（例如 `\\Delta` → `\Delta`）

English: `README.md`（英文版）。

## 依赖

- `bash`, `python3`
- 可选（编译）：TeX 工具链 + `latexmk`
- 可选（分节写作，`--run-models`）：本地 `claude` + `gemini` CLI（以及 runner skills）
- 可选（BibTeX 拉取，`--fetch-bibtex`）：网络访问（INSPIRE/DOI）

## 一键 scaffold

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-team-project \
  --tag M1-r1 \
  --out paper/
```

可选：传入 run-card（不透明 JSON，用于上游可追溯）；会被拷贝到 `paper/`，并在 `paper/run.json` + `paper/export_manifest.json` 中记录指针/摘要：

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-team-project \
  --tag M1-r1 \
  --out paper/ \
  --run-card /path/to/run_card.json
```

## 可选：分节写作（opt-in 模型调用）

按 section 生成 `*_final.tex`（writer → auditor），并保存 diff + trace；不修改 `paper/main.tex`。

```bash
bash scripts/bin/research_writer_draft_sections.sh \
  --project-root /path/to/research-team-project \
  --paper-dir paper/ \
  --tag M1-r1 \
  --run-id D1 \
  --all \
  --run-models
```

然后（可选编译）：

```bash
cd paper && latexmk -pdf main.tex
```

## 可选：consume MCP 导出的 `paper/`（确定性）

若外部流水线已导出 `paper/` 且包含 `paper/paper_manifest.json`：

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh --compile
```

