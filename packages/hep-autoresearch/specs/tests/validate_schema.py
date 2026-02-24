#!/usr/bin/env python3
"""Validate run_card v2 schema against test fixtures.

Positive cases: must pass validation.
Negative cases: must fail validation.
"""

import json
import sys
from pathlib import Path

try:
    import jsonschema
    from jsonschema import Draft202012Validator
except ImportError:
    print("ERROR: jsonschema not installed. Run: pip install jsonschema")
    sys.exit(1)

SPECS_DIR = Path(__file__).resolve().parent.parent
SCHEMA_PATH = SPECS_DIR / "run_card_v2.schema.json"
TESTS_DIR = SPECS_DIR / "tests"

POSITIVE_FIXTURES = [
    "fixture_nlo_cross_section.json",
    "fixture_schrodinger_ho.json",
    "fixture_minimal.json",
]
NEGATIVE_FIXTURES_FILE = "negative_cases.json"


def main() -> int:
    schema = json.loads(SCHEMA_PATH.read_text())
    validator = Draft202012Validator(schema)

    passed = 0
    failed = 0

    # --- Positive cases ---
    print("=== Positive cases (must PASS) ===\n")
    for fname in POSITIVE_FIXTURES:
        path = TESTS_DIR / fname
        data = json.loads(path.read_text())
        errors = list(validator.iter_errors(data))
        if errors:
            print(f"  FAIL  {fname}")
            for e in errors:
                print(f"        -> {e.json_path}: {e.message}")
            failed += 1
        else:
            print(f"  PASS  {fname}")
            passed += 1

    # --- Negative cases ---
    print("\n=== Negative cases (must FAIL) ===\n")
    negatives = json.loads((TESTS_DIR / NEGATIVE_FIXTURES_FILE).read_text())
    for case in negatives:
        name = case["name"]
        data = case["data"]
        errors = list(validator.iter_errors(data))
        if errors:
            first_msg = errors[0].message[:80]
            print(f"  PASS  {name}  (rejected: {first_msg})")
            passed += 1
        else:
            print(f"  FAIL  {name}  (should have been rejected but was accepted)")
            failed += 1

    # --- Summary ---
    total = passed + failed
    print(f"\n{'='*50}")
    print(f"Results: {passed}/{total} passed, {failed}/{total} failed")
    if failed:
        print("SCHEMA VALIDATION SUITE: FAILED")
        return 1
    else:
        print("SCHEMA VALIDATION SUITE: ALL PASSED")
        return 0


if __name__ == "__main__":
    sys.exit(main())
