# Computation MCP 工具表面安全模型设计

**ID**: NEW-COMP-01  
**状态**: 设计文档 (Phase 2 late)  
**依赖**: C-02 (shell 执行隔离), NEW-R15-impl (orchestrator MCP tools)  
**后续**: NEW-COMP-02 (完整实现, Phase 3), NEW-CONN-03 (Computation Evidence Ingestion)

---

## 1. 目标

定义 `computation` substrate 的 MCP 工具表面安全模型，使 agent 可以在**任务 / 能力 / 审批 / 审计**边界内触发计算、推导、验证与复现执行，而不把任一现有工具链或单一学科假设固化为唯一执行路径。

当前首个高优先级 provider 是 `hep-calc`（HEP theory），但本设计要求：

- compute 语义按 **task/capability-first** 建模；
- 现有 package / backend 名称只作开放 provider 示例；
- 运行时的方法拆解、provider 选择、参数化与 fallback 默认由 LLM / agent 在 typed contract + approval/policy + provenance 边界内决定。

`computation` 是理论研究 substrate 中的核心执行节点，负责把已批准的 execution plan 交给某个 provider 执行，并将结果摄取为 `ComputationEvidenceCatalogItemV1`。

---

## 2. 工具清单

### 2.1 已有工具（Phase 2 可用）

| 工具名 | 所在 package | 风险等级 | 说明 |
|--------|-------------|---------|------|
| `hep_run_create` | hep-mcp | `safe` | 创建 run |
| `hep_run_build_evidence` | hep-mcp | `destructive` | 构建证据索引 |
| `orch_run_approve` | hep-mcp (orchestrator MCP) | `destructive` | 人类审批 A3 计算执行门禁 |

### 2.2 新增工具（本设计规格）

> 现阶段 `hep-mcp` 是 computation provider 的首个宿主包，因此工具仍以 `hep_run_*` 暴露；这不意味着 computation substrate 被绑定到 HEP。

| 工具名 | 风险等级 | 需审批 | 说明 |
|--------|---------|-------|------|
| `hep_run_ingest_skill_artifacts` | `destructive` | 否 (路径须通过 C-02 白名单) | 将 provider / skill 产出摄取为计算证据 |
| `hep_run_execute_manifest` | `destructive` | 是 (A3 gate) | 执行 `computation/manifest.json` 中声明的 execution plan |

> `hep_run_execute_manifest` 是 Phase 3 (NEW-COMP-02) 的范围，仅在此处设计规格以指导后续实现。

---

## 3. `hep_run_ingest_skill_artifacts` 工具规格

```typescript
{
  name: 'hep_run_ingest_skill_artifacts',
  description: '将 provider/skill 产出文件摄取为 ComputationEvidenceCatalogItemV1 条目，写入 computation_evidence_catalog_v1.jsonl',
  inputSchema: z.object({
    run_id: z.string().describe('目标 run 的 ID'),
    skill_artifacts_dir: z.string().describe(
      '绝对路径，必须在 run_dir 内 (C-02 白名单检查)。provider/skill 产出文件的根目录。'
    ),
    manifest_path: z.string().optional().describe(
      'computation_manifest_v1.schema.json 路径；提供时记录 manifest_sha256。'
    ),
    tags: z.array(z.string()).max(20).optional().describe('分类标签，最多 20 个'),
  }),
  riskLevel: 'destructive',
  requiresApproval: false,
}
```

**语义约束**:

- 输入目录可以来自 `hep-calc`，也可以来自后续其他 computation provider；
- 工具只负责**摄取 + 建立证据 / provenance**，不决定该 provider 是否“标准”；
- catalog item 必须记录 provider / artifacts / manifest / hash，而不是假设固定 backend 类型。

**输出**:

```json
{
  "ok": true,
  "catalog_entry_id": "comp_ev_<sha256_prefix>",
  "artifact_count": 4,
  "ingested_at": "2026-02-27T00:00:00Z"
}
```

**副作用**:

- 向 `<run_dir>/computation_evidence_catalog_v1.jsonl` 追加一条 `ComputationEvidenceCatalogItemV1` 记录
- 计算所有 artifact 文件的 SHA-256

---

## 4. `hep_run_execute_manifest` 工具规格（Phase 3 预定义）

```typescript
{
  name: 'hep_run_execute_manifest',
  description: '执行 computation/manifest.json 声明的 execution plan。需要 A3 人类审批。',
  inputSchema: z.object({
    run_id: z.string(),
    manifest_path: z.string().describe(
      '相对或绝对路径，必须在 run_dir/computation/ 内；其内容表达 capability requirements、provider choice 或 provider payload。'
    ),
    dry_run: z.boolean().default(false).describe('仅验证 manifest 而不执行'),
  }),
  riskLevel: 'destructive',
  requiresApproval: true,
}
```

