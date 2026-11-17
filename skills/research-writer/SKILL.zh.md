---
name: research-writer
description: 由当前宿主 agent 基于研究笔记、文献和结果撰写并审阅真实论文；提供空白 RevTeX 模板、外部 paper manifest 接入、文献/交叉引用检查、结果溯源和交付支持。研究笔记继续保存完整的人类科研记录。
---

# Research Writer（中文说明）

[SKILL.md](SKILL.md) 定义完整调用契约。本说明同步其主流程。

## 主流程

1. 阅读任务目标、`research_notebook.md`、`research_contract.md`、相关知识库、原始文献段落和运行产物；根据研究问题选择结构和材料。标题、摘要和自动摘录只用于定位材料。
2. 直接写入真实 `main.tex` 或被它包含的章节文件，核实修改进入构建。已有论文先比较版本；没有合适模板时才初始化空白 scaffold。
3. 文献性主张执行现有 `claim-grounding`：核对文献身份、阅读具体支持段落、记录并读取判定，对不支持或冲突的说法改写或限定。计算性结果读取推导和运行证据并执行适用验证，区分假设、引文陈述与独立检查结果。
4. 实质性论文按 [referee-review](../referee-review/SKILL.md) 的程序，委派独立宿主 agent 或现有 [review-swarm](../review-swarm/SKILL.md) launcher 审查真实稿件及原始证据。给审阅者能访问的材料，要求检查反例、逻辑缺口、遗漏验证；读取意见后修改实际文件，再按变化复核。packet 标题、报告 schema 或机械检查不能作出科学审稿结论。无需固定 provider 对、章节数量或审查轮数；无法独立审阅时明确保留该限制。
5. 对当前稿件执行适用的交叉引用、结果溯源、图表 display acceptance 与构建检查，并读取报告。机械通过不能证明科学正确；审阅者仍需核对覆盖范围、结果数值与论证。需要 PDF 时编译实际文件并检查最终页面；工具缺失或构建失败就是尚未完成。
6. 读取当前 `export_manifest.json`，使用已有 research-team export 的 `--writer-export` / `--include` 收集文件及必要依赖，检查导出后的可阅读成品，向用户提供链接、材料与未决问题。交付状态记入 `research_plan.md` / `project_index.md`；笔记保留科学结论和必要成果链接，不承载工具送达日志。只创建 manifest 不算交付。

`research_notebook.md` 保留完整推导、研究过程、实验、失败、解释与开放问题，是可供人阅读的科研笔记；`research_contract.md` 管理稳定契约和指针。论文只是针对具体读者的综合，不替代或缩减笔记。仅需笔记的阶段不要求论文或 arXiv 包。

## 工具

从 skill 目录运行，或使用已安装脚本绝对路径：

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/project --tag M1-r1 --out /path/to/project/paper
```

scaffold 仅创建空白 RevTeX 格式、文献文件、图目录和初始化元数据。不抽取正文、公式、第一张图或结果字典；不调用模型或网络；不覆盖已有目录。可选 `--run-card` 原样复制合法 JSON，`--title` / `--authors` 接受纯文本。初始状态为 `blank_scaffold`、`not_run`。

外部生产者提供 `paper_manifest.json` 时：

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh \
  --paper-manifest /path/to/paper/paper_manifest.json --compile
```

消费者保留外部契约，校验文件并记录构建。`--compile` 请求缺少 `latexmk` 或构建失败会失败；旧 PDF 不作当次成功证据。它不自动执行科学审阅。没有该外部契约的普通论文可在目录运行 `latexmk -pdf main.tex`；初始 export manifest 不会因此自动升级，导出时需显式包括当前 PDF 等依赖。

成功编译在同一 export manifest 的 `input_hashes` / `output_hashes` 中绑定当前源文件和产物；本次 TeX `.fls` 记录补充实际项目内输入。export 会复核这些绑定；源文件或产物变化后应重新构建。缺少绑定的旧编译凭据需要重建才能作为当前成功证据；历史文件仍可显式包括并说明其历史状态。

## 检查与接收

- 文献性主张：执行并读取 claim-grounding 报告中的支持段落、身份和 verdict。
- LaTeX 交叉引用：`check_latex_xrefs.py --root paper`。
- 采用本项目结果的稿件：维护真实 `traceability_manifest.json`，运行 `check_result_traceability.py --root paper --report paper/result_traceability_report.md` 并处理报告。
- 科学图表：执行现有 figure-hygiene 的数值/单位/显示语义检查和最后的 display acceptance，读取并处理输出。
- Markdown：用现有 markdown-hygiene 检查目标显示环境，检查修改；合法 TeX 换行不能批量折叠。
- 文献兼容：`fix_bibtex_revtex4_2.py` 仅处理格式，不证明元数据或主张。
- 可移植提交包：使用已有 `research_writer_package_arxiv.py`；按任务需要保留验证证据。

结果溯源要求图和标注数值绑定真实 run id、代码版本、环境指纹。数字使用邻近 `% origin: <id>` 注释，图复制为目录内真实文件并记录校验和。checker 检查已声明绑定，不发现所有漏标数值，也不判断相邻数字是否等于来源值；这些要由写作 agent 和审阅者核实。完整 schema、失败语义和例子见英文契约。

## 可选写作与语料辅助

物理写作风格和 discussion guidance 是辅助思考，不是固定论文结构或自动判定标准。现有 corpus downloader、reading-pack generator、共享语义 curator 和通用模型 runners 保留。阅读包和可选模型 argument map 只作为分析输入；归纳时阅读原文、比较论证和反例，不从词频或模型同词判断科学共识。操作示例见 [RUNBOOK.md](RUNBOOK.md)。
