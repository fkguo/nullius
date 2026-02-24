# W_compute 使用指南（run_card v2）

英文版本：[docs/W_COMPUTE.md](W_COMPUTE.md)。

W_compute 是一个**与领域无关**、**声明式**、**可审计**的计算 DAG 执行引擎。所有物理/领域逻辑必须下沉到项目插件（通常在 [examples/](../examples/) 下），平台只负责验证、执行、产物与门禁。

本文聚焦：
- `run_card v2` 是什么
- W_compute 如何解析路径/参数
- 你应该得到哪些 artifacts
- 如何 validate/run/resume（安全、可恢复）

工作流概览请看：[workflows/W_compute.md](../workflows/W_compute.md)。

## 快速开始（schrodinger_ho）

先校验 run-card：

```bash
python3 scripts/orchestrator.py run-card validate \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json
```

渲染 phase DAG（可选）：

```bash
python3 scripts/orchestrator.py run-card render \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --format mermaid \
  --out artifacts/runs/M0-wcompute-demo-r1/w_compute/dag.mmd
```

运行（非交互；shell phases 需要显式信任）：

```bash
python3 scripts/orchestrator.py run \
  --run-id M0-wcompute-demo-r1 \
  --workflow-id W_compute \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --trust-project
```

如果 approval policy 触发 A3，你会看到 `awaiting_approval`：

```bash
python3 scripts/orchestrator.py status
python3 scripts/orchestrator.py approve <approval_id>
```

然后重新执行同一条 `run` 命令。

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

W_compute 使用三个基准目录：

- `${REPO_ROOT}`：`hep-autoresearch` 仓库根目录。
- `${PROJECT_DIR}`：项目插件根目录（必须包含 `project.json`）。
- `${WORKSPACE}`：每次运行的 workspace，位于 `artifacts/runs/<RUN_ID>/w_compute/`。

在 phase 内：
- `backend.cwd` 默认按 `${PROJECT_DIR}` 解析（除非显式给绝对路径）。
- phase 的 `inputs[]` 使用一个简单约定：
  - 以 `phases/` 开头的路径按 `${WORKSPACE}` 解析（例如上游 phase 的输出）
  - 其它相对路径按 `${PROJECT_DIR}` 解析（项目内文件）
  - 校验器会强制 containment（禁止 `../` 逃逸）

不确定时请先跑 `run-card validate`（会强制执行路径边界规则）。

## 信任模型（shell 执行）

只要某个 phase 使用 shell backend，W_compute 就要求显式信任：
- 交互模式：可能会弹出确认提示
- 非交互模式：必须带 `--trust-project`（fail-closed）

参见：[docs/SECURITY.md](SECURITY.md) 与 [docs/APPROVAL_GATES.md](APPROVAL_GATES.md)。

## Artifacts（你会得到什么）

W_compute 总会把 SSOT artifacts 写到：

`artifacts/runs/<RUN_ID>/w_compute/`

必选产物定义见：[docs/ARTIFACT_CONTRACT.md](ARTIFACT_CONTRACT.md)。

常见输出包括：
- `manifest.json` / `summary.json` / `analysis.json` / `report.md`
- `run_card.json`（规范化快照）
- `phase_state.json`（逐 phase 状态 + 溯源指针）
- `logs/<phase_id>/{stdout,stderr}.txt`

## Resume 与 crash recovery

在 run-card 允许且 workspace 状态匹配时可续跑：

```bash
python3 scripts/orchestrator.py run \
  --run-id M0-wcompute-demo-r1 \
  --workflow-id W_compute \
  --run-card examples/schrodinger_ho/run_cards/ho_groundstate.json \
  --trust-project \
  --resume
```

Resume 采用 fail-closed：若 run-card 快照或 phase 状态不匹配，应拒绝续跑并提示你做一次干净重跑。

## 验收（acceptance）与 headline numbers

run_card v2 可选声明：
- **acceptance checks**（JSON Pointer + 数值容差）
- **headline numbers**（可机读关键数值）

这些会写入 `analysis.json`，用于后续门禁（evals、报告、写作等）。
