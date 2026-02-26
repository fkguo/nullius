# Phase 2 Batch 6 — Research-Team Enhancement + Graph Visualization + Conditional Refactoring

## 前置状态

- Phase 0: ALL DONE (14/14)
- Phase 1: 18/22 done (remaining: NEW-R03b/UX-01/UX-05/M-19 deferred)
- Phase 2: 28/43 done
  - Batch 1 ✅: H-07, H-11b, H-12, H-15b, H-17 (reliability + safety)
  - Phase 2A ✅: NEW-RT-02, NEW-RT-03 (reconnect, span tracing)
  - Phase 2B ✅: NEW-CONN-02 (review feedback)
  - Batch 2 ✅: M-19, H-16b, M-21, M-05, M-02, M-06 (contracts + observability + payload)
  - Batch 3 ✅: H-05, H-09, H-10, H-21, M-23, NEW-R07 (data paths + file lock + CAS + event enum + coverage gate)
  - Batch 4 ✅: M-20, trace-jsonl, NEW-R06, NEW-R05 (migration registry + JSONL logging + schema consolidation + evidence SSOT)
  - Batch 5 ✅: NEW-02, NEW-03, NEW-04, NEW-R08 (approval infrastructure + skills LOC budget)
- REDESIGN_PLAN: v1.8.0-draft
- **总进度**: 60/135
- **Last commit**: `9212d9c` (Batch 5 impl — approval trio + approvals CLI + human report + skills LOC)

## 本批目标

Phase 2 第六层——research-team 能力增强 + 可视化基础设施 + 条件性代码重构。Batch 5 完成了审批基础设施，现在增强研究团队工具链和可视化层。

**本批 4 项** (混合语言: Bash/Python + TS):

| # | ID | 标题 | 估计 LOC | 依赖 | 解锁 |
|---|-----|------|---------|------|------|
| 1 | RT-03 | 统一 Runner 抽象 + API 可配置性 | ~150 | 无 | 第三方 LLM 接入 |
| 2 | RT-02 | 工具访问增强 + 溯源 Clean-Room | ~400 | 无 (与 RT-03 同期) | 安全溯源链 |
| 3 | NEW-R10 | service.py 拆分 (条件决策) | ~refactoring | 无硬依赖 (决策门禁) | — |
| 4 | NEW-VIZ-01 | Graph Visualization Layer | ~300 TS | 无 | 5 domain 可视化 |

**总估计**: ~850 LOC + refactoring

完成后 Phase 2 进度: 32/43 done (从 28 升至 32)。
下一步: NEW-R15-impl (编排器 MCP 工具实现) 已被 Batch 5 (NEW-02) 解锁，可作为 Batch 7 重点。

---

## 执行前必读

1. `serena:read_memory` → `architecture-decisions.md` 和 `codebase-gotchas.md`
2. Claude Code auto memory → `memory/MEMORY.md` 和 `memory/batch-workflow.md`
3. 读 `meta/REDESIGN_PLAN.md` 中各项详细规格（搜索 RT-02, RT-03, NEW-R10, NEW-VIZ-01）
4. 读 `skills/research-team/` 目录结构 — 现有 runner 和工作流脚本
5. 读 `packages/idea-core/src/idea_core/engine/service.py` — 了解 NEW-R10 拆分对象（3165 LOC）
6. 读 `meta/docs/graph-visualization-layer.md` — NEW-VIZ-01 设计文档（9 轮双模型审查收敛）
7. 读 `packages/shared/src/` — TS 共享类型结构（NEW-VIZ-01 目标位置）

---

## Item 1: RT-03 — 统一 Runner 抽象 + API 可配置性

**REDESIGN_PLAN 行号**: 搜索 `RT-03`

**范围**: 参数化 research-team runner（当前硬编码 Claude/Gemini/Codex），支持自托管和第三方 LLM provider。

