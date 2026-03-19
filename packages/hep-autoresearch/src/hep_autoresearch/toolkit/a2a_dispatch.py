from __future__ import annotations

from typing import Any

from .agent_bindings import AgentDispatchContext, call_bound_agent
from .agent_contracts import build_error_envelope, validate_agent_message
from .agent_registry import AgentRegistry


def dispatch_agent_message(
    *,
    registry: AgentRegistry,
    dispatch_context: AgentDispatchContext,
    request_message: dict[str, Any],
) -> dict[str, Any]:
    run_id = request_message.get("run_id") if isinstance(request_message.get("run_id"), str) else None
    trace_id = str(request_message["trace_id"])
    target_agent_id = str(request_message["target_agent_id"])
    capability = str(request_message["requested_capability"])
    try:
        target_entry = registry.resolve_capability(capability, target_agent_id=target_agent_id, dispatchable_only=False)
    except KeyError as exc:
        return _reply_error(
            request_message,
            build_error_envelope(
                domain="hepar",
                code="NOT_FOUND",
                message=str(exc),
                run_id=run_id,
                trace_id=trace_id,
                data={"reason": "agent_not_found"},
            ),
        )
    if not target_entry["available_for_dispatch"]:
        return _reply_error(
            request_message,
            build_error_envelope(
                domain="hepar",
                code="UPSTREAM_ERROR",
                message=f"agent is discovery-only: {target_agent_id}",
                run_id=run_id,
                trace_id=trace_id,
                data={"reason": "binding_unavailable", "agent_id": target_agent_id},
            ),
        )
    ok, payload = call_bound_agent(
        agent_id=target_agent_id,
        capability=capability,
        payload=dict(request_message.get("payload") or {}),
        trace_id=trace_id,
        run_id=run_id,
        context=dispatch_context,
    )
    return _reply_ok(request_message, payload) if ok else _reply_error(request_message, payload)


def _reply_ok(request_message: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    # Reuse the request message_id as the synchronous request/response correlation key.
    return validate_agent_message(
        {
            "schema_version": 1,
            "message_id": request_message["message_id"],
            "trace_id": request_message["trace_id"],
            "run_id": request_message.get("run_id"),
            "source_agent_id": request_message["target_agent_id"],
            "target_agent_id": request_message["source_agent_id"],
            "message_kind": "response",
            "requested_capability": request_message["requested_capability"],
            "payload": payload,
        }
    )


def _reply_error(request_message: dict[str, Any], envelope: dict[str, Any]) -> dict[str, Any]:
    # Reuse the request message_id as the synchronous request/response correlation key.
    return validate_agent_message(
        {
            "schema_version": 1,
            "message_id": request_message["message_id"],
            "trace_id": request_message["trace_id"],
            "run_id": request_message.get("run_id"),
            "source_agent_id": request_message["target_agent_id"],
            "target_agent_id": request_message["source_agent_id"],
            "message_kind": "error",
            "requested_capability": request_message["requested_capability"],
            "error": envelope,
        }
    )
