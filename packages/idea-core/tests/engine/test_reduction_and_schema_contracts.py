from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.reduction import build_reduction_audit


def _validator_for(schema_name: str) -> Draft202012Validator:
    registry = Registry()
    for schema_path in sorted(DEFAULT_CONTRACT_DIR.glob("*.schema.json")):
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        registry = registry.with_resource(
            schema_path.resolve().as_uri(),
            Resource.from_contents(schema),
        )

    target_path = DEFAULT_CONTRACT_DIR / schema_name
    target_schema = json.loads(target_path.read_text(encoding="utf-8"))
    wrapped = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": target_path.resolve().as_uri(),
        **target_schema,
    }
    return Draft202012Validator(wrapped, registry=registry, format_checker=FormatChecker())


def test_reduction_audit_partial_mixed_satisfied_pending() -> None:
    audit = build_reduction_audit(
        abstract_problem="optimization",
        assumptions=[
            {"assumption_id": "a1", "status": "satisfied"},
            {"assumption_id": "a2", "status": "pending_verification"},
        ],
        toy_check_result="pass",
        reduction_type_valid=True,
    )

    assert audit["status"] == "partial"
    assert "auditor_origin" not in audit

    validator = _validator_for("reduction_audit_v1.schema.json")
    errors = list(validator.iter_errors(audit))
    assert not errors


def test_reduction_audit_partial_when_toy_check_skipped_and_auditor_origin_optional() -> None:
    audit = build_reduction_audit(
        abstract_problem="optimization",
        assumptions=[{"assumption_id": "a1", "status": "satisfied"}],
        toy_check_result="skipped",
        skip_reason="compute budget unavailable",
        reduction_type_valid=True,
        auditor_origin={"model": "gpt-5", "role": "Checker"},
    )

    assert audit["status"] == "partial"
    assert audit["skip_reason"] == "compute budget unavailable"
    assert audit["auditor_origin"]["model"] == "gpt-5"

    validator = _validator_for("reduction_audit_v1.schema.json")
    errors = list(validator.iter_errors(audit))
    assert not errors


def test_distributor_event_requires_rng_alg_when_seed_present() -> None:
    validator = _validator_for("distributor_event_v1.schema.json")

    invalid_event = {
        "campaign_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "step_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "decision_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "timestamp": "2026-02-13T00:00:00Z",
        "selected_action": {
            "backend_id": "backend-a",
            "operator_id": "operator-a",
            "island_id": "island-0",
        },
        "rng_seed_used": "42",
    }
    invalid_errors = list(validator.iter_errors(invalid_event))
    assert invalid_errors

    valid_event = dict(invalid_event)
    valid_event["rng_alg"] = "pcg64"
    valid_errors = list(validator.iter_errors(valid_event))
    assert not valid_errors
