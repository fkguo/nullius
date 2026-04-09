---
name: paper-reviser
description: 面向学术论文（LaTeX 草稿）的内容优先逐句修订（通读理解 → 逐句修订 → 输出干净稿 + diff + tracked changes → 审核与查证清单）。
metadata:
  short-description: 论文逐句修订（LaTeX；干净稿 + diff + tracked）
---

# Paper Reviser（LaTeX；内容优先修订）

适用场景：
- 你希望像导师改论文一样，优先关注**表述是否正确/精确**（内容第一），
- 在尽可能保持原意与写作风格的前提下，改进逻辑结构与英文表达，
- 同时产出**干净稿**与**保留原文痕迹的修订文件**（diff / tracked changes），
- 并生成需要**文献查证/进一步确认**的清单。

本 skill **不放进** `research-writer` 的原因：
- `research-writer` 侧重 arXiv-ready RevTeX 成稿脚手架、引用与溯源等“出版流程”；
- `paper-reviser` 侧重对任何 LaTeX 模板/类文件的论文草稿做“内容优先”的逐句修订，通常在写作早期反复使用。

## 输出内容

对 `draft.tex`，会写入一个输出目录（run dir），常见文件包括：
- `clean.tex`：干净稿（若是完整文档，会保留原 preamble，只修改正文）
- `changes.diff`：统一 diff（original → clean）
- `tracked.tex`：带修订标记的版本（若系统有 `latexdiff` 则使用；否则用可编译的注释标注形式）
- `changes.md`：逐条修改点 + 为什么改（rationale）
- `open_questions.md`：需要作者确认/外部查证的问题
- `audit.md`：独立审稿人视角的意见（含 READY/NOT_READY）
- `verification_requests.md`：简单但重要 statement 的查证请求（含建议检索词）
- `verification_requests.json`：机器可读的查证任务清单（便于工作流编排；schema_version=1）
- `deep_verification.md`：由 `verification_requests.md` 驱动的“逐步不跳步”推导/数学核验（使用本地 `codex` CLI）
- `deep_verification_secondary.md`：可选：第二个独立推导/数学核验（`--secondary-deep-verify-*`；用于冗余交叉检查）
- 以及 `readthrough.md` / `risk_flags.md` / `run.json` / `trace.jsonl` 等辅助与可追溯文件

## 工作流（模拟人类导师）

1) **整体通读**（不重写）：先理解文章在讲什么、核心 claims、结构、符号与定义。
2) **逐句修改**：在全局一致性的约束下逐句修订（内容正确性优先，其次是英文，再其次是 LaTeX 排版）。
3) **独立审核**：指出过度断言、证据不足、缺引用、LaTeX 安全风险，并产出查证清单。
4) **深度核验（Codex）**：根据 `verification_requests.md` 对关键推导/数学步骤做逐步检查（不跳步）。
   - 可选：通过 `--secondary-deep-verify-*` 再跑一个独立核验（Gemini/Claude）做冗余交叉检查。
5) **可选修复回合**：根据审核意见（audit + deep verification）小步修补并复审（由 `--max-rounds` 控制）。

## 输入模式：完整文档 vs 片段

工具会自动判断输入是否为完整 LaTeX 文档：
- **完整文档**：存在首个未注释的 `\\begin{document}`。
  - preamble 视为**只读**，只修改正文；
  - `clean.tex = 原 preamble + 修改后的正文`。
- **片段**：没有 `\\begin{document}`。
  - 直接对片段全文进行修改。

## 快速开始

先在 shell 里设置路径变量：

```bash
SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
PAPER_REVISER="$SKILLS_DIR/paper-reviser"
RESEARCH_TEAM="$SKILLS_DIR/research-team"
```

### 1) 冒烟测试（不调用模型）

```bash
python3 "$PAPER_REVISER/scripts/bin/paper_reviser_edit.py" \
  --in /path/to/draft.tex \
  --out-dir /tmp/paper_reviser_out \
  --stub-models
```

### 2) 实际运行（opus 写手 + gemini-3-pro-preview 审核）

```bash
python3 "$PAPER_REVISER/scripts/bin/paper_reviser_edit.py" \
  --in /path/to/draft.tex \
  --out-dir /tmp/paper_reviser_out \
  --run-models \
  --writer-backend claude --writer-model opus \
  --auditor-backend gemini --auditor-model gemini-3-pro-preview
```

