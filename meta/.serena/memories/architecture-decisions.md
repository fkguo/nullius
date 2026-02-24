## [2026-02-23] Track A Schema Design Debt (Tier 3 — post-R19 review convergence)

**上下文**: `redesign/track-a` 分支，R15-R19 双模型架构审查循环
**关联项**: REDESIGN_PLAN — Track A schemas

### 决策背景

R18 起，Codex 和 Gemini 审查从 "doc↔SSOT 对齐" 转向 "schema 设计严格性" 要求。
经调研 CloudEvents / A2A / JSON-RPC 先例后，采用 3 层分级修复策略：
- Tier 1 (具体 doc bug): 已修复 (R15-R19)
- Tier 2 (一行 schema 改进): 已修复 (R18-R19)
- **Tier 3 (设计债): 下列项在实现阶段逐步完善**

### Tier 3 设计债清单

1. **Inner payload schema typing** (D2)
   - `PublishPayload.asset` 和 `ReportPayload.event` 在 SSOT 中是 `{type: "object"}`
   - 设计决策：遵循 CloudEvents dataschema 模式 — envelope validates envelope, SDK validates inner payload at runtime
   - 实现时：REP SDK `validatePayload()` 必须根据 `asset_type` / `message_type` 加载对应 schema 并验证
   - 相关文件：`schemas/rep_envelope_v1.schema.json`

2. **Signature conditional enforcement** (D3)
   - `signature.value` 应在 `algorithm=hmac-sha256` 时 required，但 SSOT 未用 if/then 强制
   - 实现时：用 JSON Schema `allOf + if/then` 或在 SDK 层验证
   - 相关文件：`schemas/rep_envelope_v1.schema.json:59`

3. **Unconstrained reference strings** (D3)
   - `integrity_report_ref`, 部分 `report_id` 等字段是 unconstrained string
   - 实现时：加 `pattern: "^[0-9a-f]{64}$"` 或 `format: "uuid"` 约束
   - 相关文件：多个 schema

4. **Inline ArtifactRef duplication** (D5)
   - `integrity_report_v1` (target_ref), `reproducibility_report_v1` (original_ref, rerun_ref) 内联了 ArtifactRef
   - `artifact_ref_v1.schema.json` 已创建（R16），但尚未全面 $ref 化
   - 实现时：将内联定义替换为 `$ref: artifact_ref_v1.schema.json`
   - 相关文件：`schemas/integrity_report_v1.schema.json:25`, `schemas/reproducibility_report_v1.schema.json:26`

5. **Absolute $ref URL resolution** (D5)
   - `research_outcome_v1.schema.json:76` 用绝对 URL `$ref`
   - 实现时：提供 bundled schema resolver 映射，或改用相对 $ref
   - 相关文件：`schemas/research_outcome_v1.schema.json:76`

6. **Domain-agnosticism strictness** (D1, Gemini R18)
   - `reproducibility_report_v1` 的 `central/value_a/value_b` 限 `number` 类型
   - `research_strategy_v1` 的 `expected_outcome_form.quantities.type` enum 不含 `boolean/symbolic`
   - `Evidence.type` enum 不含 `formal_proof`
   - 设计决策：当前以 HEP 为优先，V2 schema 中扩展为 `number | string | boolean`
   - 相关文件：`schemas/reproducibility_report_v1.schema.json`, `schemas/research_strategy_v1.schema.json`, `schemas/integrity_report_v1.schema.json`

7. **Fail-closed gate business logic** (D3, Gemini R18)
   - `ToleranceSpec` 不 require 任何字段（空 `{}` 通过验证）
   - `SignalDetectedPayload` 缺少 `priority` 和 signal `payload`
   - 设计决策：这些是业务逻辑约束，在 SDK 层或 Domain Pack 层实现
   - 相关文件：`schemas/reproducibility_report_v1.schema.json`, `schemas/research_event_v1.schema.json`

### 影响

实现 REP SDK (EVO-17) 时，上述 7 项必须作为 SDK 验证逻辑或 V2 schema migration 规划的一部分处理。
建议在 SDK 实现时逐项关闭，每关闭一项在本文件标注 ✅。
