PYTHON ?= python3
PIP ?= $(PYTHON) -m pip

.PHONY: bootstrap sync-contracts bundle-contracts validate test ci run-server

bootstrap:
	$(PIP) install -e .[dev]

sync-contracts:
	./scripts/sync_contracts_snapshot.sh

bundle-contracts:
	$(PYTHON) -m idea_core.contracts.bundle --write

validate:
	$(PYTHON) scripts/check_no_test_instance_pollution.py
	$(PYTHON) scripts/check_m5_legacy_migration_absent.py
	$(PYTHON) -m idea_core.contracts.validate

test:
	pytest

ci: validate test

run-server:
	$(PYTHON) -m idea_core.rpc.server
