from __future__ import annotations

import pathlib
import sys
from typing import Any

from .contracts import load_json

# The generator's projection functions live in scripts/; the validator runtime is
# a subpackage of scripts/, so make the parent importable for the shared logic.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from manifest_components import expected_components  # noqa: E402


def validate_manifest_alignment(
    package_data_by_id: dict[str, dict[str, Any]],
    *,
    manifest_path: pathlib.Path,
    explicit_manifest_path: bool,
) -> tuple[list[str], list[str]]:
    """Check that the manifest ``components`` map equals the catalog projection.

    The manifest is a projection of ``packages/*.json`` (see manifest_components).
    Rather than hand-listing a subset of fields to compare, we regenerate the full
    expected components from the same catalog the manifest is meant to mirror and
    compare per component. This makes ``depends_on`` (and any future component
    field) drift a first-class failure, and points the operator at the generator
    that fixes it deterministically.
    """
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

    expected = expected_components(package_data_by_id)
    expected_ids = set(expected.keys())
    manifest_ids = set(components.keys())

    if expected_ids - manifest_ids:
        errs.append(
            f"cross-repo check: package ids missing in manifest: {sorted(expected_ids - manifest_ids)} "
            "(run `python3 scripts/generate_manifest_components.py --write`)"
        )
    if manifest_ids - expected_ids:
        errs.append(
            f"cross-repo check: manifest components missing in market index: {sorted(manifest_ids - expected_ids)} "
            "(run `python3 scripts/generate_manifest_components.py --write`)"
        )

    for package_id in sorted(expected_ids & manifest_ids):
        component = components.get(package_id)
        if not isinstance(component, dict):
            errs.append(f"cross-repo check: manifest component {package_id!r} must be object")
            continue
        if component != expected[package_id]:
            errs.append(
                f"cross-repo check: manifest component {package_id!r} is stale vs catalog: "
                f"manifest={component!r} expected={expected[package_id]!r} "
                "(run `python3 scripts/generate_manifest_components.py --write`)"
            )
    return errs, warns