**关键约束**:

- manifest 表达的是**execution plan / capability contract**，不是对单一 package 的硬编码；
- provider 选择可以固定，也可以由 runtime planner 先行决定后写入 manifest；
- 当前首批 provider 可以是 `hep-calc`，但 schema 不应把工具链枚举封死在接口层。

---

## 5. C-02 Containment 对齐

所有接受路径参数的 computation 工具必须实施以下检查（与 C-02 `_validate_paths` 对齐）：

### 5.1 路径白名单

允许写入的路径前缀（运行时从配置读取）：

```
<repo_root>/.autoresearch/runs/<run_id>/
<HEP_DATA_DIR>/                           (可选，需显式配置)
```

**禁止**写入的路径：

- 系统目录（`/etc/`, `/usr/`, `/var/`, `/tmp/` 以外的路径）
- 仓库根目录以外的任意目录（路径遍历检查: `..` 规范化后必须仍在白名单内）

### 5.2 命令黑名单（`hep_run_execute_manifest`）

执行前对 manifest 中每个步骤的 `script` / `argv` / entrypoint 校验：

- 禁止：`rm -rf /`, `curl | sh`, `chmod 777`, `> /dev/`, `nc`, `ncat`
- 禁止：含 `..` 的路径（路径遍历）
- 禁止：脚本路径以 `/` 开头但不在 run_dir 内

### 5.3 非降级原则

- 路径检查失败 → 返回 `{ isError: true, errorCode: 'UNSAFE_FS' }`
- 命令黑名单命中 → 返回 `{ isError: true, errorCode: 'BLOCKED_COMMAND' }`
- 两种错误均不写入任何文件，不触发部分执行

---

## 6. A3 Default Gating

`hep_run_execute_manifest` 触发实际执行，是 A3 gate 的典型场景：

**执行流程**:

1. Agent 调用 `hep_run_execute_manifest`
2. 工具生成 approval packet（包含 execution plan 摘要 + capability/provider 选择 + 预算 + containment 状态）
3. 工具返回 `{ requires_approval: true, approval_id: "A3-XXXX", packet_path: "..." }`
4. AgentRunner 检测到 `requires_approval: true`，emit `approval_required` event，暂停
5. 人类通过 `hepar approve A3-XXXX` 批准
6. Agent 收到通知，通过 `orch_run_approve` 确认，继续执行

**Approval packet 内容（A3 gate）**:

- execution plan 摘要（entry point、steps、预期输出）
- capability requirements（如 symbolic derivation / numerical scan / proof check）
- provider 选择理由（若已确定）或 provider-routing 约束
- 计算预算（估计运行时间、内存、磁盘）
- C-02 containment 状态（路径检查通过 / 命令黑名单检查通过）

---

## 7. 计算产出与证据目录

**关键设计决策**：计算结果**不**写入 `EvidenceCatalogItemV1`。

| 字段 | `EvidenceCatalogItemV1` | `ComputationEvidenceCatalogItemV1` |
|------|------------------------|-----------------------------------|
| 用途 | LaTeX 论文段落的文献证据 | 计算/推导/验证执行产出 |
| `paper_id` | **required** | **不存在** |
| `LatexLocatorV1` | required | **不存在** |
| `artifacts` | 无 | `{ path, sha256 }[]` |
| `manifest_sha256` | 无 | SHA-256 of manifest.json |
| `source_type` | `"literature"` | `"computation"` |

计算证据写入 `<run_dir>/computation_evidence_catalog_v1.jsonl`，与文献证据 `evidence_catalog_v1.jsonl` 并行存储，互不影响。

---

## 8. 工具接入点（与 NEW-R15-impl 对齐）

computation 工具当前以 `hep_run_*` 命名空间注册在 `hep-mcp` 中，与 `orch_run_*` 工具命名空间无冲突；长期看，这一层可以被更通用的 provider host / registry 吸收，但 contract 语义保持不变。

**agent 调用顺序示例**:

```
1. orch_run_create (run_id = "computation_run_1")
2. hep_run_execute_manifest → requires_approval=true (A3)
3. [人类审批] orch_run_approve
4. [执行完成]
5. hep_run_ingest_skill_artifacts (skill_artifacts_dir = .../artifacts/)
6. hep_run_build_evidence (合并计算证据到索引)
```

---

## 9. Schema 参考

- 计算清单 schema: `meta/schemas/computation_manifest_v1.schema.json` (UX-02, Batch 7)
- 计算证据目录条目 schema: `meta/schemas/computation_evidence_catalog_item_v1.schema.json` (NEW-CONN-03 authority)
- 审批 packet schema: `meta/schemas/approval_packet_v2.schema.json` (UX-07, Batch 7)
