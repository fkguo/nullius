# CLAUDE.md — Compatibility Shim

> Canonical repository-wide agent instructions live in `AGENTS.md`.
> This root file remains only as a stable compatibility entrypoint for older prompts and Claude-oriented tooling.

## Read Order

1. Read `AGENTS.md` first — it is the only root-level SSOT.
2. Read this shim only for compatibility guidance.
3. Then read any more specific `AGENTS.md` / `CLAUDE.md` files in scope (for example `packages/hep-mcp/CLAUDE.md`).

## 全局约束

根级规则不再在本文件重复维护。若旧 prompt 要求“读取根 `CLAUDE.md`”，应解释为“先读取 `AGENTS.md`，再看本 shim”。

## 工作区路径映射

以 `AGENTS.md` 中的组件清单为当前 monorepo 路径映射；历史 prompt 中出现的旧路径或旧 repo 名，均以当前工作区实际路径为准。

## 跨 Session 知识保留

以 `AGENTS.md` 中的治理规则和 `.serena/memories/architecture-decisions.md` 为准；不要在根 `CLAUDE.md` 中维护第二套记忆协议。

## 多模型收敛检查

以 `AGENTS.md` 的双模型审核流程和 `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md` 为准。

## GitNexus

以 `AGENTS.md` 中的 GitNexus 使用规则为准。本 shim 故意不包含自动更新的 GitNexus marker / stats，以避免工作区无意义漂移。
