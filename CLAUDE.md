# CLAUDE.md — Compatibility Shim

> Canonical repository-wide human-authored agent instructions live in `AGENTS.md`.
> This root file remains the stable compatibility entrypoint for older prompts and Claude-oriented tooling, and may also carry a GitNexus-generated appendix.

## Read Order

1. Read `AGENTS.md` first — it is the only root-level SSOT.
2. Read this shim only for compatibility guidance.
3. Then read any more specific `AGENTS.md` / `CLAUDE.md` files in scope (for example `packages/hep-mcp/CLAUDE.md`).

## 全局约束

根级人类编写规则不在本文件重复维护。若旧 prompt 要求“读取根 `CLAUDE.md`”，应解释为“先读取 `AGENTS.md`，再看本 shim；若存在 GitNexus generated appendix，则将其视为辅助上下文而非第二套根级规则”。

## 工作区路径映射

以当前工作区实际路径、`packages/` 目录结构和 `AGENTS.md` 的根级入口规则为准；不要依赖旧 repo 名、拆仓时期目录名或过时组件表。

## 跨 Session 知识保留

以 `AGENTS.md` 中的治理规则和 `.serena/memories/architecture-decisions.md` 为准；不要在根 `CLAUDE.md` 中维护第二套记忆协议。

## 多模型收敛检查

以 `AGENTS.md` 的正式三模型审核流程和 `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md` 为准。

## GitNexus

以 `AGENTS.md` 中的 GitNexus 使用规则为准。若本文件包含自动更新的 GitNexus marker / stats，应将其视为可提交的 generated appendix：它提供辅助导航上下文，但不改变 `AGENTS.md` 作为根级治理 SSOT 的地位。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **autoresearch-lab-new-sem05-rereview** (8486 symbols, 22877 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
3. `READ gitnexus://repo/autoresearch-lab-new-sem05-rereview/process/{processName}` — trace the full execution flow step by step
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
| `gitnexus://repo/autoresearch-lab-new-sem05-rereview/context` | Codebase overview, check index freshness |
| `gitnexus://repo/autoresearch-lab-new-sem05-rereview/clusters` | All functional areas |
| `gitnexus://repo/autoresearch-lab-new-sem05-rereview/processes` | All execution flows |
| `gitnexus://repo/autoresearch-lab-new-sem05-rereview/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## CLI

- Re-index: `npx gitnexus analyze`
- Check freshness: `npx gitnexus status`
- Generate docs: `npx gitnexus wiki`

<!-- gitnexus:end -->
