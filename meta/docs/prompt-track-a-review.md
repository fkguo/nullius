# Track A 研究进化双审核 + 收敛 Prompt

> **工作目录**: /home/user/Coding/Agents/Autoresearch/autoresearch-meta
> **工作分支**: `redesign/track-a`
> **主分支**: `main` @ e64423f (已合并 Track B)
> **日期**: 2026-02-22

## 背景

Track A (EVO-06/07/17/18: 诚信框架、可复现性验证、REP SDK、信号引擎) 已完成详细设计，
产出 4 个设计文档 + 9 个 JSON Schemas + 跨集成设计文档，共 ~10K 行。

全局约束: 所有组件未正式发布，无外部用户，可自由 breaking change，不需要向后兼容。

main 分支自 Track A 分支以来的变化:
- Track B (EVO-20/19/12a/21) 已合并 (9 轮双审核收敛, READY)
- UX-01~07 用户体验层已添加 (107→114 items)
- 全局约束 "无向后兼容负担" 已写入 REDESIGN_PLAN

Track A 需要完成双模型审核收敛后合并回 main。

## 开始前

```bash
cd /home/user/Coding/Agents/Autoresearch/autoresearch-meta
git checkout redesign/track-a
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890
```

## 审核范围

### 设计文档 (主审)

1. `docs/track-a-evo17-rep-sdk-design.md` (~2626 行) — REP SDK 详设
2. `docs/track-a-evo06-integrity-framework-design.md` (~2068 行) — 诚信框架详设
3. `docs/track-a-evo07-reproducibility-design.md` (~1015 行) — 可复现性验证管线
4. `docs/track-a-evo18-signal-engine-design.md` (~1943 行) — 信号引擎详设
5. `docs/track-a-cross-integration-design.md` (~625 行) — 跨项集成设计

### JSON Schemas (验证)

- `schemas/rep_envelope_v1.schema.json`
- `schemas/research_strategy_v1.schema.json`
- `schemas/research_outcome_v1.schema.json`
- `schemas/research_event_v1.schema.json`
- `schemas/research_signal_v1.schema.json`
- `schemas/integrity_report_v1.schema.json`
- `schemas/integrity_check_v1.schema.json`
- `schemas/domain_pack_manifest_v1.schema.json`
- `schemas/reproducibility_report_v1.schema.json`

### 参考文件

- `REDESIGN_PLAN.md` — Track A 对 EVO-06/07/17/18 段落的更新
- `remediation_tracker_v1.json` — 依赖关系验证
- `ECOSYSTEM_DEV_CONTRACT.md` — 合约约束

## 审核任务

使用 review-swarm skill，Agent A = Codex (gpt-5.3-codex, xhigh reasoning), Agent B = Gemini (默认模型)。

### 审核维度

**D1. 架构完整性**
- [ ] 4 个 EVO 项的设计是否完整覆盖 REDESIGN_PLAN 中的需求描述？
- [ ] 跨集成设计是否覆盖了所有项间交互？
- [ ] REP SDK 是否满足 PLUG-01 (零内部依赖)?

**D2. Schema 一致性**
- [ ] 9 个 schema 是否遵循 JSON Schema Draft 2020-12?
- [ ] schema 之间的 $ref 引用是否正确？
- [ ] schema 与设计文档中的类型定义是否一致？
- [ ] schema 与 Track B schemas (memory-graph-*.schema.json) 的共享类型是否对齐？

**D3. 可行性**
- [ ] REP SDK 的 wire protocol 复杂度是否合理？
- [ ] IntegrityCheck domain pack 加载机制是否过度工程化？
- [ ] 信号引擎从 Evolver 移植的算法是否适配 HEP 领域？
- [ ] 可复现性验证的 Mathematica/Julia 双后端是否现实？

**D4. 与 Track B 和 UX 层的兼容性**
- [ ] Track A 的 Memory Graph 节点/边类型与 Track B EVO-20 设计是否兼容？
- [ ] IntegrityReport 与 UX-07 (审批上下文丰富化) A5 gate 的交互是否清晰？
- [ ] REP 事件流与 trace-jsonl 的关系是否明确？

**D5. 遗漏与风险**
- [ ] 是否有未声明的跨 Phase 依赖？
- [ ] 全局约束 "无向后兼容" 是否被充分利用（有无不必要的兼容层）？
- [ ] 设计复杂度是否与实际需求匹配？

### 输出格式

```markdown
# Track A 审核报告 — [Reviewer: Codex/Gemini]

## 摘要
- 审核通过 / 有条件通过 / 不通过
- 关键发现: X BLOCKER, Y CONCERN, Z PASS

## 逐项评审
(D1-D5 每项 PASS/CONCERN/BLOCKER + 说明)

## 具体建议
1. [BLOCKER] ...
2. [CONCERN] ...

## 结论
READY / NOT READY
```

### 收敛流程

1. 两个 agent 独立审核
2. 比较 BLOCKER 和 CONCERN 交集
3. 修复所有 BLOCKER
4. 如有分歧，讨论并重新审核
5. 两个 agent 均 READY 后:
   - rebase `redesign/track-a` onto latest `main` (解决冲突)
   - 提交到 `redesign/track-a` 分支
   - **不要合并到 main**，在另一个对话中执行合并

## 合并说明 (收敛完成后)

Track A 的 REDESIGN_PLAN.md 基于旧版 main (v1.4.1-draft)，合并时会与 main 的 v1.5.0-draft 冲突。
解决策略: 保留 main 的 header (1.5.0-draft, 114 items)，保留 track-a 的 EVO 段落更新。
可在审核收敛后通过 rebase 提前解决，或在合并对话中解决。
