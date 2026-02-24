# Prompt: Phase 0 重构启动 — Monorepo 迁移 + 止血项

> 本 prompt 用于新开 Claude Code 对话，启动 REDESIGN_PLAN.md Phase 0 的实施。
> 工作目录: `/home/user/Coding/Agents/Autoresearch/`

---

## 总体目标

执行 `autoresearch-meta/REDESIGN_PLAN.md` 中 Phase 0（止血）的 13 项重构。
**关键路径**: NEW-05 (Monorepo 迁移) → NEW-05a (TS 迁移) → 其余 Phase 0 项并行。

## 第一步: 读取计划

1. 读取 `autoresearch-meta/REDESIGN_PLAN.md` 全文，理解 Phase 0 所有条目
2. 读取 `autoresearch-meta/remediation_tracker_v1.json`，确认当前状态
3. 检查 serena memory: `architecture-decisions`（如可用）
4. 读取本目录下各子 repo 的 CLAUDE.md（如存在）

## 第二步: 执行策略

### NEW-05 Monorepo 迁移（最先执行）

**输入**: 当前多 repo 结构（7 个组件分散在独立目录）
**输出**: 统一 monorepo，结构见 REDESIGN_PLAN §NEW-05

执行步骤:
1. 创建新目录 `autoresearch/`（或在 GitHub 创建新 private repo）
2. `git subtree add` 各组件，保留 commit history
3. 创建 `pnpm-workspace.yaml` 管理 TS packages
4. 创建顶层 `Makefile`（codegen, lint, test, smoke）
5. 创建 `.github/workflows/ci.yml`
6. 验收: 所有组件测试套件通过 + `make codegen-check` 可用

**⚠️ 这是不可逆的结构变更，执行前必须经双模型审核确认迁移方案。**

### 其余 Phase 0 项（NEW-05 完成后并行执行）

按 tracker 中 depends_on 拓扑排序:
- C-01, C-02, C-03, C-04: 安全/治理项（无依赖，可并行）
- H-08, H-14a, H-20: 小修复（无依赖，可并行）
- NEW-R02a, NEW-R03a: CI/审计项（无依赖，可并行）
- NEW-R13: 包重命名（依赖 NEW-05，与迁移同步）
- NEW-R15-spec: 编排器规格（无依赖，可独立）

## 第三步: 双模型审核门禁

### 何时触发

以下场景**必须**经 Codex + Gemini 双模型审核迭代收敛:
- NEW-05 monorepo 目录结构方案（不可逆）
- 新 JSON Schema 定义（`meta/schemas/`）
- 跨组件接口/契约变更
- CI 配置（`.github/workflows/`）

单组件内部修改、bug fix、文档修正**不需要**。

### 执行方式

使用 `review-swarm` skill 的 `run_multi_task.py`:

```bash
OUT_DIR=autoresearch-meta/.review/phase0-<item_id>-r<round>

python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir "$OUT_DIR" \
  --system "$OUT_DIR/reviewer_system.md" \
  --prompt "$OUT_DIR/packet.md" \
  --models claude/opus,gemini/default \
  --backend-prompt gemini="$OUT_DIR/gemini_prompt.txt" \
  --backend-system gemini=none \
  --backend-output claude=claude_output.md \
  --backend-output gemini=gemini_output.md \
  --check-review-contract \
  --fallback-mode auto \
  --fallback-order codex,claude
```

三模型路径（关键决策时）追加 Codex:
```bash
# 在上面基础上改 --models:
  --models claude/opus,gemini/default,codex/default \
  --backend-prompt codex="$OUT_DIR/codex_prompt.txt" \
  --backend-system codex=none \
  --backend-output codex=codex_output.md
```

### 收敛标准

- **CONVERGED**: 所有模型 VERDICT: READY，0 blocking issues → 通过
- **NOT_CONVERGED**: 任一模型 NOT_READY + blocking → 修正后 R+1
- **最大轮次**: 5 轮。超过 → 暂停，报告给人类

## 可用 Skills

开发过程中应主动使用以下 superpowers skills:

| Skill | 何时使用 |
|-------|---------|
| `brainstorming` | 开始任何新功能/组件设计前 |
| `writing-plans` | 有 spec 需要分解为多步骤实施时 |
| `executing-plans` | 已有计划，需要逐步执行时 |
| `subagent-driven-development` | 有多个独立任务可并行时 |
| `dispatching-parallel-agents` | 同上，更侧重 agent 调度 |
| `test-driven-development` | 实现任何功能/修复前 |
| `systematic-debugging` | 遇到 bug 或测试失败时 |
| `verification-before-completion` | 声称完成前，必须验证 |
| `using-git-worktrees` | 需要隔离工作区时 |
| `review-swarm` | 双模型审核时 |

## 并行独立任务（已在其他会话中进行）

以下两项与 Phase 0 并行，不在本会话范围内:
1. **自建 Memory 系统** — 替换 Serena 依赖（`autoresearch-meta/`）
2. **idea-core outcome 追踪** — JSONL 写入/读取（`idea-core/`）

如果本会话涉及这两项的集成点，注意它们的接口约定:
- Memory: `<project>/.memories/*.jsonl` + `index.json`
- Outcomes: `~/.autoresearch/idea_outcomes.jsonl`

## Tracker 更新

每完成一个 Phase 0 条目:
1. 在 `remediation_tracker_v1.json` 中将该条目 status 改为 `"done"`
2. 如果发现新问题，新增条目并设置正确的 depends_on
3. 完成所有 Phase 0 项后，递增 plan_version

## 不做的事

- 不修改 Phase 1+ 的任何条目
- 不实现 Agent 化功能（RT-05 等）
- 不做代码风格/文档美化
- 不在 Phase 0 范围外引入新依赖
