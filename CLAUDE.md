# CLAUDE.md — Autoresearch Monorepo

> 本文件为 Claude Code 提供工作区级操作约定。生态圈架构、组件清单、治理流程、模型选择等背景信息见 `AGENTS.md`。
>
> **适用范围**: 从 monorepo 根目录启动的所有 Claude Code 会话。

## 全局约束（必读）

**无向后兼容负担**：生态圈尚未正式发布，无外部用户。所有变更可直接 breaking change，**不需要**：
- 旧 API / 工具名保留或 deprecation shim
- 数据格式迁移脚本（直接采用新 schema，旧数据可丢弃重建）
- 运行时版本协商或兼容性矩阵维护
- 字段设为 optional "以兼容旧数据"——如果语义上应该 required，就直接 required
- 临时 stopgap / Python 退役路径保留缓冲期——TS 替代方案实现并通过验收后，Python 侧对应功能**立即删除**，不留缓冲期

**禁止临时性/阶段性命名**：不要引入 `vNext`、`v2`、`new_`、`legacy_`、`old_` 等暗示"当前版本以后会替换"的目录名或模块名。直接使用面向功能的永久命名（如 `core/`、`writing/`、`runs/`）。如果确实有新旧共存的过渡期，用 feature flag 或版本号区分，不要目录分叉。

来源：`meta/REDESIGN_PLAN.md` §全局约束。

## 工作区路径映射

Monorepo 结构（NEW-05 完成，2026-02-24）。

| 逻辑名 | 路径 | 语言 | 说明 |
|--------|------|------|------|
| hep-mcp | `packages/hep-mcp/` | TS | MCP server（原 hep-research-mcp，NEW-R13 重命名） |
| shared | `packages/shared/` | TS | 共享类型 + 工具 |
| pdg-mcp | `packages/pdg-mcp/` | TS | PDG 离线工具 |
| zotero-mcp | `packages/zotero-mcp/` | TS | Zotero Local API 工具 |
| hep-autoresearch | `packages/hep-autoresearch/` | Python | 编排器（渐进退役，被 orchestrator 替代） |
| idea-core | `packages/idea-core/` | Python | idea 引擎（渐进退役，被 idea-engine 替代） |
| idea-generator | `packages/idea-generator/` | JSON Schema + Python | Schema SSOT + 验证脚本 |
| skills-market | `packages/skills-market/` | Python | Skill 分发元数据 |
| orchestrator | `packages/orchestrator/` | TS | 新编排器（NEW-05a，scaffold） |
| idea-engine | `packages/idea-engine/` | TS | 新 idea 引擎（NEW-05a Stage 3，scaffold） |
| agent-arxiv | `packages/agent-arxiv/` | TS | Agent-arXiv 服务（EVO-15，scaffold） |
| meta | `meta/` | — | 项目治理、schemas、重构计划 |
| skills | `skills/` | Bash/Python/wolframscript | Skill 实现 |

npm scope: `@autoresearch/*`（原 `@hep-research/*`）。

各子包有独立 CLAUDE.md（如 `packages/hep-mcp/CLAUDE.md`），本文件不重复其内容。

## 开发命令

```bash
pnpm install          # 安装依赖
pnpm -r build         # 构建所有 TS 包
pnpm -r test          # 运行所有测试
pnpm -r lint          # Lint
make test             # TS + Python 测试
make smoke            # MCP server 冒烟测试
make codegen-check    # 校验生成代码（TODO: NEW-01）
gitnexus analyze      # 更新代码知识图谱索引（跨组件变更前建议执行）
```

## 跨 Session 知识保留（过渡性记忆协议）

> EVO-20（跨周期记忆图谱）就绪前的过渡方案。

### 写入时机

以下事件发生时，**必须**通过 `serena:write_memory` 写入项目记忆：

1. **研究方向被否定** — 记录失败原因和排除依据（未来 EVO-09 失败库的种子）
2. **计算策略有效/无效** — 记录哪类方法在哪类问题上可靠或不适用
3. **跨组件架构决策** — 非显而易见的决策及其理由
4. **依赖关系发现** — 代码库中发现的隐式耦合或意外依赖
5. **重构执行经验** — REDESIGN_PLAN 某项完成后，记录实际 vs 预期的偏差

### 写入格式

```markdown
## [YYYY-MM-DD] 类别: 简短标题

**上下文**: 哪个项目/run/分支
**发现**: 具体结论
**影响**: 对后续工作的指导意义
**关联项**: REDESIGN_PLAN 中的 item ID（如有）
```

### 命名约定

记忆文件按主题命名，不按日期：

- `research-failures.md` — 被否定的研究方向
- `computation-strategies.md` — 有效/无效的计算方法
- `architecture-decisions.md` — 跨组件设计决策
- `codebase-gotchas.md` — 代码库中的陷阱和隐式约定

### 读取时机

启动涉及以下场景的会话时，**应该**先 `serena:read_memory` 检查相关记忆：

- 开始新的研究方向（检查 `research-failures.md`）
- 选择计算策略（检查 `computation-strategies.md`）
- 执行跨组件变更（检查 `architecture-decisions.md`）

## 多模型收敛检查（开发实施期间）

关键设计或实现产出在提交前，**必须**通过多模型独立检查并迭代至收敛。使用 `review-swarm` skill 及各 CLI runner。

### 模型配置

**按审核场景分工**：

| 场景 | Codex 模型 | 推理模式 | 理由 |
|------|-----------|---------|------|
| **架构/方案审核** (REDESIGN_PLAN 修订、Phase 级条目变更) | `gpt-5.2` | xhigh | 保守性好、不建议不必要的 breaking rewrite；R1-R4 流程已验证 |
| **代码实现审核** (schema 实现、工具代码、测试) | `gpt-5.3-codex` | xhigh | Terminal-Bench 77.3%（大幅提升）；代码生成和执行场景的首选 |

