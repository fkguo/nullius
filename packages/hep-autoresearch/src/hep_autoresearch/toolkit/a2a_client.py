from __future__ import annotations

import json
from typing import Any
from urllib import error, request


def post_jsonrpc(*, url: str, method: str, params: dict[str, Any], auth_token: str, timeout_seconds: float = 10.0) -> tuple[int, dict[str, Any]]:
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": str(method), "params": params}, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        str(url),
        data=payload,
        headers={
            "Authorization": f"Bearer {str(auth_token)}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=float(timeout_seconds)) as resp:
            body = resp.read().decode("utf-8")
            return int(resp.status), json.loads(body)
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        parsed = json.loads(body) if body.strip() else {}
        return int(exc.code), parsed if isinstance(parsed, dict) else {}


def discover_agents(*, url: str, auth_token: str, capability: str | None = None, timeout_seconds: float = 10.0) -> tuple[int, dict[str, Any]]:
    params: dict[str, Any] = {}
    if capability is not None:
        params["capability"] = str(capability)
    return post_jsonrpc(url=url, method="agent.discover", params=params, auth_token=auth_token, timeout_seconds=timeout_seconds)


def get_agent_card(*, url: str, auth_token: str, agent_id: str, timeout_seconds: float = 10.0) -> tuple[int, dict[str, Any]]:
    return post_jsonrpc(
        url=url,
        method="agent.get_card",
        params={"agent_id": str(agent_id)},
        auth_token=auth_token,
        timeout_seconds=timeout_seconds,
    )


def send_agent_message(*, url: str, auth_token: str, message: dict[str, Any], timeout_seconds: float = 10.0) -> tuple[int, dict[str, Any]]:
    return post_jsonrpc(
        url=url,
        method="agent.message",
        params={"message": message},
        auth_token=auth_token,
        timeout_seconds=timeout_seconds,
    )
