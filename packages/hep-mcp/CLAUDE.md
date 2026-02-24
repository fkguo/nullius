# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 等 coding agents 提供本项目的开发指南。  
面向用户的功能/用法以 `README.md` 与 `docs/README_zh.md` 为准；本文件只写 **不易漂移** 的工程约束与代码入口。

## Hard Constraints（必须遵守）

- **Quality-first principle**：学术写作质量优先于成本/延迟。默认启用质量增强功能（如 LLM rerank）；不要为节省微小成本而牺牲引用准确性或检索质量。
- **Local MCP transport only**：只保留 stdio（`StdioServerTransport`）；不实现/不引入 HTTP transport/server。
- **Zotero Local API only**：仅 `http://127.0.0.1:23119`；不做 Zotero Web API。
- **Evidence-first I/O**：大对象写入 **artifacts + MCP Resources**；tool result 仅返回 **URI + 小摘要**。
- 不要在可 push 的代码分支中提交开发过程文档（见"文档与分支卫生"）。

## 开发/验收命令（repo root）

```bash
pnpm install
pnpm -r build   # 或 pnpm build
pnpm -r test    # 或 pnpm test
pnpm -r lint    # 或 pnpm lint
```

## 代码结构（以当前仓库为准）

> **详细架构文档**：`docs/ARCHITECTURE.md`（包含数据流、Token 管理、扩展点等）

- `packages/hep-mcp/`：主 MCP server（聚合 `hep_*` / `inspire_*` / `zotero_*` / `pdg_*`）
  - 入口：`packages/hep-mcp/src/index.ts`
  - 工具注册表（单点 SSOT）：`packages/hep-mcp/src/tools/registry.ts`
  - 调度/参数校验：`packages/hep-mcp/src/tools/dispatcher.ts`
  - Zod → MCP `inputSchema`：`packages/hep-mcp/src/tools/mcpSchema.ts`
  - vNext 本地工作流：`packages/hep-mcp/src/vnext/**`（Project/Run、artifacts、`hep://` resources）
- `packages/zotero-mcp/`：Zotero Local API tools（也会被聚合进 hep-research-mcp）
- `packages/pdg-mcp/`：离线 PDG sqlite tools/resources（也会被聚合进 hep-research-mcp）
- `packages/shared/`：共享 types/errors/utils（如 `invalidParams()` / `notFound()`）

## 工具面约定（Zod 作为 SSOT）

- 工具参数以 **Zod schema** 为单一事实来源（SSOT）；MCP `inputSchema` 由 `zodToMcpInputSchema()` 生成，避免手写 JSON schema 漂移。
- 工具必须经由注册表注册（`ToolSpec { name, zodSchema, handler, exposure }`），每个暴露 tool 必须有 handler。
- handlers 的唯一入参校验入口是 `schema.parse(args)`（当前由 dispatcher 统一处理）。
- 修改工具表面后运行 contract tests：`packages/hep-mcp/tests/toolContracts.test.ts`。

## 网络请求与速率限制

- INSPIRE/arXiv 请求必须使用封装：`packages/hep-mcp/src/api/rateLimiter.ts`（`inspireFetch()` / `arxivFetch()`），避免绕开重试/限速逻辑去直接对外 `fetch()`。

## Evidence-first 与 `hep://` resources

- vNext 大输出写入 run artifacts（`packages/hep-mcp/src/vnext/**`），tool result 返回 URI + 摘要。
- 资源读取通过 `hep://...`（实现：`packages/hep-mcp/src/vnext/resources.ts`）。
- 写作入口统一走 `hep_*` 写作链：
  - Draft Path：`hep_render_latex` → `hep_export_project`
  - Client Path：`hep_run_writing_submit_section_candidates_v1` → `hep_run_writing_submit_section_judge_decision_v1` → `hep_run_writing_integrate_sections_v1` → `hep_export_project`
  - （可选）审稿：`hep_run_writing_submit_review`
  - 不要再暴露/维护 `inspire_writing` 等旧写作工具面。

## 文档与分支卫生（强约束）

- 可 push 的代码分支只保留面向用户的文档（如 `README.md`、`docs/README_zh.md`、`docs/ARCHITECTURE.md`、`docs/TESTING_GUIDE.md`、`docs/TOOL_CATEGORIES.md`、`docs/WRITING_RECIPE_*.md`）。
- 严禁提交/合并开发过程文档：`docs/status/**`、`docs/prompts/**`、`docs/notes/**`、`docs/historydocs/**`、`docs/plans/**`、`.tmp/**`。
- 如需维护开发/历史文档，请使用本地文档分支 worktree（见 `AGENTS.md`）。

## 算法/启发式“定义”位置

- 以代码为准并优先写 tests 固化行为；例如 citation stance detection 的规则/权重/LLM review triggers 在 `packages/hep-mcp/src/tools/research/stance/`（如 `patterns.ts`、`analyzer.ts`、`review.ts`、`pipeline.ts`）。

## 架构文档维护（强约束）

- 架构层面的变更（新增核心模块、修改数据流、调整设计原则等）**必须同步更新** `docs/ARCHITECTURE.md`。
- 架构文档更新应包含：变更描述、影响范围、版本历史记录。

## QA：工具数统计（可选）

从仓库根目录运行：

```bash
node --input-type=module -e "import('./packages/hep-mcp/dist/tools/index.js').then(({getTools})=>console.log('standard',getTools('standard').length,'full',getTools('full').length))"
```
