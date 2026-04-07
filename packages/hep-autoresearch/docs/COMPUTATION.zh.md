# computation 使用指南（run_card v2）

英文版本：[docs/COMPUTATION.md](COMPUTATION.md)。

computation 是一个**与领域无关**、**声明式**、**可审计**的计算 DAG 执行引擎。所有物理/领域逻辑必须下沉到项目插件（通常在 [examples/](../examples/) 下），平台只负责验证、执行、产物与门禁。

本文聚焦：
- `run_card v2` 是什么
- computation 如何解析路径/参数
- 你应该得到哪些 artifacts
- 如何安全地 validate 与执行

工作流概览请看：[workflows/computation.md](../workflows/computation.md)。

前门状态：

- `autoresearch run --workflow-id computation` 现在是面向已初始化外部 project root、且已准备好 `computation/manifest.json` 的 canonical bounded TS computation 入口。
- internal run-card authoring helpers 现在只剩 maintainer-only 的 legacy utilities，后续仍会删除；不要把它们当成 installable public shell 或推荐的 first-touch path。

## 快速开始

当前 TS 前门执行方式：

```bash
autoresearch run \
  --project-root /abs/path/to/external-project \
  --run-id M0-computation-demo-r1 \
  --workflow-id computation \
  --manifest /abs/path/to/external-project/M0-computation-demo-r1/computation/manifest.json
```

仍留在过渡 Pipeline A surface 上的 legacy helper utilities：

```bash
python3 scripts/orchestrator.py run-card validate \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json

python3 scripts/orchestrator.py run-card render \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --format mermaid \
  --out artifacts/runs/M0-computation-demo-r1/computation/dag.mmd
```

如果当前 mainline TS surface 的 approval policy 触发 A3，你会看到 `awaiting_approval`：

```bash
autoresearch status --project-root /abs/path/to/project
autoresearch approve <approval_id> --project-root /abs/path/to/project
```

然后重新执行同一条 `autoresearch run --workflow-id computation ...` 命令。

Internal maintainer-only 的 run-card authoring helpers（可选 legacy residue）：

```bash
python3 scripts/orchestrator.py run-card validate \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json

python3 scripts/orchestrator.py run-card render \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --format mermaid \
  --out artifacts/runs/M0-computation-demo-r1/computation/dag.mmd
```

## 什么是 run_card v2？

`run_card v2` 是一个严格 JSON 契约，用来声明：
- **parameters**（类型化；支持 CLI 覆盖）
- **phases**（串行 DAG：`depends_on` + `inputs`/`outputs`）
- **backend**（通常是 `shell`：调用项目插件提供的脚本）
- 可选：**acceptance**（验收）与 **headline numbers**（可机读关键数值）

Schema SSOT：
- JSON Schema：[specs/run_card_v2.schema.json](../specs/run_card_v2.schema.json)
- 校验实现：[src/hep_autoresearch/toolkit/run_card_schema.py](../src/hep_autoresearch/toolkit/run_card_schema.py)

严格模式：
- `schema_version` 为整数
- 未知字段直接 **ERROR**
- 仅支持当前 schema 版本

## 路径语义

computation 使用三个基准目录：

- `${REPO_ROOT}`：`hep-autoresearch` 仓库根目录。
- `${PROJECT_DIR}`：项目插件根目录（必须包含 `project.json`）。
- `${WORKSPACE}`：每次运行的 workspace，位于 `artifacts/runs/<RUN_ID>/computation/`。

在 phase 内：
- `backend.cwd` 默认按 `${PROJECT_DIR}` 解析（除非显式给绝对路径）。
- phase 的 `inputs[]` 使用一个简单约定：
  - 以 `phases/` 开头的路径按 `${WORKSPACE}` 解析（例如上游 phase 的输出）
  - 其它相对路径按 `${PROJECT_DIR}` 解析（项目内文件）
  - 校验器会强制 containment（禁止 `../` 逃逸）

不确定时请先跑 `run-card validate`（会强制执行路径边界规则）。

## 信任模型（shell 执行）

只要某个 phase 使用 shell backend，computation 就要求显式信任：
- 交互模式：可能会弹出确认提示
- 非交互模式：必须带 `--trust-project`（fail-closed）

参见：[docs/SECURITY.md](SECURITY.md) 与 [docs/APPROVAL_GATES.md](APPROVAL_GATES.md)。

## Artifacts（你会得到什么）

computation 总会把 SSOT artifacts 写到：

`artifacts/runs/<RUN_ID>/computation/`

必选产物定义见：[docs/ARTIFACT_CONTRACT.md](ARTIFACT_CONTRACT.md)。

常见输出包括：
- `manifest.json` / `summary.json` / `analysis.json` / `report.md`
- `run_card.json`（规范化快照）
- `phase_state.json`（逐 phase 状态 + 溯源指针）
- `logs/<phase_id>/{stdout,stderr}.txt`

## 审批后的重跑

当前 TS 前门没有单独的 `--resume` flag。A3 审批通过后，应针对同一个已初始化 external project root 和同一个 manifest 路径，重新执行同一条 `autoresearch run --workflow-id computation ...` 命令。

如果后续执行让 run 进入 `paused`、`blocked` 或 `needs_recovery`，不要假设再次执行同一条命令就会自动续跑。应先检查 `autoresearch status`，然后按该状态对应的显式恢复路径处理，或在重置后做一次干净重跑。恢复仍然是 fail-closed：如果状态或 artifacts 与预期 computation 输入不一致，执行应拒绝继续。

## 验收（acceptance）与 headline numbers

run_card v2 可选声明：
- **acceptance checks**（JSON Pointer + 数值容差）
- **headline numbers**（可机读关键数值）

这些会写入 `analysis.json`，用于后续门禁（evals、报告、写作等）。
