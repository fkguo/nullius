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

以 `AGENTS.md` 中的组件清单为当前 monorepo 路径映射；历史 prompt 中出现的旧路径或旧 repo 名，均以当前工作区实际路径为准。

## 跨 Session 知识保留

以 `AGENTS.md` 中的治理规则和 `.serena/memories/architecture-decisions.md` 为准；不要在根 `CLAUDE.md` 中维护第二套记忆协议。

## 多模型收敛检查

以 `AGENTS.md` 的双模型审核流程和 `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md` 为准。

## GitNexus

以 `AGENTS.md` 中的 GitNexus 使用规则为准。若本文件包含自动更新的 GitNexus marker / stats，应将其视为可提交的 generated appendix：它提供辅助导航上下文，但不改变 `AGENTS.md` 作为根级治理 SSOT 的地位。

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **autoresearch-lab-rt07** (10390 symbols, 22980 relationships, 300 execution flows).

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
