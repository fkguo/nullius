# Autoresearch Ecosystem — Agent Context

> 本文件是公开仓库中的根级 agent 规则 SSOT。更细的 maintainer 运营手册、tracker、review packet、执行 prompt 与并行排期材料仅保留在本地，不作为 GitHub 公开面的一部分。

## Read Order

1. 先读根级 `AGENTS.md`
2. 再读根级 `CLAUDE.md` shim
3. 再按需要阅读对应 package 的 `README.md`、`docs/*`、源码与测试

## Stable Public Invariants

- `autoresearch` 是 generic front door 与长期 control plane；HEP 是当前最成熟的 domain pack，不是根产品身份。
- 不考虑向后兼容负担。项目尚未正式发布，默认允许直接 breaking change；不要为了旧 shell、旧 schema、旧数据或旧 prompt 保留 fallback、shim、compatibility backend。
- `packages/hep-autoresearch` / `hepar` 是持续收缩中的 legacy Python provider surface，不得重新获得 generic authority。
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
- GitNexus generated appendix 可以进入 `AGENTS.md` / `CLAUDE.md` 提交面，但它只是工具生成的导航上下文，不是治理 SSOT。

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
- 若改动触及 public CLI/help/docs truth，默认还要检查：
  - `packages/hep-autoresearch/tests/test_public_cli_surface.py`
  - `packages/orchestrator/tests/autoresearch-cli.test.ts`
  - `packages/hep-mcp/tests/docs/docToolDrift.test.ts`

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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **autoresearch-lab** (11758 symbols, 26933 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/autoresearch-lab/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/autoresearch-lab/context` | Codebase overview, check index freshness |
| `gitnexus://repo/autoresearch-lab/clusters` | All functional areas |
| `gitnexus://repo/autoresearch-lab/processes` | All execution flows |
| `gitnexus://repo/autoresearch-lab/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
