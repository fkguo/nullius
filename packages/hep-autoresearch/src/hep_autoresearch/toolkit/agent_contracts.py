from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any


_CARD_KEYS = {
    "schema_version",
    "agent_id",
    "name",
    "description",
    "version",
    "cost_tier",
    "capabilities",
    "input_contracts",
    "output_contracts",
}
_CAPABILITY_KEYS = {"capability_id", "description", "input_contract_ids", "output_contract_ids"}
_CONTRACT_KEYS = {"contract_id", "format", "description", "source_path"}
_MESSAGE_KEYS = {
    "schema_version",
    "message_id",
    "trace_id",
    "run_id",
    "source_agent_id",
    "target_agent_id",
    "message_kind",
    "requested_capability",
    "payload",
    "error",
}
_ENVELOPE_KEYS = {"domain", "code", "message", "retryable", "run_id", "trace_id", "data"}
_COST_TIERS = {"low", "medium", "high", "variable"}
_CONTRACT_FORMATS = {"json_schema", "openrpc", "protocol"}
_MESSAGE_KINDS = {"request", "response", "error"}
_RETRYABLE_CODES = {"RATE_LIMIT", "UPSTREAM_ERROR"}


def repo_root_from_module() -> Path:
    return Path(__file__).resolve().parents[5]


def schema_path(schema_name: str, *, repo_root: Path | None = None) -> Path:
    root = repo_root or repo_root_from_module()
    return root / "meta" / "schemas" / f"{schema_name}.schema.json"


def load_schema(schema_name: str, *, repo_root: Path | None = None) -> dict[str, Any]:
    return json.loads(schema_path(schema_name, repo_root=repo_root).read_text(encoding="utf-8"))


def _non_empty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def _string_or_none(value: Any, label: str) -> str | None:
    if value is None:
        return None
    return _non_empty_string(value, label)


def _uuid_string(value: Any, label: str) -> str:
    text = _non_empty_string(value, label)
    try:
        parsed = uuid.UUID(text)
    except ValueError as exc:
        raise ValueError(f"{label} must be a UUID v4 string") from exc
    if parsed.version != 4:
        raise ValueError(f"{label} must be a UUID v4 string")
    return str(parsed)


def build_error_envelope(*, domain: str, code: str, message: str, run_id: str | None, trace_id: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "domain": _non_empty_string(domain, "error.domain"),
        "code": _non_empty_string(code, "error.code"),
        "message": _non_empty_string(message, "error.message"),
        "retryable": str(code).strip() in _RETRYABLE_CODES,
        "run_id": _string_or_none(run_id, "error.run_id"),
        "trace_id": _uuid_string(trace_id, "error.trace_id"),
        "data": data if isinstance(data, dict) else None,
    }


