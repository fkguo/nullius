.PHONY: install build test lint clean codegen codegen-check smoke code-health-check contract-test release

install:
	pnpm install

build:
	pnpm -r build

test:
	pnpm -r test
	@echo "--- Python tests ---"
	python3 -m pytest packages/project-contracts/tests -q

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
	@echo "--- CODE-01.1: eLOC gate ---"
	git diff --name-only origin/main...HEAD | python3 meta/scripts/check_loc.py
	@echo "--- NEW-R02: as any / swallowed catch gate ---"
	bash meta/scripts/check_as_any.sh --vs-main

contract-test:
	@echo "--- H-16b: cross-component tool subset contract ---"
	cd packages/hep-mcp && npx vitest run tests/contracts/crossComponentToolSubset.test.ts

# REL-01: every check a release tag must pass, in one target.
release:
	@echo "--- REL-01 (1/5): build ---"
	pnpm -r build
	@echo "--- REL-01 (2/5): SYNC-06 generated code matches meta/schemas ---"
	$(MAKE) codegen-check
	@echo "--- REL-01 (3/5): versions in lockstep ---"
	bash meta/scripts/check_version_sync.sh
	node scripts/check-version-consistency.mjs
	@echo "--- REL-01 (4/5): SYNC-02 tool catalog matches the runtime registry ---"
	pnpm --filter @nullius/hep-mcp catalog
	git diff --exit-code packages/hep-mcp/tool_catalog.standard.json packages/hep-mcp/tool_catalog.full.json
	@echo "--- REL-01 (5/5): skill tool-name references resolve ---"
	node scripts/check-skill-tool-name-anti-drift.mjs
	@echo "release: OK — tag this commit"
