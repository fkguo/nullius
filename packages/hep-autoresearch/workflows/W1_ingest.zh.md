# W1 — Paper ingestion（文献入口）

## 目的

把“找论文/抓源文件/写阅读笔记/记录可疑点”变成稳定、可批处理、可回归的流程。

## 输入

至少满足其一：
- `inspire_recid`
- `arxiv_id`
- `doi`
- `query`（仅用于 discovery；最终必须落到 stable anchor）

可选：
- `refkey`（如不提供则自动生成，但必须稳定可复现）

## 输出（产物）

必需：
- `knowledge_base/literature/<refkey>.md`（reading note）
- `knowledge_base/methodology_traces/literature_queries.md`（append-only 记录）

建议：
- `references/<anchor>/`（源文件快照：LaTeX/PDF/metadata）
- `artifacts/runs/<TAG>/ingest/manifest.json`（抓取与落盘的可审计记录）

## 步骤（MVP）

1) 解析输入到 stable anchor（优先 INSPIRE recid → arXiv → DOI）。
2) 抓取 metadata（标题/作者/时间/链接）。
3) 下载源文件（优先 LaTeX；无则 PDF）。
4) 生成 reading note：
   - RefKey / recid / citekey（如有）/ links
   - `Verification status: metadata-only | skimmed | spot-checked | replicated | contradicted`
   - 3–7 条关键要点
   - 2–5 条“可疑点/待核查点”（显式可执行）
   - 若当前仅能做到 `metadata-only`：写清楚“下一步要读/要核对什么”（把阅读债务显式化）
5) 记录一次查询日志（含选择理由与本地笔记链接）。

## 门禁（验收）

- reading note 必须包含：`RefKey:`, `Links:`, 且链接可点击。
- reading note 必须包含 `Verification status:`（W1 阶段允许 `metadata-only`；但后续 workflow 依赖该论文时必须升级）。
- 若有 INSPIRE：必须包含 `INSPIRE recid:` 与 `Citekey:`（如可得）。
- 任何 discovery（关键词/Scholar）都必须在日志里记录 query→shortlist→选择理由，并最终落到 stable anchor。

## 扩展路线

- v1：批处理 ingestion（一次输入 N 篇），生成索引页与“待核查队列”。
- v2：对 LaTeX 做结构化抽取（符号表、关键公式定位、结果候选列表），为 W2/W4 提供输入。
