# Autoresearch Ecosystem — Agent Context

> 本文件是公开仓库中的根级 agent 规则 SSOT。更细的 maintainer 运营手册、tracker、review packet、执行 prompt 与并行排期材料仅保留在本地，不作为 GitHub 公开面的一部分。

## Read Order

1. 先读根级 `AGENTS.md`
2. 再读根级 `CLAUDE.md` shim
3. 再按需要阅读对应 package 的 `README.md`、`docs/*`、源码与测试

## Stable Public Invariants

- `autoresearch` 是 generic front door 与长期 control plane；HEP 是当前最成熟的 domain pack，不是根产品身份。
- 不考虑向后兼容负担。项目尚未正式发布，默认允许直接 breaking change；不要为了旧 shell、旧 schema、旧数据或旧 prompt 保留 fallback、shim、compatibility backend。
- 已退役的 provider-local Python parser/package 不得重新获得 generic authority。
- 真实研究项目必须使用开发仓外部的绝对 `project root`；开发仓本身不是 real-project authority。
- 真实研究运行产物不得回流开发仓；repo 内 gitignored 工作区只能作为显式 maintainer fixture，不得伪装成 public 默认路径。
- Core 必须保持 domain-neutral。HEP 特定 prompts、heuristics、workflow 偏好、taxonomy、tool mapping 必须下沉到 domain/provider 层。
- 计算与验证能力按 task/capability-first 建模，不要把某个历史 backend、包名或工具链硬编码成唯一 authority。
- 禁止引入依赖历史上下文才能理解的长期命名，例如 `v2`、`new_*`、`legacy_*`、`W1/W2/...`。新抽象直接表达语义。
- 若获得人类授权执行 `git commit`，提交信息不要添加 AI co-author 标记。

## Public Repo Boundaries

- 公开仓只保留用户可消费的 front-door truth、稳定 contract、源码、测试和必要架构说明。
- maintainer-only 的 redesign plan、remediation tracker、implementation prompts、formal review packets、lane queue、local workflow notes，不应作为公开仓 surface。
- 当前公开根级文档以 `README.md`、`docs/README_zh.md`、`docs/QUICKSTART.md`、`docs/TESTING_GUIDE.md`、`docs/PROJECT_STATUS.md`、`docs/ARCHITECTURE.md`、`docs/URI_REGISTRY.md`、`meta/ECOSYSTEM_DEV_CONTRACT.md` 为主。
- `.serena/memories/architecture-decisions.md` 是仓库内允许跟踪的长期架构结论；其余 Serena memory 默认视为本地临时笔记。
- `CLAUDE.md` 在公开仓中保留为本文件 governance 段的镜像，给只识别 `CLAUDE.md` 的旧 prompt / Claude 工具用；对 `AGENTS.md` governance 段的任何编辑必须同步到 `CLAUDE.md`，反向亦然；两边出现分歧时以 `AGENTS.md` 为准。

## Working Norms

- 若本轮使用 Serena MCP，先在当前 worktree `activate_project`，随后 `check_onboarding_performed`；未激活前不要把 Serena 输出当 authority。
- 新开 lane 或进入已有 lane 时，先确认当前 `cwd`、worktree 与分支符合该 lane 指定目标；若不一致，先切换到正确 worktree/branch，再开始阅读、测试或编辑。
- 架构、LLM 能力、retrieval/reranking/evidence 策略或“某功能是否仍值得保留”的判断，应优先基于最新论文、benchmark、最佳实践和竞品实现，而不是旧记忆。
- 若需要参考外部 agent/assistant 的真实实现，可审查相邻本地仓，如 `../codex`、`../claude-code-sourcemap`，但只吸收与当前架构判断直接相关的源码级结论。
- 不要给非最佳建议。若存在多个可行动路径，默认只推荐当前阶段最收敛、最小风险、最符合既定约束的一条主路径；其余方案仅在最佳路径被证据阻塞、或用户明确要求比较时，才作为降级备选简短说明。
- 如果给出多于一个选项，必须同时分析各选项的适用条件、主要优点、主要缺点，以及为什么它不是当前最佳建议；不要把多个解释不充分的选项并列为等价路线。
- 对 public/front-door surface 的改动，必须同步检查根 README、中文 README、Quickstart、Testing Guide、Architecture、Project Status、URI registry、相关 package README，以及对应 drift/CLI tests。
- review 必须 source-grounded。可以使用多模型/多 reviewer，但 verdict 必须基于真实源码、调用链与验收证据，而不是 packet 摘要或 diff-only 判断。

## Minimum Acceptance Expectations