def validate_agent_card(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("agent_card must be a JSON object")
    extra = sorted(set(payload) - _CARD_KEYS)
    if extra:
        raise ValueError(f"agent_card has unexpected keys: {extra}")
    if int(payload.get("schema_version") or 0) != 1:
        raise ValueError("agent_card.schema_version must be integer const 1")
    _non_empty_string(payload.get("agent_id"), "agent_card.agent_id")
    _non_empty_string(payload.get("name"), "agent_card.name")
    if "description" in payload:
        _non_empty_string(payload.get("description"), "agent_card.description")
    _non_empty_string(payload.get("version"), "agent_card.version")
    if payload.get("cost_tier") not in _COST_TIERS:
        raise ValueError("agent_card.cost_tier must be one of low|medium|high|variable")

    input_contracts = payload.get("input_contracts")
    output_contracts = payload.get("output_contracts")
    if not isinstance(input_contracts, list) or not isinstance(output_contracts, list):
        raise ValueError("agent_card input_contracts/output_contracts must be arrays")

    def _validate_contracts(items: list[Any], label: str) -> set[str]:
        ids: set[str] = set()
        for idx, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f"{label}[{idx}] must be an object")
            extra_keys = sorted(set(item) - _CONTRACT_KEYS)
            if extra_keys:
                raise ValueError(f"{label}[{idx}] has unexpected keys: {extra_keys}")
            contract_id = _non_empty_string(item.get("contract_id"), f"{label}[{idx}].contract_id")
            if contract_id in ids:
                raise ValueError(f"{label} contains duplicate contract_id: {contract_id}")
            ids.add(contract_id)
            if item.get("format") not in _CONTRACT_FORMATS:
                raise ValueError(f"{label}[{idx}].format must be one of {_CONTRACT_FORMATS}")
            _non_empty_string(item.get("description"), f"{label}[{idx}].description")
            if "source_path" in item:
                _non_empty_string(item.get("source_path"), f"{label}[{idx}].source_path")
        return ids

    input_ids = _validate_contracts(input_contracts, "agent_card.input_contracts")
    output_ids = _validate_contracts(output_contracts, "agent_card.output_contracts")

    capabilities = payload.get("capabilities")
    if not isinstance(capabilities, list) or not capabilities:
        raise ValueError("agent_card.capabilities must be a non-empty array")
    seen_capabilities: set[str] = set()
    for idx, item in enumerate(capabilities):
        if not isinstance(item, dict):
            raise ValueError(f"agent_card.capabilities[{idx}] must be an object")
        extra_keys = sorted(set(item) - _CAPABILITY_KEYS)
        if extra_keys:
            raise ValueError(f"agent_card.capabilities[{idx}] has unexpected keys: {extra_keys}")
        capability_id = _non_empty_string(item.get("capability_id"), f"agent_card.capabilities[{idx}].capability_id")
        if capability_id in seen_capabilities:
            raise ValueError(f"agent_card contains duplicate capability_id: {capability_id}")
        seen_capabilities.add(capability_id)
        _non_empty_string(item.get("description"), f"agent_card.capabilities[{idx}].description")
        for contract_ids, known_ids, label in [
            (item.get("input_contract_ids"), input_ids, "input_contract_ids"),
            (item.get("output_contract_ids"), output_ids, "output_contract_ids"),
        ]:
            if not isinstance(contract_ids, list):
                raise ValueError(f"agent_card.capabilities[{idx}].{label} must be an array")
            for contract_id in contract_ids:
                text = _non_empty_string(contract_id, f"agent_card.capabilities[{idx}].{label}[]")
                if text not in known_ids:
                    raise ValueError(f"agent_card.capabilities[{idx}].{label} references unknown contract_id: {text}")
    return payload


def validate_agent_message(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("agent_message must be a JSON object")
    extra = sorted(set(payload) - _MESSAGE_KEYS)
    if extra:
        raise ValueError(f"agent_message has unexpected keys: {extra}")
    if int(payload.get("schema_version") or 0) != 1:
        raise ValueError("agent_message.schema_version must be integer const 1")
    _non_empty_string(payload.get("message_id"), "agent_message.message_id")
    trace_id = _uuid_string(payload.get("trace_id"), "agent_message.trace_id")
    run_id = _string_or_none(payload.get("run_id"), "agent_message.run_id")
    _non_empty_string(payload.get("source_agent_id"), "agent_message.source_agent_id")
    _non_empty_string(payload.get("target_agent_id"), "agent_message.target_agent_id")
    kind = payload.get("message_kind")
    if kind not in _MESSAGE_KINDS:
        raise ValueError("agent_message.message_kind must be one of request|response|error")
    _non_empty_string(payload.get("requested_capability"), "agent_message.requested_capability")
    if kind == "error":
        if "payload" in payload:
            raise ValueError("agent_message.error must not include payload")
        envelope = payload.get("error")
        if not isinstance(envelope, dict):
            raise ValueError("agent_message.error must include an ERR-01 envelope")
        extra_keys = sorted(set(envelope) - _ENVELOPE_KEYS)
        if extra_keys:
            raise ValueError(f"agent_message.error has unexpected keys: {extra_keys}")
        _non_empty_string(envelope.get("domain"), "agent_message.error.domain")
        _non_empty_string(envelope.get("code"), "agent_message.error.code")
        _non_empty_string(envelope.get("message"), "agent_message.error.message")
        if not isinstance(envelope.get("retryable"), bool):
            raise ValueError("agent_message.error.retryable must be boolean")
        if _string_or_none(envelope.get("run_id"), "agent_message.error.run_id") != run_id:
            raise ValueError("agent_message.error.run_id must match agent_message.run_id")
        if _uuid_string(envelope.get("trace_id"), "agent_message.error.trace_id") != trace_id:
            raise ValueError("agent_message.error.trace_id must match agent_message.trace_id")
        data = envelope.get("data")
        if data is not None and not isinstance(data, dict):
            raise ValueError("agent_message.error.data must be an object or null")
    else:
        if "error" in payload:
            raise ValueError("agent_message.request/response must not include error")
        if "payload" not in payload or not isinstance(payload.get("payload"), dict):
            raise ValueError("agent_message.request/response must include payload object")
    return payload
