# Autoresearch Lab — Project Overview

## Purpose
Autoresearch is an ecosystem for automated HEP (High-Energy Physics) research. It provides:
- **MCP server** (`hep-mcp`) for INSPIRE-HEP, Zotero, PDG database access
- **Research orchestrator** (`hep-autoresearch`, Python — being migrated to TS `orchestrator`)
- **Idea engine** (`idea-core`, Python — being migrated to TS `idea-engine`)
- **Skills** for Claude Code / other agents (paper writing, calculations, reviews)

## Tech Stack
- **TypeScript** (pnpm workspace, ES2022, NodeNext modules, strict mode)
- **Python** (3.11+, legacy orchestrator and idea engine)
- **Build**: pnpm 9.x, tsc composite builds
- **Test**: vitest (TS), pytest (Python)
- **Lint**: eslint (TS)

## Monorepo Structure (packages/)

| Package | Language | Description |
|---------|----------|-------------|
| `hep-mcp` | TS | Main MCP server (INSPIRE, Zotero, PDG, writing pipeline) |
| `shared` | TS | Shared types, errors, utilities |
| `pdg-mcp` | TS | PDG offline SQLite tools |
| `zotero-mcp` | TS | Zotero Local API tools |
| `orchestrator` | TS | New TS orchestrator (scaffold, NEW-05a) |
| `idea-engine` | TS | New TS idea engine (scaffold, NEW-05a Stage 3) |
| `agent-arxiv` | TS | Agent-arXiv service (scaffold, EVO-15) |
| `hep-autoresearch` | Python | Legacy orchestrator (retiring) |
| `idea-core` | Python | Legacy idea engine (retiring) |
| `idea-generator` | JSON Schema + Python | Schema SSOT + validation |
| `skills-market` | Python | Skill distribution metadata |

Other top-level dirs:
- `skills/` — Skill implementations (bash/python/wolframscript)
- `meta/` — Project governance, REDESIGN_PLAN, schemas, scripts
- `docs/` — User-facing documentation (ARCHITECTURE.md, etc.)

## npm Scope
`@autoresearch/*` (renamed from `@hep-research/*` in NEW-R13)

## Key Design Principles
- **Evidence-first I/O**: Large objects → artifacts + MCP Resources; tool results return URI + summary only
- **Quality-first**: Academic writing quality over cost/latency
- **Zod as SSOT**: Tool parameters defined via Zod schemas; MCP inputSchema auto-generated
- **Local MCP transport only**: stdio (StdioServerTransport); no HTTP
- **Zotero Local API only**: http://127.0.0.1:23119; no Web API
