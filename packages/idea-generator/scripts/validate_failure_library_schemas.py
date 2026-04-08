#!/usr/bin/env python3
"""Validate failure-library schemas and stable fixture artifacts."""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012
except Exception as exc:  # noqa: BLE001
    print(f"ERROR: jsonschema dependency is required ({exc})", file=sys.stderr)
    raise SystemExit(1)


SCHEMA_FILES = [
    "failed_approach_v1.schema.json",
    "failure_library_query_v1.schema.json",
    "failure_library_index_v1.schema.json",
    "failure_library_hits_v1.schema.json",
]

EXAMPLE_MAP = {
    "failed_approach_v1.schema.json": [
        "failed_approach_v1.fixture.json",
    ],
    "failure_library_query_v1.schema.json": [
        "failure_library_query_v1.fixture.json",
    ],
    "failure_library_index_v1.schema.json": [
        "failure_library_index_v1.fixture.json",
    ],
    "failure_library_hits_v1.schema.json": [
        "failure_library_hits_v1.fixture.json",
    ],
}


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _build_registry(schema_dir: Path) -> Registry:
    registry = Registry()
    for schema_path in sorted(schema_dir.glob("*.schema.json")):
        schema = _read_json(schema_path)
        resource = Resource.from_contents(schema, default_specification=DRAFT202012)
        schema_id = schema.get("$id") or schema_path.name
        registry = registry.with_resource(schema_id, resource)
        registry = registry.with_resource(schema_path.resolve().as_uri(), resource)
    return registry


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    schema_root = repo_root / "schemas"
    example_root = repo_root / "docs/fixtures/failure-library"

    registry = _build_registry(schema_root)

    errors: list[str] = []

    for schema_name in SCHEMA_FILES:
        schema_path = schema_root / schema_name
        if not schema_path.is_file():
            errors.append(f"missing schema: {schema_path}")
            continue

        schema = _read_json(schema_path)
        try:
            validator = Draft202012Validator(schema, registry=registry)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"invalid schema ({schema_name}): {exc}")
            continue

        for ex_name in EXAMPLE_MAP.get(schema_name, []):
            ex_path = example_root / ex_name
            if not ex_path.is_file():
                errors.append(f"missing example: {ex_path}")
                continue

            instance = _read_json(ex_path)
            validation_errors = sorted(validator.iter_errors(instance), key=lambda e: e.path)
            for err in validation_errors:
                loc = "/".join(str(x) for x in err.path)
                errors.append(f"{schema_name} <- {ex_name}: {loc} {err.message}")

    if errors:
        print("ERROR: failure library schema validation failed", file=sys.stderr)
        for err in errors:
            print(f" - {err}", file=sys.stderr)
        return 1

    print("OK: failure library schemas and fixtures validated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
