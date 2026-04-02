#!/usr/bin/env python3
from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Any

STATUS_VALUES = frozenset({"converged", "not_converged", "parse_error", "early_stop"})
EXIT_CODE_VALUES = frozenset({0, 1, 2, 3})
VERDICT_VALUES = frozenset({"ready", "needs_revision", "unknown"})
PARSER_VERSION = "sem07-v1"
STATUS_TO_EXIT = {
    "converged": 0,
    "not_converged": 1,
    "parse_error": 2,
    "early_stop": 3,
}

_CONVERGENCE_RESULT_SCHEMA_BASENAME = "convergence_gate_result_v1.schema.json"


def _find_convergence_result_schema_path() -> Path | None:
    """Locate the shared convergence result schema (SSOT) from the skill tree.

    This is the bounded M-22 consumer-adoption slice:
    - remove duplicated local authority for convergence gate ids and schema id/version
    - derive those identifiers from the shared JSON Schema SSOT under `meta/schemas/`
    - fail closed if the shared schema cannot be located (invalid install/mount)
    """

    start = Path(__file__).resolve()
    for idx, parent in enumerate(start.parents):
        if idx >= 12:
            break
        candidate = parent / "meta" / "schemas" / _CONVERGENCE_RESULT_SCHEMA_BASENAME
        if candidate.is_file():
            return candidate
    return None


def _load_convergence_result_schema_authority() -> tuple[frozenset[str], str, int, str | None]:
    schema_path = _find_convergence_result_schema_path()
    if schema_path is None:
        return (
            frozenset(),
            "__shared_schema_unavailable__",
            0,
            "shared convergence schema SSOT not found (expected meta/schemas/"
            f"{_CONVERGENCE_RESULT_SCHEMA_BASENAME} reachable from this skill install); "
            "install `research-team` via a symlink into an autoresearch-lab worktree (not a copy-only install).",
        )

    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except Exception as e:  # CONTRACT-EXEMPT: CODE-01.5 explicit fail-closed diagnostics
        return (
            frozenset(),
            "__shared_schema_unavailable__",
            0,
            f"failed to read shared convergence schema SSOT at {schema_path}: {e}",
        )

    try:
        meta_props = schema["properties"]["meta"]["properties"]
        gate_ids = meta_props["gate_id"]["enum"]
        schema_id = meta_props["schema_id"]["const"]
        schema_version = meta_props["schema_version"]["const"]
    except Exception as e:  # CONTRACT-EXEMPT: CODE-01.5 explicit fail-closed diagnostics
        return (
            frozenset(),
            "__shared_schema_unavailable__",
            0,
            f"shared convergence schema SSOT at {schema_path} missing expected meta authority fields: {e}",
        )

    if not isinstance(gate_ids, list) or not gate_ids or any(not isinstance(x, str) for x in gate_ids):
        return (
            frozenset(),
            "__shared_schema_unavailable__",
            0,
            f"shared convergence schema SSOT at {schema_path} has invalid meta.gate_id enum: {gate_ids!r}",
        )
    if not isinstance(schema_id, str) or not schema_id.strip():
        return (
            frozenset(),
            "__shared_schema_unavailable__",
            0,
            f"shared convergence schema SSOT at {schema_path} has invalid meta.schema_id const: {schema_id!r}",
        )
    if not isinstance(schema_version, int) or isinstance(schema_version, bool):
        return (
            frozenset(),
            "__shared_schema_unavailable__",
            0,
            f"shared convergence schema SSOT at {schema_path} has invalid meta.schema_version const: {schema_version!r}",
        )

    return frozenset(gate_ids), schema_id, schema_version, None


GATE_ID_VALUES, SCHEMA_ID, SCHEMA_VERSION, _SCHEMA_AUTHORITY_ERROR = (
    _load_convergence_result_schema_authority()
)


def _utc_now() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def build_gate_meta(gate_id: str) -> dict[str, Any]:
    return {
        "gate_id": gate_id,
        "generated_at": _utc_now(),
        "parser_version": PARSER_VERSION,
        "schema_id": SCHEMA_ID,
        "schema_version": SCHEMA_VERSION,
    }


