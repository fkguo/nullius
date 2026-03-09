PYTHON ?= python3

.PHONY: validate check-pollution check-quality-schemas check-failure-library-schemas check-w6-islands-opportunities-schemas

check-pollution:
	$(PYTHON) scripts/check_no_test_instance_pollution.py

check-quality-schemas:
	$(PYTHON) scripts/validate_quality_schemas.py

check-failure-library-schemas:
	$(PYTHON) scripts/validate_failure_library_schemas.py

check-w6-islands-opportunities-schemas:
	$(PYTHON) scripts/validate_w6_islands_opportunities_schemas.py

validate: check-pollution check-quality-schemas check-failure-library-schemas check-w6-islands-opportunities-schemas
