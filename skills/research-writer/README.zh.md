# research-writer

由当前宿主 agent 阅读研究笔记、文献与运行结果，直接撰写真实论文文件，完成科学审阅和修改，最后交付经过检查的文件。工具负责空白 RevTeX 模板、参考文献与交叉引用检查、结果溯源、外部 paper manifest 接入和打包；不固定模型组合或论文结构。

`research_notebook.md` 继续作为完整、可供人阅读的科研笔记。只有任务需要论文时才建立论文目录。[SKILL.md](SKILL.md) 是完整契约，[RUNBOOK.md](RUNBOOK.md) 提供操作示例。

## 初始化空模板

在 skill 目录运行，或使用已安装脚本的绝对路径：

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-project \
  --tag M1-r1 --out /path/to/research-project/paper
```

需要 Python 3 和 Bash。输出空白 RevTeX 4.2 模板、空文献文件、图目录及初始化元数据。脚本不抽取笔记、不选择公式或结果，也不宣称完成论文；已有输出路径会被拒绝。可通过 `--run-card` 原样记录 JSON；`--title` 和 `--authors` 接受纯文本。

宿主 agent 在 `main.tex` 或它真正包含的章节文件中写作，调用现有 claim-grounding、科学审阅和适用的格式/结果溯源/图表检查，并实际读取输出、修正文稿。需要 PDF 时用配置好的 TeX 和 `latexmk` 编译，再检查最终页面。

## 外部论文接入

外部生产者提供 `paper_manifest.json` 时：

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh \
  --paper-manifest /path/to/paper/paper_manifest.json --compile
```

消费程序写入当次 `build_trace.jsonl` 与 `export_manifest.json`。请求编译但缺少工具链或编译失败时返回失败；旧 PDF 不能证明当次成功。该机械处理不代替科学审阅。

## 交付

实际读取 export manifest，用已有 research-team export 流程收集它引用的文件，以及当前可阅读成品、源码和必要验证依赖。打开导出后的文件检查，再给用户直接链接和未解决问题。初始化 manifest 仅说明 scaffold 状态，后续直接编译产生的 PDF 等依赖须显式加入导出。
