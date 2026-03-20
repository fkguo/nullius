# Adapters（统一 backend 接入模板）

目标：在 **不修改任何外部 tools/skills/MCP** 的前提下，把外部 backends（skills / hep-research-mcp / shell commands / internal toolkit）以统一方式接入 Orchestrator，并满足本仓库的可靠性三件套：

1) 统一状态机：`status/pause/resume/approve`
2) 统一 run-card（输入契约）
3) 统一 artifacts 三件套（SSOT）：`manifest.json` / `summary.json` / `analysis.json`（可选派生 `report.md`）

本仓库实现位置：
- Adapter 抽象与示例：[`src/hep_autoresearch/toolkit/adapters/`](../src/hep_autoresearch/toolkit/adapters/)
- Orchestrator workflow 接入：[`src/hep_autoresearch/orchestrator_cli.py`](../src/hep_autoresearch/orchestrator_cli.py)
- 产物契约：[`docs/ARTIFACT_CONTRACT.md`](ARTIFACT_CONTRACT.md)
- Approvals：[`docs/APPROVAL_GATES.md`](APPROVAL_GATES.md)
- Evals：[`docs/EVALS.md`](EVALS.md)

---

## 1) Adapter 的职责边界（避免重复造轮子）

Adapter **只负责**：
- 受控调用 backend（shell / MCP / internal python）
- 记录 provenance（命令/MCP 请求、cwd/env、输入文件 hash、stdout/stderr 摘要、return code、输出文件清单）
- 将 backend 输出**转写/归档**为本仓库统一的 SSOT artifacts（三件套）
- 触发最小 deterministic 校验（required paths / required fields / schema subset），并为 eval suite 提供可回归锚点
- 在 **awaiting approval / failure** 时也要落盘 artifacts（保证可审计、可恢复）

Adapter **不负责**（由外部工具负责）：
- BibTeX 拉取/生成 citekey
- paper scaffold / LaTeX 工程搭建
- hep-calc 的物理计算编排与数值实现
- review/writer 的内容生成（Adapter 仅做受控调用与产物落盘）

---

## 2) run-card（输入契约）

run-card 是 adapter 的输入 SSOT（但不替代三件套 SSOT）。本仓库做法：
- Orchestrator 生成或加载 run-card，并写入 `artifacts/runs/<run_id>/<step>/run_card.json`
- `manifest.json` 中记录 `run_card_path` + `run_card_sha256`，用于 resume 与差异审计

最小字段（示例，后续可扩展）：

```json
{
  "schema_version": 1,
  "run_id": "MXX-adapter-smoke-r1",
  "workflow_id": "shell_adapter_smoke",
  "adapter_id": "shell",
  "artifact_step": "shell_adapter_smoke",
  "required_approvals": ["A3"],
  "budgets": { "timeout_seconds": 30 },
  "prompt": { "system": "", "user": "..." },
  "tools": [],
  "evidence_bundle": { "context_md": "…", "context_json": "…" },
  "backend": {
    "kind": "shell",
    "argv": ["python3", "-c", "print('ok')"],
    "cwd": ".",
    "env": {}
  }
}
```

### 2.1) 可选：sandboxed execution（T40 v0）

对高风险 shell 命令（尤其是“会写文件/会跑算力/可能引入不受控副作用”的外部脚本），支持在 run-card 中声明沙盒模式：

```json
{
  "backend": {
    "kind": "shell",
    "argv": ["python3", "-c", "print('ok')"],
    "cwd": ".",
    "sandbox": {
      "enabled": true,
      "provider": "auto",
      "network": "disabled",
      "repo_read_only": true,
      "docker_image": "python:3.11-slim"
    }
  }
}
```

语义（v0）：
- `provider=docker`：若可用，使用容器运行；repo 根目录只读挂载到 `/repo`，并把 `artifacts/runs/<run_id>/<artifact_step>/`（run/step 级别）作为唯一可写挂载点；`network` 默认禁用（`--network none`）。容器内默认只转发 allowlist 环境变量（来自 `backend.env`）+ 内部 sandbox 变量；如需额外 env，请用 `sandbox.forward_env_keys` 显式声明（不建议转发 secrets；若 key 名含 `SECRET/TOKEN/PASSWORD/...` 等字样，会在 provenance 里记录 warning）。
- `provider=local_copy`：离线/无 daemon 时的 best-effort fallback：复制 repo 到临时目录（不复制 `artifacts/`），在临时目录执行命令；将沙盒内 `artifacts/runs/<run_id>/<artifact_step>/` 的输出回拷到真实 `artifacts/`。该模式 **不强制** 禁网且不作为安全边界（同用户恶意代码仍可绕过）；主要用于降低误改概率并保留审计追踪。
- `provider=auto`：优先 docker（可用时），否则退化为 local_copy。

