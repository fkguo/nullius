# Suggested Commands

## Development (from monorepo root)

```bash
pnpm install          # Install all dependencies
pnpm -r build         # Build all TS packages
pnpm -r test          # Run all tests (vitest for TS, pytest for Python)
pnpm -r lint          # Lint all TS packages
make test             # TS + Python tests combined
make smoke            # MCP server smoke test
```

## Per-package

```bash
pnpm --filter @autoresearch/hep-mcp build
pnpm --filter @autoresearch/hep-mcp test
pnpm --filter @autoresearch/shared test
```

## Python packages

```bash
cd packages/hep-autoresearch && python -m pytest
cd packages/idea-core && python -m pytest
```

## Tool count QA

```bash
node --input-type=module -e "import('./packages/hep-mcp/dist/tools/index.js').then(({getTools})=>console.log('standard',getTools('standard').length,'full',getTools('full').length))"
```

## System utilities (macOS Darwin)

```bash
git status / git log --oneline -10
find . -name "*.ts" -not -path "*/node_modules/*"   # Find files
grep -r "pattern" --include="*.ts" packages/         # Search code
```

## Network proxy (when WebFetch fails)

```bash
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
export all_proxy=socks5://127.0.0.1:7890
```
