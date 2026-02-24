# CLAUDE.md — Autoresearch Monorepo

> 本文件为 Claude Code 提供工作区级操作约定。生态圈架构、组件清单、治理流程、模型选择等背景信息见 `AGENTS.md`。
>
> **适用范围**: 从 monorepo 根目录启动的所有 Claude Code 会话。

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

| Runner | 模型 | 推理模式 | 调用方式 |
|--------|------|---------|---------|
| Codex CLI | `gpt-5.3-codex` | xhigh（`config.toml` 默认） | `codex-cli-runner` skill |
| Gemini CLI | 默认（gemini-3-pro-preview） | — | `gemini-cli-runner` skill |
| OpenCode | 默认（MiniMax-M2.5） | — | `opencode-cli-runner` skill |

### 触发条件

以下场景**必须**执行多模型收敛检查：

- 跨组件架构变更（影响 ≥2 个组件的接口/契约）
- REDESIGN_PLAN 新增/修改 Phase 级条目
- 新 JSON Schema 定义（`meta/schemas/`）
- 不可逆操作方案（schema 破坏性变更）

单组件内部修改、bug fix、文档 typo **不需要**多模型检查。

### 执行方式

**双模型（快速路径）** — 使用 `review-swarm` skill：

```bash
python3 skills/review-swarm/scripts/bin/run_dual_task.py \
  --out-dir <output_dir> \
  --claude-system <system_prompt.md> \
  --claude-prompt <review_packet.md> \
  --gemini-prompt <gemini_prompt.txt> \
  --claude-model opus \
  --gemini-model gemini-3-pro-preview \
  --check-review-contract \
  --fallback-mode auto \
  --fallback-order codex,claude
```

### 收敛判定

- **CONVERGED**: 所有模型 0 blocking issues → 通过
- **NOT_CONVERGED**: 任一模型有 blocking issue → 修正后重新提交 (R+1)
- **最大轮次**: 5 轮。超过 5 轮未收敛 → 人类介入

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
