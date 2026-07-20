#!/usr/bin/env python3
from __future__ import annotations

import datetime as _dt
import json
import re as _re
from pathlib import Path
from typing import Any

STATUS_VALUES = frozenset({"pass", "fail", "input_error"})
EXIT_CODE_VALUES = frozenset({0, 1, 2})
VERDICT_VALUES = frozenset({"ready", "needs_revision", "unknown"})
PARSER_VERSION = "delegation-budget-v1"
STATUS_TO_EXIT = {"pass": 0, "fail": 1, "input_error": 2}

_RESULT_SCHEMA_BASENAME = "delegation_budget_gate_result_v1.schema.json"


def _find_result_schema_path() -> Path | None:
    start = Path(__file__).resolve()
    for idx, parent in enumerate(start.parents):
        if idx >= 12:
            break
        candidate = parent / "meta" / "schemas" / _RESULT_SCHEMA_BASENAME
        if candidate.is_file():
            return candidate
    return None


def _load_schema_authority() -> tuple[str, int, str | None, str | None]:
    schema_path = _find_result_schema_path()
    if schema_path is None:
        return (
            "__shared_schema_unavailable__",
            0,
            None,
            "shared delegation budget result schema SSOT not found (expected "
            f"meta/schemas/{_RESULT_SCHEMA_BASENAME} reachable from this skill install); "
            "install `research-team` via a symlink into a nullius worktree (not a copy-only install).",
        )

    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        definitions = schema["$defs"]
        meta_props = definitions["DelegationBudgetGateMeta"]["properties"]
        schema_id = meta_props["schema_id"]["const"]
        schema_version = meta_props["schema_version"]["const"]
        gate_id = meta_props["gate_id"]["const"]
        key_patterns = list(schema["properties"]["contract_status"]["patternProperties"].keys())
    except Exception as e:  # CONTRACT-EXEMPT: explicit fail-closed diagnostics
        return (
            "__shared_schema_unavailable__",
            0,
            None,
            f"failed to load shared delegation budget result schema SSOT at {schema_path}: {e}",
        )

    if gate_id != "delegation_budget":
        return (
            "__shared_schema_unavailable__",
            0,
            None,
            f"shared delegation budget result schema has invalid meta.gate_id const: {gate_id!r}",
        )
    if not isinstance(schema_id, str) or not schema_id.strip():
        return (
            "__shared_schema_unavailable__",
            0,
            None,
            f"shared delegation budget result schema has invalid meta.schema_id const: {schema_id!r}",
        )
    if not isinstance(schema_version, int) or isinstance(schema_version, bool):
        return (
            "__shared_schema_unavailable__",
            0,
            None,
            f"shared delegation budget result schema has invalid meta.schema_version const: {schema_version!r}",
        )
    if len(key_patterns) != 1 or not isinstance(key_patterns[0], str) or not key_patterns[0]:
        return (
            "__shared_schema_unavailable__",
            0,
            None,
            f"shared delegation budget result schema has invalid contract_status pattern: {key_patterns!r}",
        )
    try:
        _re.compile(key_patterns[0])
    except _re.error as e:
        return (
            "__shared_schema_unavailable__",
            0,
            None,
            f"shared delegation budget result schema has uncompilable contract_status pattern "
            f"{key_patterns[0]!r}: {e}",
        )
    return schema_id, schema_version, key_patterns[0], None


SCHEMA_ID, SCHEMA_VERSION, CONTRACT_STATUS_KEY_PATTERN, _SCHEMA_AUTHORITY_ERROR = (
    _load_schema_authority()
)


