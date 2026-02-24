# HEP Autoresearch（中文说明）

目标：把高能物理（HEP）科研中反复出现的流程，尽可能自动化、模块化、可审计、可复现，并最终做到“更多人可用”的研究加速工具。

这个项目把你们已有能力当作“底座”来统一编排：
- `hep-research-mcp`：INSPIRE/PDG/Zotero/论文源文件抓取/证据索引/写作导出等工具层（MCP）。
- `research-team`：里程碑 + 双成员独立复核 + 收敛门禁（避免单模型幻觉）。
- `hep-calc`：符号/数值计算编排与可审计产物（manifest/summary/analysis）。
- `research-writer`：paper scaffold + 引用与LaTeX卫生 + 证据门禁。
- `review-swarm`：干净室双模型对同一任务的收敛检查（快速一致性审阅）。

## 你现在应该从哪里读起？

1) `PROJECT_MAP.md`（项目导航前门）
2) `docs/VISION.zh.md`（愿景与边界）
3) `docs/ARCHITECTURE.zh.md`（总体架构与接口）
4) `docs/ROADMAP.zh.md`（里程碑计划与验收标准）

## Quickstart（小白 5 分钟）

见：`docs/BEGINNER_TUTORIAL.zh.md`

## 自我进化（不训练权重也能变强）

见：`docs/EVOLUTION.zh.md`

## 交互体验（pause/resume/status/approve）

见：`docs/ORCHESTRATOR_INTERACTION.zh.md`

## 当前状态

2026-02-03：已完成“可执行最小闭环”并把可靠性机制落到可回归的 artifacts：
- 可安装 CLI：`hep-autoresearch`（兼容 `hep-autopilot`）+ 简写 `hepar`（见 `pyproject.toml` / `docs/BEGINNER_TUTORIAL.zh.md`）
- Web 入口 v0：FastAPI + 最小面板（`src/hep_autoresearch/web/app.py`）
- Workflows v0：W1 ingestion、W2(toy) reproduce、W2 v1（recid-3109742）end-to-end、W3 revision（compile+diff gate）、W4 potential matrix（TeX SSOT + invariants）
- Eval suite：`python3 scripts/run_evals.py --tag <TAG>`（回归锚点覆盖 W1/W2/W3/W4/Orchestrator/EVOLUTION）
- 默认同意点：W2/W2_v1 的 A3（算力/计算）与 W3 的 A4（改稿）已在 Orchestrator 中落地（可暂停/恢复/审批）

最新可读产物入口：`artifacts/LATEST.md`
