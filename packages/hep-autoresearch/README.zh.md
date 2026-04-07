# HEP Autoresearch（中文说明）

目标：把高能物理（HEP）科研中反复出现的流程，尽可能自动化、模块化、可审计、可复现，并最终做到“更多人可用”的研究加速工具。

这个项目把已有能力当作“底座”来统一编排：
- `hep-research-mcp`：INSPIRE/PDG/Zotero/论文源文件抓取/证据索引/写作导出等工具层（MCP）。
- `research-team`：里程碑 + 双成员独立复核 + 收敛门禁（避免单模型幻觉）。
- `hep-calc`：符号/数值计算编排与可审计产物（manifest/summary/analysis）。
- `research-writer`：paper scaffold + 引用与 LaTeX 卫生 + 证据门禁。
- `review-swarm`：干净室双模型对同一任务的收敛检查（快速一致性审阅）。

## 你现在应该从哪里读起？（package docs，不是 generic front door）

如果你先想确认当前 mainline 的 front-door 真相，请先看仓库根级的 [README](../../README.md)、[docs/QUICKSTART.md](../../docs/QUICKSTART.md) 与 [docs/TESTING_GUIDE.md](../../docs/TESTING_GUIDE.md)。下面这些内容是 `packages/hep-autoresearch/` 的 package-local legacy / maintainer 文档链路，不是默认产品前门。

1) `docs/INDEX.md`（文档总入口）
2) `docs/BEGINNER_TUTORIAL.zh.md`（外部研究项目的首次上手）
3) `docs/VISION.zh.md`（愿景与边界）
4) `docs/ARCHITECTURE.zh.md`（总体架构与接口）

注意：这里是 `hep-autoresearch` 的**开发仓库**，不是你实际做研究时的项目根目录。generic lifecycle 的 canonical 入口现在是 `autoresearch`，用于 `init/status/approve/pause/resume/export`。日常使用应在你自己的研究项目目录里执行 `autoresearch init`；它现在由 TS lifecycle 前门收口，但继续复用 `packages/project-contracts/` 中共享的中立 scaffold authority 来生成最小核心项目面：`project_charter.md`、`project_index.md`、`research_plan.md`、`research_notebook.md`、`research_contract.md`、provider-neutral `.mcp.json.example`、`.autoresearch/`、`docs/`、`specs/`。真实研究项目的中间产物也必须留在开发仓外。`hep-autoresearch`、`hepar` 与兼容别名 `hep-autopilot` 现在只作为过渡中的 Pipeline A legacy surface 保留；安装入口的 public shell 现在只保留 `run` 这一个兼容提示层命令。public computation、`doctor`、`bridge`、`literature-gap`、direct root lifecycle/approval mutations（`start`、`checkpoint`、`request-approval`、`reject`），以及旧 public support commands（`approvals`、`report`、`logs`、`context`、`smoke-test`、`method-design`、`propose`、`skill-propose`、`run-card`、`branch`、`migrate`）现在都只保留在 internal full parser，供 maintainer/eval/regression 使用。computation 继续固定走 `autoresearch run --workflow-id computation`；安装态 `run` 只保留为兼容壳层命令，不再提供 public workflow id。`ingest`、`reproduce`、`revision`、`literature_survey_polish` 与 `shell_adapter_smoke` 也都只保留在 internal full parser。内部 maintainer/eval 路径如需 lifecycle 兼容，也只允许薄代理回 canonical `autoresearch`，不再把 Python 当作第二套 root orchestrator。
安装态 public shell 的精确命令清单是：`run`。
其余 legacy workflow/support commands 都只保留在 internal full parser，供 maintainer/eval/regression 使用。

## Package docs / compatibility quickstart（小白 5 分钟）

见：`docs/BEGINNER_TUTORIAL.zh.md`

## 自我进化（不训练权重也能变强）

见：`docs/EVOLUTION.zh.md`

## 交互体验（pause/resume/status/approve）

见：`docs/ORCHESTRATOR_INTERACTION.zh.md`

## 当前状态

2026-02-03：已完成“可执行最小闭环”并把可靠性机制落到可回归的 artifacts：
- 可安装 CLI：`hep-autoresearch`（兼容 `hep-autopilot`）+ 简写 `hepar`；generic lifecycle 的 canonical 入口现为 `autoresearch`
- Web 入口 v0：FastAPI 只读诊断面板（`src/hep_autoresearch/web/app.py`）
- Internal full parser workflow coverage v0：ingest、reproduce、computation、revision、literature survey polish、paper_reviser，以及 orchestrator / eval 回归
- Eval suite：`python3 scripts/run_evals.py --tag <TAG>`
- 默认同意点：compute-heavy runs（A3）与 manuscript edits（A4）已在 Orchestrator 中落地

维护者查看已检入产物的入口：`artifacts/LATEST.md`
