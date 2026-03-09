PYTHON ?= python3
PIP ?= $(PYTHON) -m pip

.PHONY: bootstrap sync-contracts bundle-contracts validate test ci run-server check-drift

bootstrap:
	$(PIP) install -e .[dev]

sync-contracts:
	./scripts/sync_contracts_snapshot.sh

bundle-contracts:
	$(PYTHON) -m idea_core.contracts.bundle --write

validate:
	$(PYTHON) scripts/check_no_test_instance_pollution.py
	$(PYTHON) scripts/check_demo_snapshots_portable.py
	$(PYTHON) -m idea_core.contracts.validate

test:
	pytest

ci: validate test

run-server:
	$(PYTHON) -m idea_core.rpc.server

check-drift:
	./scripts/check_contract_drift.sh
