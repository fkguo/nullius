# Phase 2 Batch 5 — Approval Infrastructure + Skills LOC Budget

## 前置状态

- Phase 0: ALL DONE (14/14)
- Phase 1: 18/22 done (remaining: NEW-R03b/UX-01/UX-05/M-19 deferred)
- Phase 2: 24/43 done
  - Batch 1 ✅: H-07, H-11b, H-12, H-15b, H-17 (reliability + safety)
  - Phase 2A ✅: NEW-RT-02, NEW-RT-03 (reconnect, span tracing)
  - Phase 2B ✅: NEW-CONN-02 (review feedback)
  - Batch 2 ✅: M-19, H-16b, M-21, M-05, M-02, M-06 (contracts + observability + payload)
  - Batch 3 ✅: H-05, H-09, H-10, H-21, M-23, NEW-R07 (data paths + file lock + CAS + event enum + coverage gate)
  - Batch 4 ✅: M-20, trace-jsonl, NEW-R06, NEW-R05 (migration registry + JSONL logging + schema consolidation + evidence SSOT)
- REDESIGN_PLAN: v1.8.0-draft
- **总进度**: 56/135
- **Last commits**: `85f816f` (Batch 4 impl), `864ad98` (deadlock fix), `e5ec656` (TOCTOU tests)

## 本批目标

Phase 2 第五层——审批基础设施完善 + 技能代码质量。Batch 4 完成了 schema SSOT 和可观测性，现在构建审批工作流三件套和技能 LOC 治理。

**NEW-02 是关键路径**：完成后解锁 NEW-03、NEW-04、UX-07、NEW-R15-impl。

**本批 4 项** (Python):

| # | ID | 标题 | 估计 LOC | 依赖 | 解锁 |
|---|-----|------|---------|------|------|
| 1 | NEW-02 | 审批产物三件套 + CLI 可读性 | ~200 | H-04 ✅, NEW-01 ✅ (M-22 deferred→P3) | NEW-03, NEW-04, UX-07, NEW-R15-impl |
| 2 | NEW-03 | 审批 CLI 查看命令 | ~80 | NEW-02 (本批) | UX-07 |
| 3 | NEW-04 | 自包含人类报告生成 | ~250 | NEW-02 (本批), H-18 ✅ | — |
| 4 | NEW-R08 | Skills LOC 预算 | ~refactoring | NEW-R02a ✅ | — |

**总估计**: ~530 LOC + refactoring

完成后 Phase 2 进度: 28/43 done (从 24 升至 28)。
解锁: NEW-R15-impl (编排器 MCP 工具实现) → NEW-RT-01 (TS AgentRunner) → NEW-RT-04 (Durable Execution)。

---

## 执行前必读

1. `serena:read_memory` → `architecture-decisions.md` 和 `codebase-gotchas.md`
2. Claude Code auto memory → `memory/MEMORY.md` 和 `memory/batch-workflow.md`
3. 读 `meta/REDESIGN_PLAN.md` 中各项详细规格（搜索 NEW-02, NEW-03, NEW-04, NEW-R08）
4. 读 `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` — 现有 `_request_approval()` 和 CLI 入口
5. 读 `packages/hep-autoresearch/src/hep_autoresearch/toolkit/` — 现有 toolkit 模块结构
6. 读 `meta/schemas/` — 现有 schema 列表（确认 approval_packet 不存在）
7. 读 `skills/` 目录结构 — 识别需要 LOC 治理的脚本

---

## Item 1: NEW-02 — 审批产物三件套 + CLI 可读性重做

**REDESIGN_PLAN 行号**: 搜索 `NEW-02`

**范围**: 将现有 `_request_approval()` 从生成单一 `packet.md` 改为生成三件套：
- `packet_short.md` (≤60行，终端默认展示)
- `packet.md` (全量)
- `approval_packet_v1.json` (结构化)

**实现**:
1. 创建 `meta/schemas/approval_packet_v1.schema.json`:
   - 字段: `purpose`, `gate_id`, `run_id`, `approval_id`, `plan[]`, `risks[]`, `budgets{}`, `outputs[]`, `rollback`, `commands[]`, `checklist[]`
   - 通过 codegen 生成 TS + Python 类型
2. 创建 `packages/hep-autoresearch/src/hep_autoresearch/toolkit/approval_packet.py`:
   - `ApprovalPacketRenderer`: 从 state + policy 构建 ApprovalPacket
   - 方法: `render_short()`, `render_full()`, `render_json()`
3. 创建 Jinja2 模板:
   - `templates/packet_short.md.jinja2`: TL;DR, Gate, run-id, 命令, 预算表, checklist
   - `templates/packet_full.md.jinja2`: 全量（保留现有信息 + gate resolution trace）
4. 修改 `orchestrator_cli.py`:
   - `_request_approval()` → 写入三件套到 `approvals/<approval_id>/`
5. 测试: `test_approval_packet.py` — schema 验证, 模板渲染, 三件套完整性

**验收**:
- [ ] `_request_approval()` 生成三份产物且 JSON 通过 schema 验证
- [ ] `packet_short.md` ≤60 行（超限附 overflow 指针）
- [ ] `packet.md` 包含现有信息（无回归）
- [ ] JSON 含 `purpose`, `plan[]`, `risks[]`, `budgets{}`, `outputs[]`, `rollback`, `commands[]`

---

## Item 2: NEW-03 — 审批 CLI 查看命令

**REDESIGN_PLAN 行号**: 搜索 `NEW-03`

**范围**: 新增 CLI 子命令 `approvals show`。

**实现**:
1. 在 `orchestrator_cli.py` 添加 `approvals show` 子命令:
   - `--run-id <RID>` (必需)
   - `--gate <A?>` (可选，默认列出所有)
   - `--format short|full|json` (默认 `short`)
