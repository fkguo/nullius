# knowledge_base

This folder stores evidence and priors used by the project. It is required before any team cycle.

Skepticism policy (real research):
- Papers/books/docs can be wrong. Treat any imported statement as a *hypothesis*, not authority.
- For any statement used in a core derivation or headline number, do at least one of:
  - re-derive it in the notebook body,
  - reproduce a key numeric/limit check from artifacts,
  - or mark it explicitly as unverified (with a concrete plan + kill criterion in a methodology trace).
- If sources disagree, record both and add a discriminating test instead of picking by authority.

## literature/

- Notes and excerpts from primary sources
- One file per topic or paper cluster
- Include a `RefKey: <Key>` line near the top of each note（供真实 scaffolded 项目根里的 `Draft_Derivation.md` notebook 引用）。
- Keep the first H1 title meaningful (used for human-readable links in Capsule I).
- For INSPIRE-based notes, also include:
  - `INSPIRE recid: <integer>`
  - `Citekey: <texkey>`
  - `Authors: <FirstAuthor et al.>`
  - `Publication: <journal / arXiv / status>`
- Include an external link if available (prefer INSPIRE/arXiv/DOI; GitHub is allowed for code).
- 不要把整棵论文源码树或源码压缩包长期纳入这个 package repo；这里保留紧凑的笔记与稳定 metadata anchor，原始源码在需要时于 project-local 或 scratch 位置按需重新抓取。
- In the project-local `Draft_Derivation.md` notebook（Capsule I）, prefer linking like:
  ```md
  - [RefKey — Authors — Title](knowledge_base/literature/<RefKey>.md)
  ```
- Recommended fields for scientific skepticism (optional but encouraged):
  - `Verification status: metadata-only | skimmed | spot-checked | replicated | contradicted`
  - `What was checked:` (equation IDs / limits / reproduction target)
  - `Known issues / errata / disagreements:` (with links)

### Reading depth policy（是否需要“精读”？）

不需要对所有文献都精读；我们采用“渐进式加深”的策略，把阅读深度当成可审计的状态，而不是二选一。

建议把每篇笔记的 `Verification status` 视为“阅读深度/验证强度”的标记：
- `metadata-only`：仅有标题/作者/摘要/链接；尚未系统阅读正文。
- `skimmed`：通读摘要/引言/结论，并快速浏览方法/关键图表；尚未做独立核对。
- `spot-checked`：对至少 1 个关键点做了可复现核对（公式编号/极限/单位/数值点/与代码对照）。
- `replicated`：复现了至少 1 个关键结果（图/表/数值），并有 artifacts 指针。
- `contradicted`：发现与本项目/其他来源存在明确矛盾，且已有区分测试或证据记录。

什么时候需要把 `metadata-only/skimmed` 升级为“精读/复核”？
- 任何要进入 **核心推导/Headline numbers/默认算法选择/主结论/新意宣称（A5）** 的引用：至少 `spot-checked`；对“最接近的 prior work”建议做到 `replicated`（能复就复，不能复就做强诊断代理）。
- 任何要“照着论文实现算法/代码”的情况：至少达到 `skimmed` 并附带一个可复现核对点（否则等同把黑箱当真）。
- ingest 阶段允许大量 `metadata-only`（用于 coverage/筛选）；但必须在后续 workflow（reproduce / derivation_check / revision）里对真正依赖的少数关键文献补齐升级。

### Markdown math hygiene (rendering safety)

- Use `$...$` / `$$...$$` (do not use `\(` `\)` `\[` `\]`).
- In Markdown tables, avoid literal `|` inside `$...$`; prefer `\lvert...\rvert` (or `\lVert...\rVert`) to avoid breaking table parsing.
- Avoid `\slashed{...}` in Markdown math when possible; prefer a portable fallback like `\not\!` (warn-only by default).
- In `$$...$$` blocks, no line may start with `+`, `-`, or `=` (prefix with `\quad`).
- Do not split one multi-line equation into back-to-back `$$` blocks; keep one `$$...$$` block.
- Deterministic autofix helper: `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_math_hygiene.py --root knowledge_base --in-place`
- Avoid accidental doubled backslashes in math (common LLM/TOC escape artifact), e.g. `\\Delta`, `\\gamma\\_{\\rm lin}`:
  - Fix helper: `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_double_backslash_math.py --root knowledge_base --in-place`

## methodology_traces/

Validated procedures and reproducibility traces:
- short summaries of what was checked
- commands and outputs
- known limitations
- algorithm-search notes and stability decisions for numerics
- append-only query log (created by scaffold): [literature_queries.md](methodology_traces/literature_queries.md)

## priors/

Project conventions and fixed assumptions:
- notation
- normalization
- units
- known constraints