def _utc_now() -> str:
    return (
        _dt.datetime.now(_dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def build_delegation_budget_meta() -> dict[str, Any]:
    return {
        "gate_id": "delegation_budget",
        "generated_at": _utc_now(),
        "parser_version": PARSER_VERSION,
        "schema_id": SCHEMA_ID,
        "schema_version": SCHEMA_VERSION,
    }


def _validate_contract_summary(key: str, payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return [f"contract_status.{key} must be an object"]

    errors: list[str] = []
    required = {"verdict", "blocking_count", "parse_ok"}
    missing = sorted(required - set(payload.keys()))
    if missing:
        errors.append(f"contract_status.{key} missing required keys: {', '.join(missing)}")

    if payload.get("verdict") not in VERDICT_VALUES:
        errors.append(f"contract_status.{key}.verdict must be one of {sorted(VERDICT_VALUES)}")
    blocking = payload.get("blocking_count")
    if not isinstance(blocking, int) or isinstance(blocking, bool) or blocking < 0:
        errors.append(f"contract_status.{key}.blocking_count must be a non-negative integer")
    if not isinstance(payload.get("parse_ok"), bool):
        errors.append(f"contract_status.{key}.parse_ok must be boolean")
    if "source_path" in payload and not isinstance(payload["source_path"], str):
        errors.append(f"contract_status.{key}.source_path must be a string when present")
    if "errors" in payload:
        value = payload["errors"]
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            errors.append(f"contract_status.{key}.errors must be string[] when present")
    allowed = required | {"source_path", "errors"}
    extra = sorted(set(payload.keys()) - allowed)
    if extra:
        errors.append(f"contract_status.{key} has unknown keys: {', '.join(extra)}")
    return errors


def validate_delegation_budget_result(result: Any) -> list[str]:
    if _SCHEMA_AUTHORITY_ERROR is not None:
        return [_SCHEMA_AUTHORITY_ERROR]
    if not isinstance(result, dict):
        return ["result must be an object"]

    errors: list[str] = []
    required = {"status", "exit_code", "reasons", "contract_status", "meta"}
    missing = sorted(required - set(result.keys()))
    if missing:
        errors.append(f"missing required keys: {', '.join(missing)}")
    extra = sorted(set(result.keys()) - required)
    if extra:
        errors.append(f"result has unknown keys: {', '.join(extra)}")

    status = result.get("status")
    if status not in STATUS_VALUES:
        errors.append(f"status must be one of {sorted(STATUS_VALUES)}")
    exit_code = result.get("exit_code")
    if isinstance(exit_code, bool) or exit_code not in EXIT_CODE_VALUES:
        errors.append(f"exit_code must be one of {sorted(EXIT_CODE_VALUES)}")
    if isinstance(status, str) and isinstance(exit_code, int) and not isinstance(exit_code, bool):
        expected = STATUS_TO_EXIT.get(status)
        if expected is not None and exit_code != expected:
            errors.append(f"status/exit_code mismatch: status={status!r} requires exit_code={expected}")

    reasons = result.get("reasons")
    if not isinstance(reasons, list) or any(not isinstance(item, str) for item in reasons):
        errors.append("reasons must be string[]")

    contract_status = result.get("contract_status")
    if not isinstance(contract_status, dict) or not contract_status:
        errors.append("contract_status must be a non-empty object")
    else:
        for key, payload in contract_status.items():
            if not isinstance(key, str) or not key:
                errors.append("contract_status keys must be non-empty strings")
                continue
            if CONTRACT_STATUS_KEY_PATTERN is not None and not _re.fullmatch(
                f"(?:{CONTRACT_STATUS_KEY_PATTERN})", key
            ):
                errors.append(
                    f"contract_status key {key!r} does not match the shared schema "
                    f"key pattern {CONTRACT_STATUS_KEY_PATTERN!r}"
                )
            errors.extend(_validate_contract_summary(key, payload))

    meta = result.get("meta")
    if not isinstance(meta, dict):
        errors.append("meta must be an object")
    else:
        meta_required = {"gate_id", "generated_at", "parser_version", "schema_id", "schema_version"}
        meta_missing = sorted(meta_required - set(meta.keys()))
        if meta_missing:
            errors.append(f"meta missing required keys: {', '.join(meta_missing)}")
        if meta.get("gate_id") != "delegation_budget":
            errors.append("meta.gate_id must be 'delegation_budget'")
        if not isinstance(meta.get("generated_at"), str):
            errors.append("meta.generated_at must be ISO date-time string")
        if not isinstance(meta.get("parser_version"), str) or not meta.get("parser_version", "").strip():
            errors.append("meta.parser_version must be a non-empty string")
        if meta.get("schema_id") != SCHEMA_ID:
            errors.append(f"meta.schema_id must be {SCHEMA_ID!r}")
        version = meta.get("schema_version")
        if isinstance(version, bool) or version != SCHEMA_VERSION:
            errors.append(f"meta.schema_version must be {SCHEMA_VERSION}")
        meta_extra = sorted(set(meta.keys()) - meta_required - {"tag"})
        if meta_extra:
            errors.append(f"meta has unknown keys: {', '.join(meta_extra)}")
        if "tag" in meta and not isinstance(meta["tag"], str):
            errors.append("meta.tag must be a string when present")

    return errors
