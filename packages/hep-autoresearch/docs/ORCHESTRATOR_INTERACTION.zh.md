# Orchestrator interaction（CLI/Web：canonical lifecycle + 只读诊断）

目标：把 agent 从“脚本集合”升级成“可交互的自动化工作助手”。用户体验上应接近 Codex CLI：
- 能随时问状态（status）
- 能暂停/继续（pause/resume）
- 在高风险节点强制停下等待同意（approve）
- 任何一步都有可审计产物与可回滚路径

本文件定义交互契约，后续实现可以是 CLI 优先、Web 次之。
下文所有命令都假设你位于一个真实、已 scaffold 的研究项目根目录（或显式传 `--project-root <dir>`）；`packages/hep-autoresearch/` 是工具开发仓，不是日常运行项目的 project root。

## 1) 交互命令（CLI 优先）

先给出当前 front-door 真相：
- canonical root lifecycle 固定走 `autoresearch init|status|approve|pause|resume|export`
- canonical bounded computation 固定走 `autoresearch run --workflow-id computation`
- 安装态 `hep-autoresearch` / `hepar` / `hep-autopilot` public shell 只保留 provider-local workflow/support commands
- 安装态 `hepar run` 仅保留为兼容壳层命令，public workflow ids 现已清空
- 安装态 public shell 的精确命令清单是：`approvals`, `report`, `run`, `logs`, `context`, `smoke-test`, `method-design`, `propose`, `skill-propose`, `run-card`, `branch`, `migrate`。
- `start`、`checkpoint`、`request-approval`、`reject` 这类 direct public root lifecycle/approval mutations 已从 installable shell 退役

建议命令族（概念示意；上面的 concrete authority 才是当前真相）：

- `init`：把你选定的项目目录初始化为 project root（补齐 docs/KB/specs 最小骨架；创建 `.autoresearch/` 状态 + ledger）
- `run`：bounded computation 固定走 `autoresearch run --workflow-id computation`；安装态 `hepar run` 现在只作为兼容提示面，不再公开 workflow id
- `branch`：把“分支决策/备选路径”记录进 Plan SSOT（list/add/switch；用于可控回溯）
- `status`：显示当前 run 状态（步骤、产物、待同意点、预算消耗）
- `pause`：暂停当前 run（写 stop file 或更新状态）
- `resume`：继续执行
- `approve <approval_id>`：同意某个待审批动作（A1–A5）
- `logs`：输出最近日志与关键失败点
- `export`：导出 run bundle（便于离线审阅/共享）

## 2) 默认“同意点”触发（approve gates）

触发时机来自 `docs/APPROVAL_GATES.md`（A1–A5），并可由配置覆盖（见 `specs/approval_policy.schema.json`）。

触发时 Orchestrator 必须输出一个**可审阅审批包**，至少包含：
- 动作类别（A1–A5）
- 目的与预期收益（1–3 句）
- 计划（具体会做什么，最少步骤）
- 预算（网络调用次数、最长运行时间、算力/并行度/数据量）
- 风险（可能误改/可能偏差/可能失败模式）
- 产物（将生成哪些 artifacts，路径是什么）
- 回滚方式（如何撤销/恢复）
- run-card 引用（把审批决策绑定到“将要执行的意图”）：
  - `artifacts/runs/<run_id>/run_card.json`
  - `run_card_sha256`（对 canonical JSON 计算的 SHA256；不等于对磁盘上 run_card.json 字节做 `sha256sum`）
- plan 引用（把审批决策绑定到具体步骤）：
  - `plan_md_path`（派生可读视图）
  - `state.json#/plan`（SSOT 指针）
  - 此审批适用的 plan step ID(s)

在 canonical lifecycle 明确完成审批决策前，不得继续执行该动作。

## 3) 状态机与落盘（必须可恢复）

Orchestrator 必须把 run 状态落盘（崩溃/中断后可恢复），至少包括：
- `run_id` / `tag`
- `workflow_id`（如 `ingest` / `reproduce` / `draft` / `revision` / `derivation_check`）
- 当前 step、已完成 steps、下一步
- `pending_approval`（如有：approval_id + 包内容摘要）
- 预算消耗（network calls、runtime）
- 产物指针（manifest/summary/analysis、diff、编译日志等）

推荐保存位置（项目内）：
- `.autoresearch/state.json`（选定：隐藏状态；与用户可读的 `team/` 日志分离）
- `team/trajectory_index.json`（run ledger）

状态 schema / timeout 语义 / crash recovery 契约见：[`docs/ORCHESTRATOR_STATE.md`](ORCHESTRATOR_STATE.md)。

