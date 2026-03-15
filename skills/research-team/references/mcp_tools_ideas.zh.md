# MCP Tools Ideas（草图 / ZH，未来工作）

本 skill（`research-team`）目前以“模板 + 脚本 + 门禁(gates)”实现团队协作流程。  
如果要把其中**确定性（deterministic）**部分产品化、跨项目复用、并能被不同 agent 直接调用，适合迁移为 MCP tools。

## 设计原则（面向 research-team workflow）

- **确定性优先**：MCP tools 只做可验证、可复现、可证伪的事情（文件系统 I/O、schema 校验、纯计算、摘要索引生成）。
- **不把 LLM orchestration 塞进 MCP**：除非你明确要一个非确定性的 orchestrator tool（会带来不可重复性与调参开销）。
- **副作用可控 + 幂等**：scaffold 默认不覆盖；写入有明确输出路径；工具重复调用应可重放。
- **把“证据链/方法痕迹”作为一等公民**：强调可追溯、可复用、可审计（不绑定特定文献命名）。
- **配置驱动（domain config）**：用 `research_team_config.json` 控制严格度/策略，避免工具默认行为过度拟合某个领域。

## 与 PhysMaster（arXiv:2512.19799v1）的可借鉴点 → MCP 化映射

（从实现角度，而非复述论文）

- **Knowledge base**：强调分层知识库（文献证据 / 方法痕迹 / 先验约定）与可追溯证据链  
  → MCP tools 适合做：目录结构初始化、索引、引用检查、变更追踪、最小证据集校验。
- **长时程任务的 context 管理**：把探索轨迹外部化（节点级摘要/进度）  
  → MCP tools 适合做：结构化的 progress/trajectory 记录与索引（不做“生成”，只做“存/校验/聚合”）。
- **grounded feedback**：对每次迭代给出基于证据的可操作反馈  
  → MCP tools 适合做：门禁式 fail-fast + 结构化错误报告；把“该补什么证据”说清楚。

## 最小可用 MCP tool 套件（MVP）

下面的 tool 名称是建议；JSON schema 仅给出骨架（后续可用 Zod 作为 SSOT）。

### 1) `research_team_scaffold`

目的：初始化项目脚手架（plan/notebook/innovation log/config 等）。

输入（JSON）：
```json
{
  "project_root": "/abs/path",
  "project_name": "My Project",
  "template_profile": "standard",
  "overwrite": false,
  "language": null
}
```

输出（JSON）：
```json
{
  "success": true,
  "created_files": ["/abs/path/research_plan.md"],
  "skipped_files": [],
  "errors": []
}
```

确定性/副作用：确定性写文件；范围受控；可幂等。

### 2) `research_team_config_resolve`

目的：统一解析 domain config（mode + overrides），避免各工具重复实现“向上寻找 config”逻辑。

输入（JSON）：
```json
{
  "seed_path": "research_contract.md"
}
```

输出（JSON）：
```json
{
  "config_path": "research_team_config.json",
  "effective_config": { "mode": "generic", "features": { "pointer_lint_gate": true } }
}
```

确定性：纯读 + 合并。

### 3) `research_team_build_packet`

目的：从 notebook + capsule + 证据指针，确定性生成 team packet。

输入（JSON）：
```json
{
  "tag": "M2-r1",
  "notebook_path": "research_contract.md",
  "innovation_log_path": "idea_log.md",
  "excerpt_mode": "markers",
  "questions": ["这一步截断是否一致？"],
  "output_path": "prompts/team_packet_M2-r1.txt"
}
```

输出（JSON）：
```json
{
  "success": true,
  "packet_path": "prompts/team_packet_M2-r1.txt",
  "warnings": []
}
```

确定性：纯读/纯写。

### 4) `research_team_capsule_gate`（强烈建议单独工具化）

目的：把 Reproducibility Capsule 的合约检查做成独立 MCP tool（目前是脚本）。

输入（JSON）：
```json
{
  "notebook_path": "research_contract.md",
  "resolve_relative_to": "notebook",
  "strict": false
}
```

输出（JSON）：
```json
{
  "ok": false,
  "errors": ["Missing sweep semantics in section G ..."],
  "warnings": ["scipy version not listed ..."],
  "evidence": {
    "missing_outputs": ["runs/M2/summary.json"],
    "headlines_checked": ["H1", "H2", "H3"]
  }
}
```

### 5) `research_team_scan_dependency_gate`

目的：扫参依赖语义门禁（目前脚本支持 rules file；MCP 化后可直接返回结构化违约信息）。

输入（JSON）：
```json
{
  "notebook_path": "research_contract.md",
  "require_rules": false
}
```

输出（JSON）：
```json
{
  "ok": true,
  "applicable": true,
  "violations": [],
  "warnings": ["scan detected but no rules file found ..."]
}
```