2. short → 终端打印 `packet_short.md`
3. full → 打印 `packet.md`
4. json → 输出 `approval_packet_v1.json` 到 stdout（可被 `jq` 管道处理）
5. 无匹配时返回清晰错误信息（不抛异常）
6. 测试: `test_approvals_cli.py`

**验收**:
- [ ] `hepar approvals show --run-id <RID> --gate A3` 默认打印 short 版本
- [ ] `--format json` 输出可被 `jq` 解析
- [ ] 无匹配审批时返回清晰错误信息

---

## Item 3: NEW-04 — 自包含人类报告生成

**REDESIGN_PLAN 行号**: 搜索 `NEW-04`

**范围**: 从 run 结果生成自包含 Markdown/LaTeX 报告。

**实现**:
1. 创建 `packages/hep-autoresearch/src/hep_autoresearch/toolkit/report_renderer.py`:
   - `ReportRenderer`: 从 run 的 `analysis.json` / `headline_numbers` / CSV/PNG 生成报告
   - 支持 Markdown 和 LaTeX 输出
   - 每个 artifact 引用附 URI + SHA256 审计指针
2. 创建 Jinja2 模板:
   - `templates/report.md.jinja2`: 摘要 → 各 run 结果（含表格/图引用）→ 审计指针
   - `templates/report.tex.jinja2`: LaTeX 版本
3. 在 `orchestrator_cli.py` 添加 `report render` 子命令:
   - `--run-ids <RID,...>`
   - `--out md|tex`
   - `--output-path <path>` (可选)
4. 测试: `test_report_renderer.py`

**验收**:
- [ ] `hepar report render --run-ids run_abc --out md` 生成自包含 Markdown 报告
- [ ] 报告含各 run 关键数值、表格、图引用
- [ ] 报告含审计指针：每个 artifact 附 URI + SHA256
- [ ] `--out tex` 生成可编译的 LaTeX 文件

---

## Item 4: NEW-R08 — Skills LOC 预算

**REDESIGN_PLAN 行号**: 搜索 `NEW-R08`

**范围**: 6 个技能脚本超出 CODE-01.1 200 eLOC 限制，需拆分。

**实现**:
1. 识别 `skills/*/scripts/` 下超过 200 eLOC 的脚本（已知最大: `build_team_packet.py` 1130 LOC）
2. 对每个超标脚本:
   - 如果可拆分: 拆分为多个 ≤200 eLOC 模块
   - 如果暂时无法拆分: 添加 `# CONTRACT-EXEMPT: <reason>` + sunset date
3. 确保 CI gate 覆盖 `skills/` 目录
4. 测试: 拆分后脚本功能不变（smoke test）

**验收**:
- [ ] 6 个脚本拆分至 ≤200 eLOC（或有 CONTRACT-EXEMPT + sunset）
- [ ] CI gate 覆盖 skills 目录

---

## 验收命令

```bash
# 构建
pnpm -r build

# 运行 codegen (新增 approval_packet schema)
npx tsx meta/scripts/codegen-ts.ts
npx tsx meta/scripts/codegen-barrel.ts
python3 meta/scripts/codegen-py.py

# 测试
pnpm -r test                        # TS tests
python -m pytest packages/hep-autoresearch/tests/ -q  # Python tests

# Schema 验证
python3 -c "
import json, jsonschema
schema = json.load(open('meta/schemas/approval_packet_v1.schema.json'))
jsonschema.validate({'version': 1, 'chains': []}, schema)
print('Schema valid')
"
```

---

## 双模型审核

收敛后执行 review-swarm (Codex + Gemini):

```bash
python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir /tmp/phase2-batch5-r1-review \
  --system <system_prompt.md> \
  --prompt <review_packet.md>
```

### 审核规则
- 0 BLOCKING from ALL models = CONVERGED → commit + push
- Any BLOCKING → fix → R+1 (full packet)
- 必须处理所有模型的所有 BLOCKING findings（不能只处理某个模型的）
- 最终收敛轮必须使用完整 packet
- 最多 5 轮，超过 → 人类介入
- Codex CLI 可能需要 10-15 分钟 — 不要提前截断

---

## 收敛后操作

1. Commit: `feat: Phase 2 Batch 5 — approval infrastructure + skills LOC budget (NEW-02 + NEW-03 + NEW-04 + NEW-R08)`
2. Push to main
3. 更新 REDESIGN_PLAN:
   - 各 item header 添加 `✅ Phase 2 Batch 5`
   - Phase 2 映射行更新 done count: 28/43
   - 总计行更新: done count += 4
4. 更新 auto memory (`memory/MEMORY.md`): Phase 2 progress, Batch 5 learnings
5. **生成下一批 prompt**: 按 `memory/batch-workflow.md` 自续协议，生成 `meta/docs/prompt-phase2-impl-batch6.md`

---

## 自续 Prompt 生成指令

After convergence + commit + push, MUST:

1. Read REDESIGN_PLAN to identify next unblocked items (Phase 2 pending after Batch 5)
2. Group into coherent batch (~500-800 LOC, 4-6 items)
3. Write `meta/docs/prompt-phase2-impl-batch6.md` with full context
4. New prompt MUST also contain this self-continuation instruction (recursive)
5. Recommended Batch 6 candidates (based on Batch 5 completion):
   - NEW-R15-impl (编排器 MCP 工具实现) — unblocked by NEW-02
   - NEW-R14 (hep-mcp 包拆分)
   - NEW-IDEA-01 (idea-core MCP 桥接)
   - RT-02, RT-03 (research-team 增强)
   - NEW-VIZ-01 (可视化层)