**实现**:
1. 在 `run_team_cycle.sh` 添加参数:
   - `--member-X-runner <path>` (自定义 runner 脚本路径)
   - `--member-X-api-base-url <url>`
   - `--member-X-api-key-env <ENV_VAR_NAME>` (传环境变量名，不传值)
   - `--member-X-api-provider <provider>`
2. 修改现有 runners (`run_{claude,gemini,codex}.sh`) 添加 `--api-base-url` / `--api-key-env` 支持
3. 创建 `scripts/runners/run_openai_compat.sh` — 通用 OpenAI-compatible runner (支持 DeepSeek/Qwen/vLLM)
4. **安全约束**: `--api-key <value>` 明文传参 → CLI 直接报错拒绝

**验收**:
- [ ] `--member-X-runner` 自定义 runner 脚本可替换内置 runner
- [ ] `--api-key-env` 传环境变量名，API key 不出现在进程列表/日志/artifact
- [ ] `run_openai_compat.sh` 可调用 DeepSeek/Qwen/vLLM 端点

---

## Item 2: RT-02 — 工具访问增强 + 溯源 Clean-Room

**REDESIGN_PLAN 行号**: 搜索 `RT-02`

**范围**: 三层 clean-room — 工作区隔离 + 溯源交叉验证 + hard-fail 门禁。

**实现**:
1. `run_team_cycle.sh`: 新增 `--member-X-tool-access {restricted|full}`，生成随机化 workspace 路径
2. `run_member_review.py`: full 模式启用 MCP 工具 + provenance 收集
3. 新建 `scripts/lib/provenance.py`: provenance schema (claim_id/step_id/tool_call_ids 三级关联)、提取、验证
4. 重写 `scripts/gates/check_clean_room.py`: workspace 隔离检查 + provenance 交叉验证 + hard-fail 门禁
5. 新建 `scripts/lib/audit_interceptor.py`: MCP tool_use 调用记录 (tc_id + workspace) + 跨 workspace 访问检测
6. 新建 `scripts/lib/workspace_isolator.py`: 随机化 workspace + 路径泄漏防护 + shell 安全约束

**关键设计**: 三层 — (1) workspace 隔离 (随机路径+路径遍历阻断), (2) provenance 交叉验证, (3) hard-fail 门禁 (CONTAMINATION_DETECTED/PROVENANCE_MISMATCH → 不可降级)。

**验收**:
- [ ] full 模式: 成员可使用原生 MCP 工具 + provenance 自动记录
- [ ] 工作区隔离: 随机化路径 + shell cwd 锁定 + 路径遍历阻断
- [ ] clean-room gate: CONTAMINATION_DETECTED → hard-fail
- [ ] audit log: tc_id/tool_name/args_hash/result_hash/workspace/timestamp
- [ ] provenance.tool_call_ids 与 audit log 精确匹配验证

---

## Item 3: NEW-R10 — service.py 拆分 (条件决策)

**REDESIGN_PLAN 行号**: 搜索 `NEW-R10`

**范围**: `idea-core/src/idea_core/engine/service.py` 3165 LOC → 决策门禁评估。

**决策门禁**:
1. 检查 `packages/idea-engine/` (TS) 是否已有实质性实现
2. 如果 idea-engine TS 迁移已启动 → 标记 `cancelled:decision-gate`，不做 Python 拆分
3. 如果 idea-engine 仍为 scaffold → 执行拆分:
   - 重命名 `service.py` → `coordinator.py` (CODE-01.2 banned filename)
   - 拆分为 ~8 模块: `coordinator.py`, `graph.py`, `ranking.py`, `search.py`, `formalism.py`, `evaluation.py` 等
   - 各模块 ≤200 eLOC

**验收**:
- [ ] 决策门禁判定完成 (拆分 or cancelled:decision-gate)
- [ ] 如拆分: `service.py` 重命名 + 模块 ≤200 eLOC
- [ ] 如取消: REDESIGN_PLAN 标记 `cancelled:decision-gate`

---

## Item 4: NEW-VIZ-01 — Graph Visualization Layer