> `review-swarm.json` 中的 `models` 字段配置的是代码审核模型 (`gpt-5.3-codex`)。方案审核需手动传 `--model gpt-5.2` 覆盖。

| Runner | 默认模型 | 推理模式 | 调用方式 |
|--------|---------|---------|---------|
| Codex CLI | `gpt-5.3-codex`（代码）/ `gpt-5.2`（方案） | xhigh（`config.toml` 默认） | `codex-cli-runner` skill |
| Gemini CLI | 默认（gemini-3.1-pro-preview） | — | `gemini-cli-runner` skill |
| OpenCode | 默认（MiniMax-M2.5） | — | `opencode-cli-runner` skill |

### 触发条件

以下场景**必须**执行多模型收敛检查：

- 跨组件架构变更（影响 ≥2 个组件的接口/契约）
- REDESIGN_PLAN 新增/修改 Phase 级条目
- 新 JSON Schema 定义（`meta/schemas/`）
- 不可逆操作方案（schema 破坏性变更）

单组件内部修改、bug fix、文档 typo **不需要**多模型检查。

### Review 产物存放约定

所有 review 过程文件（system prompt、review packet、swarm 输出目录）**不放入仓库**，存放在：

```
~/.autoresearch-lab-dev/batch-reviews/
```

格式建议：`batch{N}-review-system.md`、`batch{N}-review-r{M}.md`、`phase2-batch{N}-r{M}-review/`（swarm 输出目录）。`meta/docs/` 只存放设计文档，不存放 review 产物。实施 prompt 存放在 `meta/docs/prompts/`（命名：`prompt-phase{N}-impl-batch{M}.md`）。

### 执行方式

**双模型（快速路径）** — 使用 `review-swarm` skill：

```bash
python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir ~/.autoresearch-lab-dev/batch-reviews/phase2-batch{N}-r{M}-review \
  --system ~/.autoresearch-lab-dev/batch-reviews/batch{N}-review-system.md \
  --prompt ~/.autoresearch-lab-dev/batch-reviews/batch{N}-review-r{M}.md
```

`models`、`fallback_mode` 等参数从 `meta/review-swarm.json` 自动加载。

### 收敛判定

- **CONVERGED**: 所有模型 0 blocking issues → 通过
- **NOT_CONVERGED**: 任一模型有 blocking issue → 修正后重新提交 (R+1)
- **最大轮次**: 5 轮。超过 5 轮未收敛 → 人类介入
- **最终轮必须使用完整 packet**: 中间轮次可用 delta packet 加速迭代，但宣布收敛的那一轮（所有模型 0 BLOCKING 的那一轮）必须使用包含完整实现的 review packet，不能用 delta packet 收敛

### Rn 修复范围（硬性规则）

**每一轮必须处理所有模型的所有 BLOCKING findings**，不能只处理某一个模型的 findings。

- 收到 Rn 结果后，**先汇总所有模型的所有 BLOCKING**，再统一修复
- 不能只看 Gemini 的 findings 而忽略 Codex 的，或反之
- 如果两个模型发现了不同的 BLOCKING issues，R(n+1) 必须同时修复全部

> **教训**: Batch 3 R1 中 Codex 发现了死锁 BLOCKING，Gemini 发现了 TOCTOU BLOCKING，协调者只修复了 Gemini 的，完全忽略了 Codex 的死锁。导致死锁问题拖到后续单独补审才发现。

### 完整性要求（硬性规则）

**每个模型必须至少完成一次对完整实现的审核**，才能计入收敛判定。

- 如果某个模型在 R1（完整 packet）超时或返回无效输出，后续 Rn 只审核了 delta fix packet，**不能**仅凭 delta 审核 PASS 就声称该模型已通过
- 必须为该模型重新提交包含**完整源码**的 review packet（所有新文件 + 所有修改文件的关键变更段落），直到其返回有效的 PASS 判定
- 只有所有模型都对完整实现返回 0 BLOCKING 后，才能标记为 CONVERGED
- Codex CLI 审核可能需要 10-15 分钟，**绝对不要提前截断**——耐心等待完成

## 网络访问

默认代理配置（当 WebFetch 失败时使用 curl）：

```bash
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
export all_proxy=socks5://127.0.0.1:7890
```

## 子包 CLAUDE.md 索引

| 路径 | 关键约束摘要 |
|------|-------------|
| `packages/hep-mcp/CLAUDE.md` | Evidence-first I/O, Zod SSOT, stdio-only, 质量优先于成本 |
| `packages/hep-autoresearch/CLAUDE.md` | (待建立) |
| `meta/CLAUDE.md` | (待建立) |

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **autoresearch-lab** (12833 symbols, 27202 relationships, 300 execution flows).

GitNexus provides a knowledge graph over this codebase — call chains, blast radius, execution flows, and semantic search.

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring, you must:

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/refactoring/SKILL.md` |

## Tools Reference

| Tool | What it gives you |
|------|-------------------|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — categorized refs, processes it participates in |
| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `rename` | Multi-file coordinated rename with confidence-tagged edits |
| `cypher` | Raw graph queries (read `gitnexus://repo/{name}/schema` first) |
| `list_repos` | Discover indexed repos |

## Resources Reference

Lightweight reads (~100-500 tokens) for navigation:

| Resource | Content |
|----------|---------|
| `gitnexus://repo/{name}/context` | Stats, staleness check |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Area members |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{processName}` | Step-by-step trace |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher |

## Graph Schema

**Nodes:** File, Function, Class, Interface, Method, Community, Process
**Edges (via CodeRelation.type):** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```

<!-- gitnexus:end -->