常用参数：
- `--max-rounds 2`：允许 1 次“审核→修复→复审”的回合
- `--context-file evidence.md`：把外部查证的结论/引用以“只读上下文”提供给写手（见下一节）
- `--context-dir evidence/`：追加多个证据文件（*.md/*.txt，按文件名排序；便于编排/自动化）
- `--mode fast`：快速修订模式（跳过推导/数学深度核验；仍会跑写手+审稿人；并关闭 secondary deep verification）
- `--no-codex-verify`：跳过推导/数学深度核验（如果你在意物理/数学正确性，不建议）
- `--fallback-auditor claude --fallback-auditor-model <MODEL>`：当 Gemini 审核输出为空或格式损坏时自动回退
- `--secondary-deep-verify-backend gemini --secondary-deep-verify-model <MODEL>`：可选冗余核验（第二个逐步不跳步核验器）
- `--codex-timeout-seconds 900`：`codex exec` 深度核验硬超时（秒）
- `--codex-timeout-policy stub|allow-secondary|fail`：超时处理策略
- `--force`：覆盖已存在的输出目录

稳健性说明：
- 审核器 END-only 容错：若 `AUDIT_MD` 只有 END 缺 BEGIN，工具会按隐式 BEGIN 尝试修复解析。
- Gemini 审核器异常输出：会先做一次“严格 marker”重试；若仍失败且启用了 `--fallback-auditor=claude`，会自动回退 Claude 审核。
- clean-size 检查采用自适应口径：`--min-clean-size-ratio` 同时考虑 raw bytes 与 non-comment bytes（best-effort 去注释），减少注释占比高时的误报。
- deep verifier 超时可审计：超时且策略为 `stub` / `allow-secondary` 时，`deep_verification.md` 会写入 `VERDICT: NOT_READY` 和超时原因。

## 查证闭环（推荐）

1) 先看 `verification_requests.md`，挑出关键 statement 做快速文献核验；
   - 若用于编排/自动化，优先使用机器可读的 `verification_requests.json`。
2) 把核验结果写成一个上下文文件（例如 `evidence.md`），包括：
   - 找到的参考文献（或 DOI/arXiv/链接信息），
   - 1-2 句说明为何支持/不支持该 statement，
   - 你希望在正文里采用的措辞边界（保守/强断言等）。
3) 重新运行并带上 `--context-file evidence.md`：

```bash
python3 "$PAPER_REVISER/scripts/bin/paper_reviser_edit.py" \
  --in /path/to/draft.tex \
  --out-dir /tmp/paper_reviser_out_r2 \
  --run-models \
  --writer-backend claude --writer-model opus \
  --auditor-backend gemini --auditor-model gemini-3-pro-preview \
  --context-file /path/to/evidence.md \
  --max-rounds 1
```

### 生成 research-team 查证计划（JSON）

为了让研究工作流更容易编排“文献查证”步骤，可以把
`verification_requests.json` 转成一个确定性的 `literature_fetch.py` 任务计划：

```bash
python3 "$PAPER_REVISER/scripts/bin/build_verification_plan.py" \
  --in /tmp/paper_reviser_out/verification_requests.json \
  --out /tmp/paper_reviser_out/verification_plan.json \
  --kb-dir verification/knowledge_base/literature \
  --trace-path verification/knowledge_base/methodology_traces/literature_queries.md \
  --arxiv-src-dir verification/references/arxiv_src
```

随后（通常在一个 approval gate 下）执行计划中的任务，把核验结论写成证据文件。
最后用 `--context-file evidence.md` 或 `--context-dir evidence/` 回灌再跑一轮修订。

### HEP 文献核验（INSPIRE/arXiv）

对于高能物理及相关方向，推荐的实践闭环是：

1) 用 `research-team` 里已经实现的 `literature_fetch.py` 做 INSPIRE/arXiv 检索，并在需要时下载 arXiv LaTeX 源码：

```bash
# INSPIRE 检索（返回候选记录）
python3 "$RESEARCH_TEAM/scripts/bin/literature_fetch.py" \
  inspire-search --query "t:your topic AND date:2020->2026" -n 5

# 拉取某条 INSPIRE 记录（可选：写入 knowledge_base/ 下的笔记）
python3 "$RESEARCH_TEAM/scripts/bin/literature_fetch.py" \
  inspire-get --recid 1234567 --write-note

# 下载 arXiv LaTeX 源码（保存到 references/arxiv_src/<arxiv_id>/）
python3 "$RESEARCH_TEAM/scripts/bin/literature_fetch.py" \
  arxiv-source --arxiv-id 2101.01234 --out-dir references/arxiv_src
```

2) 快速阅读下载到本地的源文件（或 PDF），把核验结论写成一个 `evidence.md`（支持/不支持、为何、推荐措辞边界）。
3) 重新运行 `paper-reviser` 并带上 `--context-file evidence.md`，让写手在正文中落实这些核验结论。

如果你所在的代理环境里也提供了 `hep-mcp` / `@autoresearch/hep-mcp`，同样可以用它的 INSPIRE/arXiv 检索与源码下载能力来做查证；建议把“检索/下载”和“文本修改”分开，以便审计与复现。

## 范围与安全说明

- 工具**允许强化/新增 claim**（更像导师的改法），但应避免“无证据却自信地升级断言”；必要时应在 `open_questions.md` / `verification_requests.md` 中明确标注需要查证。
- 复杂计算的复现与验证**不在本 skill 范畴**；会以问题/查证请求的方式输出。
- LaTeX 安全属于 best-effort：工具尽量避免修改 verbatim 类环境（verbatim/lstlisting/minted/comment），但仍建议你最终编译检查。
- 工具一次只处理**单个 `.tex` 文件**。如果工程使用 `\\input{}`/`\\include{}` 多文件结构，建议逐个文件跑（或先拼接后再跑）；跨文件 label/引用会导致“孤儿引用”警告出现误报。
- 默认参数（按需覆盖）：`--encoding utf-8`、`--min-clean-size-ratio 0.85`、`--max-rounds 1`、`--codex-timeout-seconds 900`、`--codex-timeout-policy stub`。
- 只有在系统安装了 `latexdiff` 时，`tracked.tex` 才会是可视化的红线稿；否则是“可编译的注释标注版”（便于 grep 审计，但不追求美观）。
