#!/usr/bin/env python3
"""Validate W6 island/opportunity schemas and bundled example artifacts.

This repo is a design workspace; we keep schemas + examples machine-checkable.
Runtime enforcement lives in idea-runs (validate-project).
"""

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
    "idea_island_plan_v1.schema.json",
    "idea_island_registry_v1.schema.json",
    "idea_island_progress_event_v1.schema.json",
    "bootstrap_opportunity_card_v1.schema.json",
]

EXAMPLE_ROOT = Path("docs/plans/examples/2026-02-16-w6-01-islands-opportunities")

JSON_EXAMPLES = {
    "idea_island_plan_v1.schema.json": ["idea_island_plan_v1.example.json"],
    "idea_island_registry_v1.schema.json": ["idea_island_registry_v1.example.json"],
    "bootstrap_opportunity_card_v1.schema.json": ["bootstrap_opportunity_card_v1.example.json"],
}

JSONL_EXAMPLES = {
    "idea_island_progress_event_v1.schema.json": ["idea_island_progress_v1.example.jsonl"],
    "bootstrap_opportunity_card_v1.schema.json": ["bootstrap_opportunity_pool_v1.example.jsonl"],
}


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    schema_root = repo_root / "schemas"
    example_root = repo_root / EXAMPLE_ROOT

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

        for ex_name in JSON_EXAMPLES.get(schema_name, []):
            ex_path = example_root / ex_name
            if not ex_path.is_file():
                errors.append(f"missing example: {ex_path}")
                continue

            instance = _read_json(ex_path)
            for err in sorted(validator.iter_errors(instance), key=lambda e: e.path):
                loc = "/".join(str(x) for x in err.path)
                errors.append(f"{schema_name} <- {ex_name}: {loc} {err.message}")

        for ex_name in JSONL_EXAMPLES.get(schema_name, []):
            ex_path = example_root / ex_name
            if not ex_path.is_file():
                errors.append(f"missing example: {ex_path}")
                continue

            for idx, line in enumerate(ex_path.read_text(encoding="utf-8").splitlines(), start=1):
                if not line.strip():
                    continue
                try:
                    instance = json.loads(line)
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{schema_name} <- {ex_name}:{idx}: invalid JSON ({exc})")
                    continue
                for err in sorted(validator.iter_errors(instance), key=lambda e: e.path):
                    loc = "/".join(str(x) for x in err.path)
                    errors.append(f"{schema_name} <- {ex_name}:{idx}: {loc} {err.message}")

    if errors:
        print("ERROR: W6 island/opportunity schema validation failed", file=sys.stderr)
        for err in errors:
            print(f" - {err}", file=sys.stderr)
        return 1

    print("OK: W6 island/opportunity schemas and examples validated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