> ⚠️ `provider=local_copy` **不是安全边界**：它主要用于降低误改概率与审计；无法抵御恶意代码。对不信任输入请使用 `provider=docker`。

安全约束（v0）：
- 若 `network` 不是 `disabled/none`，ShellAdapter 会额外要求 `A1`（避免无审计的联网行为）。
- 沙盒模式要求 `backend.cwd` 位于 repo_root 内（避免把 cwd 指到外部目录导致隔离失效）。

说明：
- `required_approvals` 是 adapter 的审批基线：任何会触发 network / 写代码 / 改稿 / 跑算力 的动作必须经由 A1–A5（除非 run-card 显式放宽）。
- `RefKey ≠ citekey`：adapter 不生成 citekey，但应能携带 `refkey_to_citekey.json`（若存在）作为输入指针（建议放在 run-card 或 manifest.inputs 中）。

---

## 3) artifacts 三件套（SSOT）

每次 adapter 运行必须落盘（目录固定）：

- `artifacts/runs/<run_id>/<artifact_step>/manifest.json`
- `artifacts/runs/<run_id>/<artifact_step>/summary.json`
- `artifacts/runs/<run_id>/<artifact_step>/analysis.json`
- 可选：`artifacts/runs/<run_id>/<artifact_step>/report.md`（派生，可再生）

字段最小要求见：
- [`specs/artifact_manifest.schema.json`](../specs/artifact_manifest.schema.json)
- [`specs/artifact_summary.schema.json`](../specs/artifact_summary.schema.json)
- [`specs/artifact_analysis.schema.json`](../specs/artifact_analysis.schema.json)

本仓库 adapter helper：
- [`src/hep_autoresearch/toolkit/adapters/artifacts.py`](../src/hep_autoresearch/toolkit/adapters/artifacts.py) 负责三件套落盘 + `report.md` 渲染。

---

## 4) 如何新增一个 adapter（接入 research-writer / hep-calc / referee-review）

原则：**不改外部工具代码**；仅新增本仓库 adapter + workflow wiring + eval case。

### 4.1 skills（shell command）类 backend

适用：`research-writer`、`hep-calc`、`prl-referee-review` 等以 CLI/脚本形式运行的工具。

接入方式：
1) 新增一个 adapter（建议复制 `ShellAdapter`）：[`src/hep_autoresearch/toolkit/adapters/shell.py`](../src/hep_autoresearch/toolkit/adapters/shell.py)
2) 在 registry 注册 workflow id：[`src/hep_autoresearch/toolkit/adapters/registry.py`](../src/hep_autoresearch/toolkit/adapters/registry.py)
3) 在 Orchestrator 中允许该 workflow id：[`src/hep_autoresearch/orchestrator_cli.py`](../src/hep_autoresearch/orchestrator_cli.py)
4) 写一个离线 regression harness + eval case（见本仓库 `evals/cases/`）

run-card 中的关键点：
- `backend.argv`：明确要调用的外部命令（包括固定的 `--tag/--out-dir` 等参数）
- `required_approvals`：通常至少包含 `A3`（compute），若会写代码/改稿则加 `A2/A4`
- `evidence_bundle`：把 context pack、输入文件/证据指针写进去，避免“跑了但不知道基于什么”

### 4.2 hep-research-mcp（MCP call）类 backend

适用：需要调用 MCP 工具（INSPIRE 搜索、paper bundle、citation mapping 等）。

接入方式（模板）：
- 写一个 `MCPAdapter`（本任务未实现具体联网；仅提供模板接口），把每次 MCP 请求与返回摘要写入 manifest，并把产物转写为本仓库 SSOT artifacts。
- `required_approvals` 通常至少包含 `A1`（mass_search / network）与 `A3`（compute）。

### 4.3 internal python backend

适用：本仓库已有 toolkit 模块（例如确定性解析/检查/导出）。

接入方式：
- Adapter 仅做统一打包：把输入参数、版本、关键中间量与输出文件映射到三件套 SSOT。

---

## 5) approvals / resume / evals 的对接

- approvals：adapter 在 `prepare()` 阶段声明 `required_approvals`，由 Orchestrator 负责 `approve/reject` 状态机。
- resume：同一 run-card（hash 相同）重复运行应幂等；run-card 改变时应要求新 run-id（或显式 `--force`）。
- evals：为每个 adapter workflow 增加一个离线 eval case（required paths + schema/字段检查），保证回归可跑。
