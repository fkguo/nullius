# Paper reviser（LaTeX）+ 验证闭环（A–E）

英文版：`workflows/paper_reviser.md`。

## 目标

把 Codex skill `paper-reviser` 集成进 `hepar`，形成 evidence-first、可恢复/幂等的工作流：

- A) 对 draft `.tex` 做一轮内容优先修订（writer + auditor + deep verifier）
- B) 生成确定性的 literature 验证计划（verification_plan.json）
- C) 在 **A1 审批门禁（mass_search）** 下执行检索/下载任务（只对 Step C 要求 A1）
- D) 证据汇总（允许 LLM；JSON 为 SSOT，Markdown 为确定性渲染）
- E) 带证据上下文再修订一轮（只跑 1 轮）

所有 SSOT 产物默认落在：
`artifacts/runs/<RUN_ID>/paper_reviser/`

## 输入

- draft `.tex` 路径（默认：`<paper-root>/<tex-main>`）
- writer 模型配置：`--writer-backend` + `--writer-model`（必填、非空）
- auditor 模型配置：`--auditor-backend` + `--auditor-model`（必填、非空）
- 证据汇总配置（二选一）：
  - 自动：`--evidence-synth-backend` + `--evidence-synth-model`
  - 手工：`--manual-evidence`（用户手写 evidence notes）

## 输出（artifacts；SSOT）

必需：
- `manifest.json`, `summary.json`, `analysis.json`, `report.md`
- `round_01/` 与 `round_02/`（paper-reviser 输出，含 `run.json`, `clean.tex`, `changes.diff`）
- `verification/verification_plan.json`
- `verification/task_state/*.json` + `verification/logs/*.log`
- `verification/evidence_state/*.json` + `verification/evidence/<VR-ID>.json` + `verification/evidence/<VR-ID>.md`

## 步骤（MVP）

1) Step A — 修订（离线）
   - 对输入 draft `.tex` 运行 `paper_reviser_edit.py`。
   - 产物写入 `round_01/`（含 `run.json`, `clean.tex`, `changes.diff`, `verification_requests.json`）。
2) Step B — 构建验证计划（离线）
   - 若存在 `round_01/verification_requests.json`，运行 `build_verification_plan.py`。
   - 强制所有检索/下载输出都写到 `artifacts/runs/<RUN_ID>/paper_reviser/verification/`（避免污染 KB/refs）。
3) Step C — 审批门禁 + 执行检索（仅网络检索）
   - 只要存在 retrieval tasks，就必须先触发 **A1 审批**（mass_search）再执行。
   - 逐个执行 `research-team.literature_fetch` 任务，并写 `task_state/<id>.json` + `logs/<id>.log`。
4) Step D — 证据汇总（fan-in；允许离线 LLM）
   - 自动：每个 VR 写 `verification/evidence/<VR-ID>.json`（SSOT）+ 确定性渲染的 `verification/evidence/<VR-ID>.md`。
   - 手工：Step C 后停止，要求用户手写 `verification/evidence/<VR-ID>.md`。
5) Step E — 再修订一轮（离线）
   - 对 `round_01/clean.tex` 运行 `paper_reviser_edit.py` 一轮，并传 `--context-dir verification/evidence/`。
   - 产物写入 `round_02/`。

## 审批门禁

- **A1（mass_search）**：只在 Step C（外部检索/下载任务）触发；只要任务存在，就必须先审批。
- **A4（paper_edits）**：仅当用户显式传 `--apply-to-draft` 且项目 approval_policy 要求时触发。

## 门禁（验收）

- `artifacts/runs/<RUN_ID>/paper_reviser/` 下存在 SSOT：
  - `manifest.json`, `summary.json`, `analysis.json`, `report.md`
  - `round_01/run.json` + `round_01/clean.tex` + `round_01/changes.diff`
  - `round_02/run.json` + `round_02/clean.tex` + `round_02/changes.diff`（除非被 A1/A4 或手工证据模式阻塞）
- Step A/E 成功判据（按每轮 round）：
  - `run.json` 满足 `schema_version==1`, `exit_status==0`, `converged==true`
- Step C 门禁：
  - 若存在 tasks，则必须在 A1 审批前以 `exit=3` 阻塞。
  - 所有检索/下载输出路径不得逃逸 run_root（evidence-first）。
- Step C/D 幂等：
  - Step C 只有在 `exit_code==0` 且 log SHA256 匹配时才会 skip。
  - Step D 只有在 `exit_code==0` 且输出 JSON SHA256 匹配时才会 skip。

## 恢复 / 幂等

- Step A/E：以 `round_xx/run.json` 判定是否成功（`exit_status==0` 且 `converged==true` 且必要文件存在）；失败/不完整需要 `--force` 才允许覆盖重跑。
- Step C：每个 task 都写 `task_state/<id>.json` 与 `logs/<id>.log`；只有 `exit_code==0` 且 log SHA256 匹配才会 skip。
- Step D：每个 VR 都写 `evidence_state/<VR-ID>.json` 与输出 JSON；只有 `exit_code==0` 且输出 JSON SHA256 匹配才会 skip。

## MVP 范围

- v0 包含：
  - A–E 闭环，且所有 SSOT 产物落在 `artifacts/runs/<RUN_ID>/paper_reviser/`
  - Step C 的 A1 门禁，以及可选的 A4（apply-to-draft）
  - 证据汇总模式：自动（LLM/stub）或手工证据 notes
- v0 默认不做：
  - 默认不写 `knowledge_base/` 或 `references/`
  - 不包含 LaTeX 编译门禁（如需可单独跑 `latexmk`）
  - 不做超过 `round_01` + `round_02` 的多轮循环修订

## 扩展路线图（v1/v2）

- v1：
  - 增加可选编译门禁（`latexmk`）以验证 `round_01` / `round_02` 输出可编译。
  - 更丰富的证据打包（例如把关键摘录/下载内容更直接地注入 VR 上下文）。
- v2：
  - 有预算上限的多轮修订直至收敛，并增强跨轮 diff/trace。
  - 增加“可选复制证据到 KB/refs”的 opt-in 步骤（默认关闭，并在 manifest 记录）。

## CLI

运行：

```bash
hepar run --run-id <RUN_ID> --workflow-id paper_reviser \
  --writer-backend claude --writer-model <MODEL> \
  --auditor-backend gemini --auditor-model <MODEL> \
  --evidence-synth-backend gemini --evidence-synth-model <MODEL>
```

可选稳健性参数（会透传到 `paper_reviser_edit.py`，round_01 与 round_02 都生效）：

```bash
hepar run --run-id <RUN_ID> --workflow-id paper_reviser \
  ... \
  --paper-reviser-min-clean-size-ratio 0.70 \
  --paper-reviser-codex-model <CODEX_MODEL> \
  --paper-reviser-codex-config reasoning.effort=medium \
  --paper-reviser-codex-config sandbox_mode=read-only \
  --paper-reviser-fallback-auditor claude \
  --paper-reviser-fallback-auditor-model <CLAUDE_MODEL> \
  --paper-reviser-secondary-deep-verify-backend gemini \
  --paper-reviser-secondary-deep-verify-model <GEMINI_MODEL>
```

审批 Step C：

```bash
hepar status
hepar approve A1-0001
hepar run --run-id <RUN_ID> --workflow-id paper_reviser ...
```

手工证据模式：

```bash
hepar run ... --manual-evidence
# 写入 artifacts/runs/<RUN_ID>/paper_reviser/verification/evidence/<VR-ID>.md
hepar run ...
```
