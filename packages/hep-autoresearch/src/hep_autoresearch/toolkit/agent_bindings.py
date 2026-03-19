from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .agent_contracts import build_error_envelope
from .mcp_config import default_hep_data_dir, load_mcp_server_config, merged_env
from .mcp_stdio_client import McpStdioClient


@dataclass(frozen=True)
class AgentDispatchContext:
    repo_root: Path
    mcp_config_path: Path | None = None
    mcp_server_name: str = "hep-research"
    hep_data_dir: Path | None = None


def dispatchable_agent_ids() -> frozenset[str]:
    return frozenset({"hep-mcp"})


def call_bound_agent(
    *,
    agent_id: str,
    capability: str,
    payload: dict[str, Any],
    trace_id: str,
    run_id: str | None,
    context: AgentDispatchContext,
) -> tuple[bool, dict[str, Any]]:
    if str(agent_id).strip() != "hep-mcp":
        return False, build_error_envelope(
            domain="hepar",
            code="UPSTREAM_ERROR",
            message=f"dispatch binding not enabled for agent: {agent_id}",
            run_id=run_id,
            trace_id=trace_id,
            data={"reason": "binding_unavailable", "agent_id": str(agent_id).strip()},
        )
    return _call_hep_mcp(capability=str(capability).strip(), payload=payload, trace_id=trace_id, run_id=run_id, context=context)


def _call_hep_mcp(
    *,
    capability: str,
    payload: dict[str, Any],
    trace_id: str,
    run_id: str | None,
    context: AgentDispatchContext,
) -> tuple[bool, dict[str, Any]]:
    if capability not in {"mcp.list_tools", "mcp.call_tool"}:
        return False, build_error_envelope(
            domain="hepar",
            code="INVALID_PARAMS",
            message=f"unsupported capability for hep-mcp: {capability}",
            run_id=run_id,
            trace_id=trace_id,
            data={"reason": "unsupported_capability", "capability": capability},
        )
    config_path = context.mcp_config_path or (context.repo_root / ".mcp.json")
    try:
        cfg = load_mcp_server_config(config_path=config_path, server_name=context.mcp_server_name)
        env = merged_env(
            base=os.environ,
            overrides={
                **cfg.env,
                "HEP_DATA_DIR": str((context.hep_data_dir or default_hep_data_dir(repo_root=context.repo_root)).resolve()),
            },
        )
        with McpStdioClient(cfg=cfg, cwd=context.repo_root, env=env) as client:
            client.initialize(client_name="hepar-a2a", client_version="0.0.1")
            if capability == "mcp.list_tools":
                tools = client.list_tools()
                return True, {
                    "tools": [
                        {"name": tool.name, "description": tool.description, "input_schema": tool.input_schema}
                        for tool in tools
                    ]
                }
            tool_name = payload.get("tool_name")
            if not isinstance(tool_name, str) or not tool_name.strip():
                return False, build_error_envelope(
                    domain="hepar",
                    code="INVALID_PARAMS",
                    message="mcp.call_tool requires payload.tool_name",
                    run_id=run_id,
                    trace_id=trace_id,
                    data={"reason": "schema_invalid"},
                )
            arguments = payload.get("arguments", {})
            if arguments is None:
                arguments = {}
            if not isinstance(arguments, dict):
                return False, build_error_envelope(
                    domain="hepar",
                    code="INVALID_PARAMS",
                    message="mcp.call_tool payload.arguments must be an object",
                    run_id=run_id,
                    trace_id=trace_id,
                    data={"reason": "schema_invalid"},
                )
            result = client.call_tool_json(tool_name=tool_name.strip(), arguments=arguments)
            if result.is_error:
                return False, build_error_envelope(
                    domain="hep-mcp",
                    code=result.error_code or "UPSTREAM_ERROR",
                    message=f"MCP tool call failed: {tool_name.strip()}",
                    run_id=run_id,
                    trace_id=trace_id,
                    data={"raw_text": result.raw_text, "result_json": result.json, "tool_name": tool_name.strip()},
                )
            return True, {
                "tool_name": tool_name.strip(),
                "ok": result.ok,
                "is_error": result.is_error,
                "raw_text": result.raw_text,
                "result_json": result.json,
                "trace_id": result.trace_id,
            }
    except FileNotFoundError as exc:
        return False, build_error_envelope(
            domain="hepar",
            code="NOT_FOUND",
            message=f"MCP config or executable not found for agent binding: {exc}",
            run_id=run_id,
            trace_id=trace_id,
            data={"reason": "binding_not_found", "config_path": str(config_path)},
        )
    except KeyError as exc:
        return False, build_error_envelope(
            domain="hepar",
            code="NOT_FOUND",
            message=str(exc),
            run_id=run_id,
            trace_id=trace_id,
            data={"reason": "binding_not_found", "config_path": str(config_path)},
        )
    except Exception as exc:
        return False, build_error_envelope(
            domain="hepar",
            code="UPSTREAM_ERROR",
            message=f"agent binding failed: {exc}",
            run_id=run_id,
            trace_id=trace_id,
            data={"reason": "binding_failed", "agent_id": "hep-mcp", "capability": capability},
        )
