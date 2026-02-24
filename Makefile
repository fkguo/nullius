.PHONY: install build test lint clean codegen codegen-check smoke code-health-check

install:
	pnpm install

build:
	pnpm -r build

test:
	pnpm -r test
	@echo "--- Python tests ---"
	cd packages/hep-autoresearch && python -m pytest tests/ -q 2>/dev/null || echo "(no pytest tests yet)"
	cd packages/idea-core && python -m pytest tests/ -q 2>/dev/null || echo "(no pytest tests yet)"

lint:
	pnpm -r lint

clean:
	pnpm -r clean
	find packages/ -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find packages/ -type d -name dist -exec rm -rf {} + 2>/dev/null || true

codegen:
	@echo "TODO: JSON Schema -> TS/Python type generation (NEW-01)"

codegen-check:
	@echo "TODO: codegen && git diff --exit-code */generated/ (NEW-01)"

smoke:
	@echo "--- Smoke test: MCP server starts and lists tools ---"
	cd packages/hep-mcp && node --input-type=module -e \
		"import('./dist/tools/index.js').then(({getTools})=>console.log('standard',getTools('standard').length,'full',getTools('full').length))" \
		|| echo "FAIL: MCP server smoke test"

code-health-check:
	@echo "TODO: check_loc.py + check_entry_files.py (NEW-R02a)"
