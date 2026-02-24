# W_compute — 通用计算 DAG（run_card v2）

英文版本：`workflows/W_compute.md`。

## 目标

运行一个由项目插件提供、声明式且可审计的计算流水线：
- 严格 `run_card v2` 校验
- 串行 DAG 执行（按拓扑序）
- 确定性产物（manifest/summary/analysis/report）
- 可 resume 的 fail-closed 语义

W_compute **不包含领域逻辑**：物理/领域实现必须下沉到项目插件（例如 `examples/<project>/scripts/*`），通过 shell backend 调用。

## 输入

必选：
- `run_card`（run_card v2 JSON），通过 CLI `--run-card <path>` 传入

可选：
- `--param key=value` 覆盖参数（按 run_card v2 参数规范做类型转换）
- `--project-dir <path>`（否则从 `<project_dir>/run_cards/<card>.json` 推断）
- `--resume`（在 run-card 匹配时从 `artifacts/runs/<run_id>/w_compute/` 续跑）

## 输出（产物）

必选（见 `docs/ARTIFACT_CONTRACT.md`）：
- `artifacts/runs/<RUN_ID>/w_compute/manifest.json`
- `artifacts/runs/<RUN_ID>/w_compute/summary.json`
- `artifacts/runs/<RUN_ID>/w_compute/analysis.json`
- `artifacts/runs/<RUN_ID>/w_compute/report.md`
- `artifacts/runs/<RUN_ID>/w_compute/run_card.json`（规范化 + 参数已解析快照）
- `artifacts/runs/<RUN_ID>/w_compute/phase_state.json`（逐 phase 状态 + 溯源指针）

建议：
- `artifacts/runs/<RUN_ID>/w_compute/logs/<phase_id>/*.txt`（stdout/stderr 快照）
- `artifacts/runs/<RUN_ID>/w_compute/workspace/`（复制的 phase I/O workspace，便于排错）

## 步骤（MVP）

1) 校验 `run_card v2`：
   - 未知字段直接 ERROR
   - 参数确定性解析
   - phase DAG 校验（id/depends_on/I/O 路径）
2) 信任 + 路径边界：
   - shell backend 需要显式信任（`--trust-project`）
   - phase 路径必须限定在 project/workspace 边界内
3) 按拓扑序执行 phases：
   - 记录 exit code + logs
   - 写入 workspace，并复制声明 outputs
4) 验收检查（可选）：
   - JSON pointer 数值检查（min/max/max_abs）
5) 写 SSOT 产物：
   - 即使失败或 gate block 也必须写 manifest/summary/analysis/report

## 门禁（验收）

- 若被 approval gate 阻塞，必须返回清晰状态并保留 SSOT 产物。
- 若某个 phase 失败且 `on_failure=fail-fast`，后续 phase 不得继续执行。
- 若 run-card 配置了 headline numbers，则 `analysis.json` 必须包含可机器提取的 headline 数值。

## 扩展路线

- v1：更丰富的 Outcome Gate（文件哈希、schema 校验、不变量检查）。
- v2：一等集成：W_compute workspace → MCP evidence（Outcome Gate）→ research-writer。