- 任何会影响 public/front-door truth、package authority 或 shared contracts 的改动，至少应补齐对应测试与 anti-drift 锁。
- 常用验收包括：
  - `git diff --check`
  - `node scripts/check-shell-boundary-anti-drift.mjs`
  - 受影响包的 targeted `pytest` / `vitest`
  - `pnpm -r build`
  - 若改动触及 `meta/schemas/`，必须运行 `pnpm codegen:check` 验证 `packages/shared/src/generated/` 与 `meta/generated/` 没有 drift；该检查需要本地已通过 `python3 -m pip install -r meta/scripts/codegen-requirements.txt` 安装 pinned `datamodel-code-generator` 与 `ruff`，加上 `pnpm install` 完成的 TS 依赖；CI 由 `.github/workflows/ci.yml` 装同一个 requirements 文件确保版本一致，否则不同 datamodel-codegen 版本会对同一 schema 产生 drift 的 Python
  - 若改动触及 `AGENTS.md` 或 `CLAUDE.md` 的 governance 段，必须运行 `pnpm check:governance-sync`（或 `node scripts/check-governance-sync.mjs`）确认两文件 governance 区段仍 byte-for-byte 一致
- 若改动触及 public CLI/help/docs truth，默认还要检查：
  - `packages/orchestrator/tests/autoresearch-cli.test.ts`
  - `packages/hep-mcp/tests/docs/docToolDrift.test.ts`

## Developer Runtime Refresh Rules

- 每个开发阶段完成后都必须至少重新构建并验证当前 CLI 入口：`pnpm -r build`，然后运行 `autoresearch --help`。本仓当前的常见本机安装形态是 `~/.local/bin/autoresearch` 指向 `packages/orchestrator/dist/cli.js`；只要 wrapper 目标未变，重新 build 后即可生效，不需要重新安装。
- 若改动影响 CLI 源码、CLI help、status/read-model、workflow-plan、orchestrator runtime 或 public front-door 行为，closeout 还必须用一个开发仓外的临时 project root 跑 `autoresearch init` 与 `autoresearch status --json` 烟测，并确认 `.autoresearch/HARNESS` 与 `.autoresearch/bin/autoresearch` 仍可用。
- 若改动影响 `~/.local/bin/autoresearch` wrapper 目标、repo 路径、Node 路径、package `bin`、或安装说明，必须刷新本机 wrapper 并重新运行 `autoresearch --help`；不要假设旧 PATH 入口仍指向当前 checkout。
- 若改动影响 `research-harness`、`research-team`、`markdown-hygiene`、`hep-mcp` 等 agent-facing skill source 或 skill metadata，必须区分安装方式：symlink 安装通常只需 `readlink` 验证仍指向本仓源文件；copy 安装必须重新安装/复制后再验证。不要把 Codex/Claude/OpenCode/Kimi/Cursor 中的旧 skill copy 当作已更新。
- 若改动影响 project-local launcher、`.autoresearch/HARNESS`、runtime-only init、或外部项目 reconnect 语义，必须在一个已有外部项目或临时 fixture 中运行 `autoresearch init --runtime-only`，再运行 `./.autoresearch/bin/autoresearch status --json` 验证接续路径。
- 若改动影响 scaffold templates，记住已生成的外部项目不会自动更新 `AGENTS.md`、`project_index.md`、`research_plan.md` 或 `research_contract.md`；需要迁移既有项目时，必须显式说明或执行迁移/refresh 步骤，不能只依赖新模板。

## Key Checked-in Authority

- `packages/orchestrator/`: generic lifecycle、bounded computation、workflow-plan front door
- `packages/shared/`: provider-neutral contracts / types / helpers
- `packages/*-mcp/`: domain/provider MCP surfaces
- `packages/idea-*`: idea-engine / idea-side runtime surfaces
- `meta/ECOSYSTEM_DEV_CONTRACT.md`: checked-in development contract SSOT
- `.serena/memories/architecture-decisions.md`: checked-in long-lived architecture decisions

## Review Guidance

- 对 substantive implementation lane，默认分配一个 source-grounded reviewer 与一个 verifier 作为独立质量保障；docs-only、纯机械改名、或显然微小且可由本地验证充分覆盖的改动除外。主实现责任仍由当前主 agent 持有，不得把判断与整合外包给 reviewer/verifier。
- 高风险 cross-package 或不可逆 public-surface 变更，推荐使用 `Opus`、`Gemini(auto)`、`OpenCode(zhipuai-coding-plan/glm-5.1)` 做独立 formal review；若某 reviewer 失败，先做 same-model rerun，再判断是否需要 fallback。
- `Gemini(auto)` 是 reviewer seat 名称；默认模型选择器保持 `auto`，不要静默换成旧 alias。
- `OpenCode workspace` 适合做 discovery；若需要可归档 gate verdict，可在 discovery 之后补 same-model embedded-source rerun。
- formal review packet 若触及 public/package/CLI/workflow/default-entry surface，必须带 front-door surface audit，并覆盖仍在陈述该 truth 的 live docs / locks / acceptance tests。

## Local-only Maintainer Materials

- 本仓的本地 maintainer 材料可以存在于 gitignored 目录或仓外备份，但不要把它们重新纳入公开 Git 跟踪。
- 若某项工作需要更细粒度的 lane plan、formal review packet、closeout tracker 或 branch/worktree queue，请在本地维护，不要把这些材料重新当作 public product docs。
- 从 public repo 移除的开发过程文件，默认迁到 `~/.autoresearch-lab-dev/`，优先按 `trackers/`、`plans/`、`reviews/`、`prompts/`、`closeouts/`、`archives/` 分区维护。
