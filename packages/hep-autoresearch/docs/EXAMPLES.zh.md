# Examples / 项目插件（project plugins）

英文版本：[docs/EXAMPLES.md](EXAMPLES.md)。

本仓库的核心目标是让平台保持**领域无关**。任何物理/领域实现都应放在**项目插件**里（自包含目录），通常位于 [examples/](../examples/) 下。

computation 通过执行项目插件声明的 `run_card v2` phases 来运行计算/验证/数据处理等流水线。

## 推荐目录结构

最小结构：

```
examples/<project_id>/
  project.json
  run_cards/
    <card>.json
  scripts/
    <phase_script>.py   # 或 .sh
```

真实项目中常见的扩展结构：

```
examples/<project_id>/
  project.json
  run_cards/
  scripts/
  data/                 # 可选：小体积公开数据/夹具
  results/              # 可选：golden outputs（尽量小）
  notes/                # 可选：项目说明/记录
```

## project.json

`project.json` 是一个轻量描述文件，用于项目发现与基本 guardrails（project id、标题、run-card 注册表等）。

参考示例：
- [examples/schrodinger_ho/project.json](../examples/schrodinger_ho/project.json)

## 如何写 run_card v2

用 `run_card v2` 声明：
- 类型化 parameters
- phases（通过 `depends_on` 形成 DAG）
- backend（通常为 shell：调用你的 scripts）
- inputs/outputs，以及可选的 acceptance/headline 提取

起步材料：
- schema：[specs/run_card_v2.schema.json](../specs/run_card_v2.schema.json)
- 工作流概览：[workflows/computation.md](../workflows/computation.md)

当前前门说明：

- mainline 的 computation 执行现在走 `autoresearch run --workflow-id computation`，目标是已初始化的外部 project root，并要求 `computation/manifest.json` 已经准备好。
- Python `hep-autoresearch` / `hepar run` 现在只保留给尚未 repoint 的非 computation / support workflows。

运行前先校验：

```bash
python3 scripts/orchestrator.py run-card validate \
  --run-card examples/<project_id>/run_cards/<card>.json
```

## 用 computation 运行一个插件

```bash
autoresearch run \
  --project-root /abs/path/to/external-project \
  --run-id M0-my-plugin-r1 \
  --workflow-id computation \
  --manifest /abs/path/to/external-project/M0-my-plugin-r1/computation/manifest.json
```

产物落盘位置：
- `artifacts/runs/<RUN_ID>/computation/`（见 [docs/ARTIFACT_CONTRACT.md](ARTIFACT_CONTRACT.md)）

## 最佳实践

- 脚本确定性：固定随机种子、显式容差、稳定输出格式（优先 JSON）。
- I/O 显式：只写声明过的 outputs；避免隐式副作用。
- 领域代码不进 `src/`：平台核心不应依赖具体项目插件。
- Evidence-first：把 headline numbers 写进 `analysis.json`，为 evals/写作等下游门禁提供可机读证据。