**REDESIGN_PLAN 行号**: 搜索 `NEW-VIZ-01`
**设计文档**: `meta/docs/graph-visualization-layer.md` (9 轮双模型审查收敛)

**范围**: 通用 graph schema + 5 domain adapters + renderers。

**实现**:
1. 创建 `packages/shared/src/graph/universal-schema.ts`:
   - `UniversalNode` / `UniversalEdge` 通用接口
   - Graph builder utilities
2. 创建 5 个 domain adapters (`packages/shared/src/graph/adapters/`):
   - `claim-adapter.ts` (Claim DAG)
   - `memory-adapter.ts` (Memory Graph)
   - `literature-adapter.ts` (Literature graph)
   - `idea-adapter.ts` (Idea map)
   - `progress-adapter.ts` (Progress graph)
3. 创建 renderers (`packages/shared/src/graph/renderers/`):
   - Graphviz DOT export
   - JSON export
   - HTML (vis.js/D3) — optional/scaffold
4. 替换 `render_claim_graph.py` 中的直接 Graphviz 调用为 adapter

**验收**:
- [ ] UniversalNode/UniversalEdge schema 支持任意 domain metadata
- [ ] 5 个 adapter 各自产出 universal graph 并可渲染为 DOT/SVG
- [ ] DOT renderer 通过测试

---

## 验收命令

```bash
# TS 构建
pnpm -r build

# 测试
pnpm -r test                        # TS tests
python -m pytest packages/hep-autoresearch/tests/ -q  # Python tests (regression)

# research-team smoke test
bash skills/research-team/scripts/bin/run_team_cycle.sh --help  # 验证新参数
```

---

## 双模型审核

收敛后执行 review-swarm (Codex + Gemini):

```bash
python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir /tmp/phase2-batch6-r1-review \
  --system <system_prompt.md> \
  --prompt <review_packet.md> \
  --fallback-mode auto
```

### 审核规则
- 0 BLOCKING from ALL models = CONVERGED → commit + push
- Any BLOCKING → fix → R+1 (full packet)
- 必须处理所有模型的所有 BLOCKING findings（不能只处理某个模型的）
- 最终收敛轮必须使用完整 packet
- 最多 5 轮，超过 → 人类介入
- Codex CLI 可能需要 10-15 分钟 — 不要提前截断
- 审核 packet 中不要复制源代码 — 使用文件路径引用，reviewer 可直接读文件
- `--fallback-mode auto` 必须显式传递（argparse 默认值 `"off"` 会覆盖 config）

---

## 收敛后操作

1. Commit: `feat: Phase 2 Batch 6 — research-team runner + clean-room + viz layer + service.py decision (RT-03 + RT-02 + NEW-R10 + NEW-VIZ-01)`
2. Push to main
3. 更新 REDESIGN_PLAN:
   - 各 item header 添加 `✅ Phase 2 Batch 6`
   - Phase 2 映射行更新 done count: 32/43
   - 总计行更新: done count += 4
4. 更新 auto memory (`memory/MEMORY.md`): Phase 2 progress, Batch 6 learnings
5. **生成下一批 prompt**: 按 `memory/batch-workflow.md` 自续协议，生成 `meta/docs/prompt-phase2-impl-batch7.md`

---

## 自续 Prompt 生成指令

After convergence + commit + push, MUST:

1. Read REDESIGN_PLAN to identify next unblocked items (Phase 2 pending after Batch 6)
2. Group into coherent batch (~500-800 LOC, 4-6 items)
3. Write `meta/docs/prompt-phase2-impl-batch7.md` with full context
4. New prompt MUST also contain this self-continuation instruction (recursive)
5. Recommended Batch 7 candidates (based on Batch 6 completion):
   - NEW-R15-impl (编排器 MCP 工具实现) — critical path, blocks NEW-RT-01/NEW-COMP-01/NEW-RT-04
   - NEW-R14 (hep-mcp 包拆分) — deep refactor
   - UX-07 (审批上下文丰富化) — if UX-01 available
   - NEW-RT-01 (TS AgentRunner) — if NEW-R15-impl done
