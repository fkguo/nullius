# Code Style and Conventions

## TypeScript
- ES2022 target, NodeNext module resolution, strict mode
- Tool parameters: Zod schema as SSOT; never hand-write JSON Schema
- Tool registration via `ToolSpec { name, zodSchema, handler, exposure }` in registry.ts
- Network requests to INSPIRE/arXiv must use `inspireFetch()` / `arxivFetch()` from rateLimiter.ts
- Import paths use `@autoresearch/*` scope
- Tests use vitest
- No HTTP transport; stdio only

## Python
- Python 3.11+
- pytest for testing
- Legacy packages (hep-autoresearch, idea-core) being retired → TS replacements

## General
- Code in English, comments in English
- User-facing docs: README.md, docs/ARCHITECTURE.md, docs/README_zh.md
- Process/dev docs go in meta/ (excluded from releases)
- Architecture changes MUST update docs/ARCHITECTURE.md
- Contract tests: packages/hep-mcp/tests/toolContracts.test.ts

## Naming
- Package names: kebab-case (`hep-mcp`, `idea-core`)
- npm scope: `@autoresearch/`
- Tool names: snake_case with prefix (`hep_*`, `inspire_*`, `zotero_*`, `pdg_*`)