## 4) pause/resume 的两种实现

1) 显式命令：`pause/resume` 改写 state
2) stop files（最低配，适用于任何执行环境）：
   - `.pause`：暂停
   - `.stop`：停止

这两者都应支持（stop files 作为兜底）。

## 5) Web 入口（后续）

Web 入口不改变契约，只改变 UI：
- 状态面板（当前 step/日志/产物）
- diff/编译结果预览

当前实现说明：
- `src/hep_autoresearch/web/app.py` 现已收窄成只读诊断面板（`status` + `logs`），并显式把 lifecycle 动作导回 `autoresearch`

## 6) 验收标准（建议写入里程碑）

在不依赖“全自动成功”的情况下，至少做到：
- 能启动一个 workflow 并生成 run state
- 能进入待审批状态并等待用户输入
- 能 pause/resume，并在中断后恢复
- 关键产物落盘，并能从 `status` 输出中定位到路径

## 7) 长任务与异步审批（现实科研必备）

对预计 >1 小时的任务（或需要排队的 batch job）：
- Orchestrator 必须定期写 checkpoint（默认：每 15 分钟；可配置）
- `approve` 支持异步：人类可以晚些时候批准；批准会被排队并在到达同意点时消费
- `status` 必须展示：最后 checkpoint 时间、预计剩余时间（如果可估）
- 超过 2× 预期 checkpoint 间隔未更新：必须告警并暂停后续动作

## 8) 会话交接（多人协作）

需要支持“换人接管”而不中断可复现性：
- `handoff --to <user>`：写入交接记录（当前状态、待审批、预算、关键产物指针、交接原因）

### 现阶段实现（v0）

当前已提供最小 CLI。generic lifecycle 入口现为 `autoresearch`（当前覆盖 `init/status/approve/pause/resume/export`）；`hepar` / `hep-autoresearch` / `hep-autopilot` 仍是过渡中的 Pipeline A legacy surface，但安装态 public shell 现在只保留 residual non-computation workflow/support commands，其中 public `run` 不再提供 workflow id。`start`、`checkpoint`、`request-approval`、`reject` 这类 direct public root lifecycle/approval mutations 已从 installable shell 退役；其中 `reject` 仍暂时保留为内部 full parser 的 direct-mutation maintainer path，等待 canonical TS surface parity。public computation、`doctor`、`bridge` 与 `literature-gap` 已从 installable shell 退役，仅保留在内部 full parser 供 maintainer/eval/regression 使用。其余 legacy workflow ids（`ingest`、`reproduce`、`revision`、`literature_survey_polish`、`shell_adapter_smoke`）现在也只保留为 internal full-parser coverage，不再属于 installable public shell。computation 应走 `autoresearch run --workflow-id computation`；同意点仍按 `approval_policy.json` 自动触发：

```bash
# 在你的研究项目根目录里执行（不是在 packages/hep-autoresearch/ 里）
autoresearch init
hepar context --run-id M0-context-r1 --workflow-id custom --note "bootstrap smoke test"
autoresearch status
hepar logs --tail 20
autoresearch pause
autoresearch resume
autoresearch export

# installable `hepar run` 不再公开 workflow id（兼容壳层，仅做前门提示）
hepar run --help

# computation 现在走 native TS front door，而不是 installable `hepar run`
autoresearch run --run-id M0-computation-demo-r1 --workflow-id computation --manifest /path/to/external-project/M0-computation-demo-r1/computation/manifest.json --project-root /path/to/external-project
autoresearch status   # 查看 pending_approval（默认 A3）
autoresearch approve <approval_id>
autoresearch run --run-id M0-computation-demo-r1 --workflow-id computation --manifest /path/to/external-project/M0-computation-demo-r1/computation/manifest.json --project-root /path/to/external-project
```

如果你在 maintainer/eval/regression 上仍需要 `ingest`、`reproduce`、`revision`、`literature_survey_polish` 或 `shell_adapter_smoke`，请把它们视为 internal full-parser coverage，而不是当前 installable public shell authority。

安全注意（最小要求）：
- handoff/resume 必须做权限校验（至少：本地用户/组白名单；后续可扩展到更严格的认证）
- 交接摘要应由 Orchestrator 生成（不可由 Executor 自由撰写），避免“交接话术注入”

## 9) Watchdog（避免长任务静默失败）

建议提供一个独立 watchdog（脚本/daemon/cron 任一实现）：
- 监控 `.autoresearch/state.json` 的更新时间
- 若状态为 running 且超过 timeout 未更新：写告警并触发 `pause`（或创建 `.pause`）
