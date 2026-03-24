from __future__ import annotations

import pathlib
from typing import Any

from .contracts import load_json


def validate_manifest_alignment(
    package_data_by_id: dict[str, dict[str, Any]],
    *,
    manifest_path: pathlib.Path,
    explicit_manifest_path: bool,
) -> tuple[list[str], list[str]]:
    errs: list[str] = []
    warns: list[str] = []
    if not manifest_path.exists():
        if explicit_manifest_path:
            errs.append(f"cross-repo check failed: configured manifest path not found: {manifest_path}")
            return errs, warns
        warns.append(f"cross-repo check skipped: sibling manifest not found: {manifest_path}")
        return errs, warns

    try:
        manifest = load_json(manifest_path)
    except RuntimeError as exc:
        errs.append(f"cross-repo check failed to parse manifest: {exc}")
        return errs, warns

    components = manifest.get("components")
    if not isinstance(components, dict):
        errs.append("cross-repo check: manifest.components must be an object")
        return errs, warns

    market_ids = set(package_data_by_id.keys())
    manifest_ids = set(components.keys())
    if market_ids - manifest_ids:
        errs.append(f"cross-repo check: package ids missing in manifest: {sorted(market_ids - manifest_ids)}")
    if manifest_ids - market_ids:
        errs.append(f"cross-repo check: manifest components missing in market index: {sorted(manifest_ids - market_ids)}")

    for package_id in sorted(market_ids & manifest_ids):
        package = package_data_by_id[package_id]
        component = components.get(package_id)
        if not isinstance(component, dict):
            errs.append(f"cross-repo check: manifest component {package_id!r} must be object")
            continue
        for package_key, manifest_key in [
            ("package_type", "type"),
            ("repo", "repo"),
            ("channel", "channel"),
            ("version", "version"),
            ("openrpc", "openrpc"),
            ("source_path", "source_path"),
        ]:
            if package.get(package_key) != component.get(manifest_key):
                if package.get(package_key) is None and component.get(manifest_key) is None:
                    continue
                errs.append(
                    f"cross-repo check: {package_key}/{manifest_key} mismatch for {package_id}: "
                    f"market={package.get(package_key)!r} manifest={component.get(manifest_key)!r}"
                )
    return errs, warns
