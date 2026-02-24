#!/usr/bin/env python3
"""Validate method_spec v1 schema against test fixtures.

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
TESTS_DIR = SPECS_DIR / "tests"

SCHEMA_PATH = SPECS_DIR / "method_spec_v1.schema.json"
RUN_CARD_SCHEMA_PATH = SPECS_DIR / "run_card_v2.schema.json"

POSITIVE_FIXTURES = [
    "fixture_method_spec_v1.json",
]
NEGATIVE_FIXTURES_FILE = "negative_method_spec_cases.json"


def _build_validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    run_card_schema = json.loads(RUN_CARD_SCHEMA_PATH.read_text(encoding="utf-8"))

    # Resolve $ref targets via a small local store. This keeps schema files split without network access.
    store = {
        str(schema.get("$id") or "method_spec_v1.schema.json"): schema,
        str(run_card_schema.get("$id") or "run_card_v2.schema.json"): run_card_schema,
    }
    resolver = jsonschema.RefResolver.from_schema(schema, store=store)  # type: ignore[attr-defined]
    return Draft202012Validator(schema, resolver=resolver)


def main() -> int:
    validator = _build_validator()

    passed = 0
    failed = 0

    # --- Positive cases ---
    print("=== Positive cases (must PASS) ===\n")
    for fname in POSITIVE_FIXTURES:
        path = TESTS_DIR / fname
        data = json.loads(path.read_text(encoding="utf-8"))
        errors = list(validator.iter_errors(data))
        if errors:
            print(f"  FAIL  {fname}")
            for e in errors[:15]:
                print(f"        -> {e.json_path}: {e.message}")
            if len(errors) > 15:
                print(f"        ... ({len(errors) - 15} more)")
            failed += 1
        else:
            print(f"  PASS  {fname}")
            passed += 1

    # --- Negative cases ---
    print("\n=== Negative cases (must FAIL) ===\n")
    negatives = json.loads((TESTS_DIR / NEGATIVE_FIXTURES_FILE).read_text(encoding="utf-8"))
    for case in negatives:
        name = case["name"]
        data = case["data"]
        errors = list(validator.iter_errors(data))
        if errors:
            first_msg = errors[0].message[:100]
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

