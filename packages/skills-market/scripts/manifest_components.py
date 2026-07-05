"""Derive ecosystem-manifest component blocks from the market package catalog.

The market package files under ``packages/*.json`` are the single source of
truth for per-component compatibility metadata (repo / type / channel / version
/ optional openrpc / source_path / depends_on). The ecosystem manifest's
``components`` map is a projection of that catalog and must never be hand-edited
in isolation, or it drifts (as it historically did for ``depends_on``).

This module contains the pure projection functions shared by:
  * the generator CLI (``generate_manifest_components.py``), which rewrites the
    manifest ``components`` block in place while preserving every other manifest
    field, and
  * the market validator's alignment check, which regenerates the expected
    components from the catalog and compares them against the manifest on disk.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

# Manifest component keys, in canonical output order. Keys absent from a given
# market package are simply omitted from that component block (mirroring the
# manifest schema, where only repo/type/channel/version are required).
_COMPONENT_FIELDS: tuple[tuple[str, str], ...] = (
    ("package_type", "type"),
    ("repo", "repo"),
    ("channel", "channel"),
    ("version", "version"),
    ("openrpc", "openrpc"),
    ("source_path", "source_path"),
    ("depends_on", "depends_on"),
)


def component_from_package(package: dict[str, Any]) -> dict[str, Any]:
    """Project one market package dict onto its manifest component block."""
    component: dict[str, Any] = {}
    for package_key, manifest_key in _COMPONENT_FIELDS:
        value = package.get(package_key)
        if value is None:
            continue
        component[manifest_key] = value
    return component


def load_market_packages(packages_dir: pathlib.Path) -> dict[str, dict[str, Any]]:
    """Load every ``packages/*.json`` (except ``index.json``) keyed by package_id."""
    packages: dict[str, dict[str, Any]] = {}
    for path in sorted(packages_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        package_id = data.get("package_id")
        if not isinstance(package_id, str) or not package_id:
            raise RuntimeError(f"package file has no package_id: {path}")
        if package_id in packages:
            raise RuntimeError(f"duplicate package_id across package files: {package_id}")
        packages[package_id] = data
    if not packages:
        raise RuntimeError(f"no market package files found under {packages_dir}")
    return packages


def expected_components(packages: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Build the full expected ``components`` map from the loaded package catalog."""
    return {
        package_id: component_from_package(packages[package_id])
        for package_id in sorted(packages.keys())
    }


def merge_components(manifest: dict[str, Any], components: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Return a copy of ``manifest`` with its ``components`` replaced by ``components``.

    All non-component manifest fields (manifest_version, updated_at, org,
    channels, platforms, ...) are preserved verbatim. Component ordering follows
    the sorted package ids so the generated file is deterministic.
    """
    updated = dict(manifest)
    updated["components"] = components
    return updated
