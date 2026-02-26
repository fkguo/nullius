# Batch 5 — Phase 1 Sweep + Phase 2B Early (M-01 + M-18 + NEW-R04 + NEW-CONN-02)

## 前置状态

- Phase 0: ALL DONE (14/14)
- Phase 1 Batch 1: NEW-01 ✅, H-11a ✅, H-16a ✅
- Phase 1 Batch 2: H-15a ✅, H-18 ✅, H-03 ✅, H-04 ✅, H-11a P2 ✅
- Phase 1 Batch 3: H-01 ✅, H-02 ✅, H-19 ✅, NEW-CONN-01 ✅
- Phase 1 Batch 4: H-13 ✅, M-14a ✅, NEW-R02 ✅, UX-06 ✅, NEW-RT-02 ✅, NEW-RT-03 ✅
- REDESIGN_PLAN: v1.8.0-draft (commit b708e95)
- Phase 1 完成: 15/22
- Phase 2A 完成: 2/3 (NEW-RT-02 ✅, NEW-RT-03 ✅; NEW-RT-01 blocked on NEW-R15-impl)

## 本批目标

Phase 1 收尾（快速可独立项）+ Phase 2B 小型连通项。完成后 Phase 1 达 18/22。

剩余 Phase 1 未做项决策：
- **M-19**: BLOCKED on H-17 (Phase 2), 跳过
- **NEW-R03b**: Python 退役路径，281 个 exception handler 规范化 ROI 低，跳过
- **UX-01 + UX-05**: 主要修改 Python 编排器 + research-team 模板，不阻塞 Phase 2 任何项，推迟到需要时再做

---

## Batch 5A: Phase 1 Items

### 1. M-01: Artifact 命名规范 (~80 LOC)

参考 `meta/REDESIGN_PLAN.md` M-01 节。依赖: 无。

**注意**: REDESIGN_PLAN 中的文件路径 (`autoresearch-meta/`, `hep-research-mcp/`) 是 monorepo 迁移前的旧路径。实际路径映射：
- `autoresearch-meta/` → `meta/`
- `hep-research-mcp/` → `packages/hep-mcp/`

**实现**:

- `meta/scripts/lint_artifact_names.py` (新文件): Python 脚本扫描 `packages/hep-mcp/src/` 中所有硬编码 artifact 文件名（字符串字面量匹配 `writeRunJsonArtifact`, `writeRunArtifact` 调用的第二参数），验证符合正则：`^[a-z]+_[a-z_]+(_\d{3})?_v\d+\.(json|tex|jsonl|md)$`
  - `.md` 豁免: `packet_short.md` / `packet.md` (GATE-05 人类审批产物)
  - 输出: 违规列表 + exit code
- `Makefile`: `code-health-check` target 追加 `lint_artifact_names.py`
- **实际 artifact 名称修正**: 扫描 `packages/hep-mcp/src/` 中所有 `writeRunJsonArtifact` / `writeRunArtifact` 调用，将不符合命名规范的 artifact 名称重命名为规范格式。**只修改名称字符串**，不改变逻辑。对应的测试 fixture 如有引用也须同步更新。

**验收**:
- `python3 meta/scripts/lint_artifact_names.py` exit 0
- 全部测试通过

### 2. M-18: 配置管理统一 (~60 LOC)

参考 `meta/REDESIGN_PLAN.md` M-18 节。依赖: H-20 ✅。

同样注意旧路径映射。

**实现**:

- `meta/docs/ecosystem_config_v1.md` (新文件): 配置键注册表文档
  - 列出所有环境变量键: `HEP_DATA_DIR`, `HEP_INSPIRE_API_URL`, `HEP_LOG_LEVEL`, `ZOTERO_LOCAL_URL`, `PDG_DB_PATH`, `HEP_MCP_EXPOSURE_MODE` 等
  - 每个键记录: 名称、类型、默认值、优先级来源链 (env > .env > config file > hardcoded default)、哪些组件读取
  - 格式: Markdown 表格

- `packages/hep-mcp/src/config.ts` (可能已存在或需新建): 导出一个 `logConfigSummary()` 函数，在 MCP server 启动时调用，输出当前生效配置的摘要到 stderr (不影响 stdio transport)。格式示例:
  ```
  [config] HEP_DATA_DIR=/Users/xxx/.hep (env)
  [config] HEP_INSPIRE_API_URL=https://inspirehep.net/api (default)
  [config] HEP_MCP_EXPOSURE_MODE=standard (default)
  ```