配置映射：`scan_dependency.require_rules_file_when_scan_detected=true` 等价于默认 `require_rules=true`。

### 6) `research_team_branch_semantics_gate`

目的：多根/多分支语义门禁（防止 band 语义错误 / branch mixing）。

输入（JSON）：
```json
{
  "notebook_path": "research_contract.md",
  "require_when_declared": true
}
```

输出（JSON）：
```json
{
  "ok": false,
  "applicable": true,
  "errors": ["Branch inventory missing ..."],
  "warnings": []
}
```

配置映射：`branch_semantics.require_when_declared=false` 可把 errors 降级为 warnings（非阻塞；不推荐长期默认）。

### 7) `research_team_pointer_lint`

目的：code pointer 门禁（支持跨语言策略）。

输入（JSON）：
```json
{
  "notebook_path": "research_contract.md",
  "strategy": "file_symbol_grep",
  "python_import_cmd": null
}
```

输出（JSON）：
```json
{
  "ok": true,
  "strategy": "file_symbol_grep",
  "checked": 12,
  "failed": []
}
```

### 8) `research_team_gate`（Mandatory）

目的：解析两份成员报告，给出“是否收敛”的确定性判据（当前是脚本）。

输入（JSON）：
```json
{
  "member_a_report_path": "team/M2-r1_member_a.md",
  "member_b_report_path": "team/M2-r1_member_b.md",
  "require_verdict_ready": true
}
```

输出（JSON）：
```json
{
  "converged": false,
  "member_a": {"derivation": "pass", "computation": "fail", "verdict": "needs_revision"},
  "member_b": {"derivation": "pass", "computation": "pass", "verdict": "ready"},
  "errors": [],
  "warnings": []
}
```

强制策略：在产品化流程中，**每轮成员交叉检验之后必须调用本 gate**，若 `converged=false` 则阻止里程碑推进。

## Claim DAG / Evidence 相关 MCP tools（新增，已在 skill 脚本落地）

这些工具对应当前 skill 中的确定性脚本（MVP 已实现），适合直接 MCP 化：

### 9) `research_claim_dag_scaffold`

目的：初始化 `knowledge_graph/`（Claim DAG + Evidence）目录与空的 JSONL 文件。

输入：
```json
{
  "project_root": "/abs/path",
  "project_name": "My Project",
  "overwrite": false
}
```

输出：
```json
{
  "success": true,
  "created_files": [
    "knowledge_graph/claims.jsonl",
    "knowledge_graph/edges.jsonl",
    "knowledge_graph/evidence_manifest.jsonl",
    "knowledge_graph/README.md"
  ],
  "skipped_files": []
}
```

### 10) `research_claim_graph_gate`

目的：校验 `claims.jsonl` + `edges.jsonl` 的 schema 与一致性（含依赖环检测）。

输入：
```json
{
  "notebook_path": "research_contract.md",
  "claims_path": null,
  "edges_path": null,
  "manifest_path": null,
  "require_manifest": false
}
```

输出：
```json
{
  "ok": false,
  "errors": [
    {"file":"knowledge_graph/claims.jsonl","line":12,"message":"unknown dependency claim id: ..."}
  ],
  "warnings": []
}
```

### 11) `research_evidence_manifest_gate`

目的：校验 `evidence_manifest.jsonl` 的 schema；可选检查本地路径存在性。

输入：
```json
{
  "notebook_path": "research_contract.md",
  "manifest_path": null,
  "require_paths_exist": false
}
```

输出：
```json
{
  "ok": true,
  "errors": [],
  "warnings": [
    {"file":"knowledge_graph/evidence_manifest.jsonl","line":7,"message":"evidence path not found (warn-only): ..."}
  ]
}
```

### 12) `research_claim_trajectory_link_gate`

目的：校验 claim 的 `linked_trajectories` 能在 `team/trajectory_index.json` 中找到对应 tag；支持 `current_tag`（允许“本轮 tag”在 preflight 阶段尚未写入索引的 bootstrap 场景）。

输入：
```json
{
  "notebook_path": "research_contract.md",
  "claims_path": null,
  "team_dir": "team",
  "current_tag": "M2-r1"
}
```

输出：
```json
{
  "ok": false,
  "errors": [
    {"file":"knowledge_graph/claims.jsonl","line":3,"message":"unknown linked trajectory tag ..."}
  ],
  "warnings": []
}
```

### 13) `research_team_preflight`

目的：只跑 deterministic preflight gates + 生成/修补 team packet（不调用外部 LLM），对应当前脚本的 `run_team_cycle.sh --preflight-only`。

