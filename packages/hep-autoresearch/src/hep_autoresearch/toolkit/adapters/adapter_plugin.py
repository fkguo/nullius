from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .base import Adapter


RunCardFactory = Callable[[str, str, dict[str, Any]], dict[str, Any]]
AdapterFactory = Callable[[], Adapter]


@dataclass(frozen=True)
class AdapterPlugin:
    plugin_id: str
    workflow_ids: tuple[str, ...]
    adapter_factory: AdapterFactory
    default_run_card_factory: RunCardFactory

    def create_adapter(self) -> Adapter:
        return self.adapter_factory()

    def build_default_run_card(self, *, workflow_id: str, run_id: str, state: dict[str, Any]) -> dict[str, Any]:
        return self.default_run_card_factory(workflow_id, run_id, state)