**验收**:
- `meta/docs/ecosystem_config_v1.md` 存在且列出所有已知配置键
- MCP server 启动时 stderr 输出 config summary

### 3. NEW-R04: Zotero 工具整合 (~2300 LOC 去重)

参考 `meta/REDESIGN_PLAN.md` NEW-R04 节。依赖: 无。

**现状审计（实施前必须先做）**:
1. 读 `packages/zotero-mcp/src/zotero/tools.ts` — canonical Zotero tool 实现
2. 读 `packages/hep-mcp/src/vnext/zotero/tools.ts` — vnext 层的重复实现
3. 对比两者的函数签名、辅助函数、差异点
4. 确认 `packages/hep-mcp/src/tools/registry.ts` 中 Zotero 工具的注册方式

**策略**:
- `packages/zotero-mcp/` 是 canonical provider
- `packages/hep-mcp/` 的 vnext/zotero/ 改为 thin adapter，import from `@autoresearch/zotero-mcp`
- 如果 hep-mcp 中有 zotero-mcp 没有的增强逻辑（如 evidence catalog 集成），保留在 adapter 层
- 去重目标: ≥2000 LOC

**验收**:
- `packages/hep-mcp/src/vnext/zotero/tools.ts` 不包含独立业务逻辑实现
- `pnpm -r test` 全部通过，Zotero 工具功能无回归
- `wc -l` 确认去重 ≥2000 LOC

---

## Batch 5B: Phase 2B Early

### 4. NEW-CONN-02: Review Feedback next_actions (~60 LOC)

参考 `meta/REDESIGN_PLAN.md` NEW-CONN-02 节。依赖: 无。

**实现**:

- `packages/hep-mcp/src/tools/registry.ts`: `hep_run_writing_submit_review` handler
  - 当 `result.follow_up_evidence_queries.length > 0` 时，添加 `next_actions`:
    - 每条 query → `{ tool: 'inspire_search', args: { query: <query>, size: 10 }, reason: <query> }`
    - 追加 `{ tool: 'hep_run_build_writing_evidence', args: { run_id }, reason: 'Rebuild evidence after follow-up search' }`
    - Cap: max 5 queries, 每条 reason max 200 chars
  - 当 `result.recommended_resume_from` 存在时:
    - 添加对应的 writing 工具 next_action (映射表: section_write → `hep_run_writing_create_section_write_packet_v1`, outline → `hep_run_writing_create_outline_candidates_packet_v1`, 等)
  - Hint-only: 只添加到 result，不改变执行流

- 测试: 新建 `packages/hep-mcp/tests/reviewNextActions.test.ts`
  - 有 follow_up queries → next_actions 非空
  - 无 follow_up queries → 无 next_actions
  - 有 recommended_resume_from → 对应工具建议
  - next_actions 遵循 `{ tool, args, reason }` 惯例

**验收**:
- 新增 ≥4 个测试
- `pnpm -r test` 全部通过

---

## 执行约束

1. 先读 Serena 记忆 `architecture-decisions` + `codebase-gotchas` 获取上下文
2. 按此顺序: M-01 → M-18 → NEW-R04 → NEW-CONN-02
3. 每项完成后跑对应测试；全部完成后 `pnpm -r build && pnpm -r test` 确认零回归
4. 全部完成后执行双模型收敛检查:
   - Codex: gpt-5.3-codex xhigh (代码审核)
   - Gemini: gemini-3.1-pro-preview
   - 使用 `review-swarm` skill
5. 收敛后提交 (单次 commit) + push
6. 更新 tracker (`meta/remediation_tracker_v1.json` + `meta/REDESIGN_PLAN.md` summary 行)
7. 更新 Serena 记忆 `architecture-decisions.md`

## Batch 5 后 Phase 1 状态

完成后: 18/22 done

| 剩余 | 状态 | 原因 |
|------|------|------|
| M-19 | BLOCKED | 依赖 H-17 (Phase 2B) |
| NEW-R03b | DEFERRED | Python 退役路径, ROI 低 |
| UX-01 | DEFERRED | 主要改 Python 编排器, 不阻塞 Phase 2 |
| UX-05 | BLOCKED | 依赖 UX-01 |

Phase 1 可视为 **实质完成** (remaining items are blocked/deferred/retirement-path)，进入 Phase 2B 阶段。