def default_member_status(source_path: Path | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "verdict": "unknown",
        "blocking_count": None,
        "parse_ok": False,
        "errors": ["missing report"],
    }
    if source_path is not None:
        out["source_path"] = str(source_path)
    return out


def _validate_member_summary(member: str, payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return [f"report_status.{member} must be an object"]

    required = {"verdict", "blocking_count", "parse_ok"}
    missing = sorted(required - set(payload.keys()))
    if missing:
        errors.append(f"report_status.{member} missing required keys: {', '.join(missing)}")

    verdict = payload.get("verdict")
    if verdict not in VERDICT_VALUES:
        errors.append(f"report_status.{member}.verdict must be one of {sorted(VERDICT_VALUES)}")

    blocking = payload.get("blocking_count")
    if blocking is not None and (not isinstance(blocking, int) or blocking < 0):
        errors.append(f"report_status.{member}.blocking_count must be null or non-negative integer")

    parse_ok = payload.get("parse_ok")
    if not isinstance(parse_ok, bool):
        errors.append(f"report_status.{member}.parse_ok must be boolean")

    if "errors" in payload:
        err_val = payload["errors"]
        if not isinstance(err_val, list) or any(not isinstance(item, str) for item in err_val):
            errors.append(f"report_status.{member}.errors must be string[] when present")

    return errors


def validate_convergence_result(result: Any) -> list[str]:
    if _SCHEMA_AUTHORITY_ERROR is not None:
        # Fail closed: do not silently fall back to local hardcoded identifiers.
        return [_SCHEMA_AUTHORITY_ERROR]

    errors: list[str] = []
    if not isinstance(result, dict):
        return ["result must be an object"]

    required = {"status", "exit_code", "reasons", "report_status", "meta"}
    missing = sorted(required - set(result.keys()))
    if missing:
        errors.append(f"missing required keys: {', '.join(missing)}")

    status = result.get("status")
    if status not in STATUS_VALUES:
        errors.append(f"status must be one of {sorted(STATUS_VALUES)}")

    exit_code = result.get("exit_code")
    if exit_code not in EXIT_CODE_VALUES:
        errors.append(f"exit_code must be one of {sorted(EXIT_CODE_VALUES)}")

    if isinstance(status, str) and isinstance(exit_code, int):
        expected = STATUS_TO_EXIT.get(status)
        if expected is not None and exit_code != expected:
            errors.append(f"status/exit_code mismatch: status={status!r} requires exit_code={expected}")

    reasons = result.get("reasons")
    if not isinstance(reasons, list) or any(not isinstance(item, str) for item in reasons):
        errors.append("reasons must be string[]")

    report_status = result.get("report_status")
    if not isinstance(report_status, dict) or not report_status:
        errors.append("report_status must be a non-empty object")
    else:
        for member, payload in report_status.items():
            if not isinstance(member, str) or not member:
                errors.append("report_status keys must be non-empty strings")
                continue
            errors.extend(_validate_member_summary(member, payload))

    meta = result.get("meta")
    if not isinstance(meta, dict):
        errors.append("meta must be an object")
    else:
        meta_required = {"gate_id", "generated_at", "parser_version", "schema_id", "schema_version"}
        meta_missing = sorted(meta_required - set(meta.keys()))
        if meta_missing:
            errors.append(f"meta missing required keys: {', '.join(meta_missing)}")

        gate_id = meta.get("gate_id")
        if gate_id not in GATE_ID_VALUES:
            errors.append(f"meta.gate_id must be one of {sorted(GATE_ID_VALUES)}")
        if not isinstance(meta.get("generated_at"), str):
            errors.append("meta.generated_at must be ISO date-time string")
        if not isinstance(meta.get("parser_version"), str) or not str(meta.get("parser_version")).strip():
            errors.append("meta.parser_version must be a non-empty string")
        if meta.get("schema_id") != SCHEMA_ID:
            errors.append(f"meta.schema_id must be {SCHEMA_ID!r}")
        if meta.get("schema_version") != SCHEMA_VERSION:
            errors.append(f"meta.schema_version must be {SCHEMA_VERSION}")

    return errors


def emit_convergence_result(result: dict[str, Any], out_json: Path | None = None) -> None:
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if out_json is None:
        return
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
