#!/usr/bin/env python3
"""Validate quality-gate schemas and bundled example artifacts."""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except Exception as exc:  # noqa: BLE001
    print(f"ERROR: jsonschema dependency is required ({exc})", file=sys.stderr)
    raise SystemExit(1)


SCHEMA_FILES = [
    "scope_classification_v1.schema.json",
    "method_fidelity_contract_v1.schema.json",
    "literature_search_evidence_v2.schema.json",
    "numerics_method_selection_v1.schema.json",
    "numerics_validation_report_v1.schema.json",
    "portability_report_v1.schema.json",
    "core_loop_execution_audit_v1.schema.json",
    "milestone_gate_v1.schema.json",
]

EXAMPLE_MAP = {
    "scope_classification_v1.schema.json": [
        "scope_classification_v1.ecosystem_validation.example.json",
        "scope_classification_v1.publication_ready.example.json",
    ],
    "method_fidelity_contract_v1.schema.json": [
        "method_fidelity_contract_v1.example.json",
    ],
    "literature_search_evidence_v2.schema.json": [
        "literature_search_evidence_v2.example.json",
    ],
    "numerics_method_selection_v1.schema.json": [
        "numerics_method_selection_v1.example.json",
    ],
    "numerics_validation_report_v1.schema.json": [
        "numerics_validation_report_v1.example.json",
    ],
    "portability_report_v1.schema.json": [
        "portability_report_v1.example.json",
    ],
    "core_loop_execution_audit_v1.schema.json": [
        "core_loop_execution_audit_v1.example.json",
    ],
    "milestone_gate_v1.schema.json": [
        "milestone_gate_v1.example.json",
    ],
}


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    schema_root = repo_root / "schemas"
    example_root = repo_root / "docs/plans/examples/2026-02-15-quality-gates"

    errors: list[str] = []

    for schema_name in SCHEMA_FILES:
        schema_path = schema_root / schema_name
        if not schema_path.is_file():
            errors.append(f"missing schema: {schema_path}")
            continue

        schema = _read_json(schema_path)
        try:
            validator = Draft202012Validator(schema)
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
        print("ERROR: quality-gate schema validation failed", file=sys.stderr)
        for err in errors:
            print(f" - {err}", file=sys.stderr)
        return 1

    print("OK: quality-gate schemas and examples validated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
