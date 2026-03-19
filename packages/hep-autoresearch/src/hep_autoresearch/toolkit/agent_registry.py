from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .agent_contracts import validate_agent_card


def builtin_agent_cards_dir() -> Path:
    return Path(__file__).resolve().with_name("agent_cards")


@dataclass(frozen=True)
class AgentRegistry:
    cards_by_id: dict[str, dict[str, Any]]
    dispatchable_agent_ids: frozenset[str]

    def list_agents(self, *, capability: str | None = None, dispatchable_only: bool = False) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        capability_name = str(capability).strip() if capability is not None else None
        for agent_id in sorted(self.cards_by_id):
            card = self.cards_by_id[agent_id]
            available = agent_id in self.dispatchable_agent_ids
            if dispatchable_only and not available:
                continue
            if capability_name and not any(cap.get("capability_id") == capability_name for cap in card.get("capabilities", [])):
                continue
            out.append({"card": card, "available_for_dispatch": available})
        return out

    def get_card(self, agent_id: str) -> dict[str, Any]:
        text = str(agent_id).strip()
        if text not in self.cards_by_id:
            raise KeyError(f"unknown agent_id: {agent_id}")
        return self.cards_by_id[text]

    def resolve_capability(self, capability: str, *, target_agent_id: str | None = None, dispatchable_only: bool = True) -> dict[str, Any]:
        matches = self.list_agents(capability=str(capability), dispatchable_only=dispatchable_only)
        if target_agent_id is not None:
            filtered = [entry for entry in matches if entry["card"].get("agent_id") == str(target_agent_id).strip()]
            if not filtered:
                raise KeyError(f"no dispatchable agent for capability {capability!r} and target {target_agent_id!r}")
            return filtered[0]
        if not matches:
            raise KeyError(f"no dispatchable agent for capability: {capability}")
        if len(matches) > 1:
            ids = [entry["card"]["agent_id"] for entry in matches]
            raise RuntimeError(f"capability {capability!r} is ambiguous across dispatchable agents: {ids}")
        return matches[0]


def load_agent_registry(*, cards_dir: Path | None = None, dispatchable_agent_ids: set[str] | frozenset[str] | None = None) -> AgentRegistry:
    root = cards_dir or builtin_agent_cards_dir()
    cards_by_id: dict[str, dict[str, Any]] = {}
    for path in sorted(root.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        card = validate_agent_card(payload)
        agent_id = str(card["agent_id"])
        if agent_id in cards_by_id:
            raise RuntimeError(f"duplicate agent_id in registry: {agent_id}")
        cards_by_id[agent_id] = card
    if not cards_by_id:
        raise RuntimeError(f"no agent cards found in registry directory: {root}")
    dispatchable = frozenset(str(value).strip() for value in (dispatchable_agent_ids or frozenset()) if str(value).strip())
    unknown = sorted(dispatchable - frozenset(cards_by_id))
    if unknown:
        raise RuntimeError(f"dispatchable agent ids missing agent cards: {unknown}")
    return AgentRegistry(cards_by_id=cards_by_id, dispatchable_agent_ids=dispatchable)
