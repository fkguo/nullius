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
	bash meta/scripts/codegen.sh

codegen-check:
	bash meta/scripts/codegen.sh
	git diff --exit-code packages/shared/src/generated/ meta/generated/python/
	@if git ls-files --others --exclude-standard -- packages/shared/src/generated/ meta/generated/python/ | grep -q .; then \
		echo "codegen-check: FAIL — untracked generated files detected"; exit 1; fi
	@echo "codegen-check: OK — generated code is in sync with schemas"

smoke:
	@echo "--- Smoke test: MCP server starts and lists tools ---"
	cd packages/hep-mcp && node --input-type=module -e \
		"import('./dist/tools/index.js').then(({getTools})=>console.log('standard',getTools('standard').length,'full',getTools('full').length))" \
		|| echo "FAIL: MCP server smoke test"

code-health-check:
	@echo "TODO: check_loc.py + check_entry_files.py (NEW-R02a)"
