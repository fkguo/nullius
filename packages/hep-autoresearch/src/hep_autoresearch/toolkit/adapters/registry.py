from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from .adapter_plugin import AdapterPlugin
from .base import Adapter
from .shell_plugin import shell_adapter_plugin


def _registered_plugins(extra_plugins: Iterable[AdapterPlugin] | None = None) -> tuple[AdapterPlugin, ...]:
    return (shell_adapter_plugin(), *(tuple(extra_plugins) if extra_plugins is not None else ()))


def _workflow_plugin_map(extra_plugins: Iterable[AdapterPlugin] | None = None) -> dict[str, AdapterPlugin]:
    workflow_map: dict[str, AdapterPlugin] = {}
    for plugin in _registered_plugins(extra_plugins):
        plugin_id = str(plugin.plugin_id).strip()
        if not plugin_id:
            raise RuntimeError("adapter plugin_id must be non-empty")
        if not plugin.workflow_ids:
            raise RuntimeError(f"adapter plugin {plugin_id} must expose at least one workflow_id")
        for workflow_id in plugin.workflow_ids:
            wid = str(workflow_id).strip()
            if not wid:
                raise RuntimeError(f"adapter plugin {plugin_id} declares an empty workflow_id")
            existing = workflow_map.get(wid)
            if existing is not None:
                raise RuntimeError(
                    f"adapter workflow_id collision: {wid} ({existing.plugin_id} vs {plugin_id})"
                )
            workflow_map[wid] = plugin
    return workflow_map


def adapter_workflow_ids(*, extra_plugins: Iterable[AdapterPlugin] | None = None) -> set[str]:
    return set(_workflow_plugin_map(extra_plugins))


def adapter_for_workflow(workflow_id: str, *, extra_plugins: Iterable[AdapterPlugin] | None = None) -> Adapter:
    wid = str(workflow_id)
    plugin = _workflow_plugin_map(extra_plugins).get(wid)
    if plugin is None:
        raise KeyError(f"unknown adapter workflow_id: {workflow_id}")
    adapter = plugin.create_adapter()
    if not isinstance(adapter, Adapter):
        raise RuntimeError(f"adapter plugin {plugin.plugin_id} returned a non-Adapter instance for workflow_id: {wid}")
    return adapter


def default_run_card_for_workflow(
    *,
    workflow_id: str,
    run_id: str,
    state: dict[str, Any],
    extra_plugins: Iterable[AdapterPlugin] | None = None,
) -> dict[str, Any]:
    wid = str(workflow_id)
    rid = str(run_id)
    plugin = _workflow_plugin_map(extra_plugins).get(wid)
    if plugin is None:
        raise KeyError(f"no default run-card for workflow_id: {workflow_id}")
    run_card = plugin.build_default_run_card(workflow_id=wid, run_id=rid, state=state)
    if not isinstance(run_card, dict):
        raise RuntimeError(f"adapter plugin {plugin.plugin_id} returned a non-object run-card for workflow_id: {wid}")
    if str(run_card.get("workflow_id")) != wid:
        raise RuntimeError(f"adapter plugin {plugin.plugin_id} returned mismatched workflow_id for {wid}")
    if str(run_card.get("run_id")) != rid:
        raise RuntimeError(f"adapter plugin {plugin.plugin_id} returned mismatched run_id for {wid}")
    return run_card


def load_run_card(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("run-card JSON must be an object")
    return payload


def validate_adapter_registry(*, extra_plugins: Iterable[AdapterPlugin] | None = None) -> None:
    missing: list[str] = []
    workflow_map = _workflow_plugin_map(extra_plugins)
    for wid in sorted(workflow_map):
        try:
            adapter = adapter_for_workflow(wid, extra_plugins=extra_plugins)
            run_card = default_run_card_for_workflow(
                workflow_id=wid,
                run_id="REGISTRY-VALIDATION",
                state={},
                extra_plugins=extra_plugins,
            )
            adapter_id = str(run_card.get("adapter_id") or "").strip()
            if not adapter_id:
                raise RuntimeError(f"adapter plugin {workflow_map[wid].plugin_id} returned an empty adapter_id for {wid}")
            if adapter_id != adapter.adapter_id:
                raise RuntimeError(
                    f"adapter plugin {workflow_map[wid].plugin_id} mismatched adapter_id for {wid}: {adapter_id} != {adapter.adapter_id}"
                )
        except Exception as exc:
            missing.append(f"{wid}: {exc}")
    if missing:
        raise RuntimeError(f"adapter registry inconsistency: {', '.join(missing)}")