输入：
```json
{
  "tag": "M2-r1",
  "notebook_path": "research_contract.md",
  "out_dir": "team",
  "member_a_system_prompt_path": "prompts/_system_member_a.txt",
  "member_b_system_prompt_path": "prompts/_system_member_b.txt"
}
```

输出：
```json
{
  "ok": true,
  "packet_path": "team/team_packet_M2-r1.txt",
  "gate_reports": [
    {"gate":"capsule","ok":true},
    {"gate":"claim_graph","ok":true}
  ]
}
```

### 14) `research_team_mechanisms_scaffold`

目的：初始化 `mechanisms/`（clarifier/analogy/Problem Framing 模板与示例），用于“理论突破机制落地”（非 gate）。

输入：
```json
{
  "project_root": "/abs/path",
  "project_name": "My Project",
  "profile": "mixed",
  "overwrite": false
}
```

输出：
```json
{
  "success": true,
  "created_files": ["mechanisms/00_pre_task_clarifier.md", "mechanisms/01_analogy_mining.md", "mechanisms/02_problem_framing_protocol.md"],
  "skipped_files": []
}
```

## Override / Fork（治理机制）相关 MCP tools（规划）

注意：这部分强调“科研一致性”，不使用“按月豁免配额”。Override 是**科学债务合约**（scope+替代证据+过期条件+回补计划），Fork 是**竞争解释竞速**（判别测试+TTL+kill criteria）。

### 15) `research_claim_override_apply`（规划）

目的：写入/更新 override 记录（债务合约），并标注受影响的 claim 为 `tainted`（或 `verified_with_dissent`）。

输入（示意）：
```json
{
  "claim_id": "CLM-20260114-001",
  "gate_id": "claim_graph_gate",
  "scope": {"tag":"M2-r1","files":["knowledge_graph/claims.jsonl"]},
  "rationale": "profile_mismatch",
  "alternative_evidence": ["EVD-..."],
  "expiry": {"type":"tag_delta","value":1},
  "remediation_plan": "next tag 补齐 evidence_manifest 并重新启用 gate"
}
```

### 16) `research_claim_fork_create`（规划）

目的：把未决分歧显式分叉成竞争 claims，并要求至少一个判别测试条目（fail-fast 防止无意义 fork）。

输入（示意）：
```json
{
  "parent_claim_id": "CLM-...",
  "branches": [
    {"id":"CLM-...-A","statement":"...","assumptions_delta":["..."]},
    {"id":"CLM-...-B","statement":"...","assumptions_delta":["..."]}
  ],
  "edge_type": "competitor",
  "discriminating_tests": [{"type":"numerics","spec":"..."}]
}
```

## Knowledge base 相关 MCP tools（新增，推荐）

为保持通用性，这里不用“物理术语绑定”，只用层级语义：
- `literature/`：引用/摘录/证据
- `methodology_traces/`：已验证的方法流程/复现记录/关键脚本片段
- `priors/`：先验约定（符号、归一化、范围、不可比项）

### 17) `research_kb_scaffold`

目的：初始化分层知识库目录（可选强制）。

输入：
```json
{
  "project_root": "/abs/path",
  "layout": "landau_3layer",
  "overwrite": false
}
```

输出：
```json
{
  "success": true,
  "created_dirs": ["literature", "methodology_traces", "priors"],
  "created_files": []
}
```

### 18) `research_kb_index_build`

目的：为分层知识库生成一个确定性的索引（便于 packet/审计引用；也便于长期任务外部化 progress）。

输入：
```json
{
  "project_root": "/abs/path",
  "output_path": "knowledge_base/index.json"
}
```

输出：
```json
{
  "success": true,
  "index_path": "knowledge_base/index.json",
  "counts": { "literature": 12, "methodology_traces": 7, "priors": 3 }
}
```

### 19) `research_kb_validate_references`

目的：验证 notebook（或 team packet）中引用的 KB 路径都存在，并且本 milestone 至少引用/更新了方法痕迹（减少“只靠口头说”的不可复现风险）。

输入：
```json
{
  "notebook_path": "research_contract.md",
  "require_min_traces": 1
}
```

输出：
```json
{
  "ok": false,
  "missing_paths": ["methodology_traces/M2/solver_notes.md"],
  "warnings": []
}
```

## 非目标（Non-goals）

- MCP tools 不尝试“证明数学正确”；只做**合约检查、引用/证据链校验、确定性一致性检查**。
- 不隐藏 fit 参数：相反要强制显式声明（capsule/priors 层）。
- 不自动跑 LLM（除非单独设计 orchestrator tool 并接受非确定性）。

## 为什么 MCP（相对 skill）

- skill：迭代最快、适合人机协作、prompt 可快速调。
- MCP tools：结构化、可组合、跨 agent/跨项目复用；更适合作为“团队基础设施”的确定性底座。
