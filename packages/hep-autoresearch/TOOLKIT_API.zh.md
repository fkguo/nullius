# TOOLKIT_API.md

目标：把“科研智能体平台”拆成可复用、可测试、可替换的大模块。这里先定义 API 边界（接口契约），后续实现落到 `src/` 或 `toolkit/`。

## 0) 设计约束（SSOT）

- Evidence-first：任何核心输出都必须能指向 artifacts 或可复核推导。
- 可复现：每次 run 产出 `manifest/summary/analysis` 三件套（见 `docs/ARTIFACT_CONTRACT.md` 与 `specs/`）。
- 多模型可替换：不绑定单一 LLM；Orchestrator 只依赖“角色接口”和“工具接口”。

## 1) 模块划分（v0）

### A. `ingest`（W1）

职责：
- 输入（recid/arXiv/DOI/query）→ stable anchor → references 快照 → reading note（RefKey 模板化）

接口（草案）：
- `ingest.resolve_anchor(input) -> {kind, id, urls, texkey?}`
- `ingest.fetch_source(anchor, prefer="latex") -> references/<anchor>/...`
- `ingest.write_reading_note(anchor, refkey, out_path) -> path`

### B. `artifacts`（统一落盘契约）

职责：
- 提供生成/校验 `manifest/summary/analysis` 的通用工具

接口（草案）：
- `artifacts.write_manifest(run_ctx, outputs, extra={})`
- `artifacts.validate_manifest(path, schema=specs/artifact_manifest.schema.json)`

### C. `evals`

职责：
- 读取 `evals/cases/*/case.json`，执行“验收检查器”（起步先做静态检查：required_paths/required_fields）

接口（草案）：
- `evals.load_case(path) -> case`
- `evals.check_case(case, project_root) -> pass/fail + report`

### D. `orchestrator`

职责：
- 计划/路由/运行状态管理/门禁触发/归档与回滚

接口（草案）：
- `orchestrator.run(workflow_id, inputs, policy) -> run_result`
- `orchestrator.resume(run_id) -> run_result`

### E. `gates`

职责：
- 把门禁作为可组合组件：link hygiene / references / compile / evidence / convergence / schema validation

接口（草案）：
- `gates.run_all(run_ctx, targets) -> report`

### F. `roles`

职责：
- 把 Planner/Executor/Reviewer（以及 Researcher/Writer/Checker）作为一等公民抽象，支持：
  - 不同 runner（Codex/Claude/Gemini/本地模型）可替换
  - 上下文隔离与权限隔离（尤其是 Reviewer）

接口（草案）：
- `roles.run(role_id, task_packet, policy) -> role_output`

### G. `memory`

职责：
- L1 记忆进化：把每次运行沉淀为可复用资产（KB/trace/run ledger/错误库）。

接口（草案）：
- `memory.append_trace(kind, payload, out_path) -> path`
- `memory.index_runs(out_dir=team/trajectory_index.json) -> path`

### H. `policies`

职责：
- 将 approval gates、预算、网络范围、门禁强度等变成可配置策略（见 `specs/approval_policy.schema.json`）。

接口（草案）：
- `policies.load_approval_policy(path) -> policy`
- `policies.should_pause(action_kind, policy) -> bool`

## 2) 版本策略（建议）

- v0：只承诺 W1 ingestion + eval 静态检查器（可靠性工程起步）
- v1：加 W3 revision 闭环（LaTeX 可编译 + diff + 引用/证据门禁）
- v2：加 W2 reproduce（先 toy，再真实论文）
