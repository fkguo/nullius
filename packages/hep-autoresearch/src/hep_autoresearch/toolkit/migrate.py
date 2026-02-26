"""Artifact migration toolkit (M-20).

Detect old-version artifacts under ``.autoresearch/`` and upgrade them
through a declarative migration chain defined in the migration registry.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Migration operations
# ---------------------------------------------------------------------------

def _apply_operation(data: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    """Apply a single migration operation to *data* (mutates in place)."""
    kind = op["op"]
    path = op.get("path", "")

    if kind == "add_field":
        _set_nested(data, path, op["value"])
    elif kind == "remove_field":
        _remove_nested(data, path)
    elif kind == "rename_field":
        from_path = op["from_path"]
        value = _get_nested(data, from_path)
        if value is not _SENTINEL:
            _set_nested(data, path, value)
            _remove_nested(data, from_path)
    elif kind == "set_field":
        _set_nested(data, path, op["value"])
    else:
        raise ValueError(f"unknown migration op: {kind!r}")

    return data


_SENTINEL = object()


def _get_nested(data: dict[str, Any], path: str) -> Any:
    keys = path.split(".")
    current: Any = data
    for key in keys:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return _SENTINEL
    return current


def _set_nested(data: dict[str, Any], path: str, value: Any) -> None:
    keys = path.split(".")
    current: Any = data
    for key in keys[:-1]:
        if key not in current or not isinstance(current[key], dict):
            current[key] = {}
        current = current[key]
    current[keys[-1]] = copy.deepcopy(value) if isinstance(value, (dict, list)) else value


def _remove_nested(data: dict[str, Any], path: str) -> None:
    keys = path.split(".")
    current: Any = data
    for key in keys[:-1]:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return
    if isinstance(current, dict):
        current.pop(keys[-1], None)


# ---------------------------------------------------------------------------
# Registry loading
# ---------------------------------------------------------------------------

MigrationRegistry = dict[str, list[dict[str, Any]]]
"""schema_id → list of migration steps (sorted by from_version)."""


def load_registry(registry_path: Path) -> MigrationRegistry:
    """Load a ``migration_registry_v1`` JSON file and return a lookup dict."""
    raw = json.loads(registry_path.read_text(encoding="utf-8"))
    if raw.get("version") != 1:
        raise ValueError(f"unsupported migration registry version: {raw.get('version')}")

    result: MigrationRegistry = {}
    for chain in raw.get("chains", []):
        schema_id = chain["schema_id"]
        migrations = sorted(chain.get("migrations", []), key=lambda m: m["from_version"])
        result[schema_id] = migrations
    return result


# ---------------------------------------------------------------------------
# Artifact detection
# ---------------------------------------------------------------------------

def detect_old_artifacts(repo_root: Path) -> list[dict[str, Any]]:
    """Scan ``.autoresearch/`` for JSON artifacts and return version metadata.

    Returns a list of dicts: ``{path, schema_version, data}``.
    """
    ar_dir = repo_root / ".autoresearch"
    if not ar_dir.is_dir():
        return []

    results: list[dict[str, Any]] = []
    for json_file in sorted(ar_dir.rglob("*.json")):
        if json_file.name.endswith(".tmp"):
            continue
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(data, dict):
            continue

        schema_version = data.get("schema_version")
        if schema_version is None:
            schema_version = data.get("version")
        if schema_version is not None:
            results.append({
                "path": json_file,
                "schema_version": schema_version,
                "data": data,
            })
    return results


# ---------------------------------------------------------------------------
# Single-artifact migration
# ---------------------------------------------------------------------------

def migrate_artifact(
    data: dict[str, Any],
    schema_id: str,
    registry: MigrationRegistry,
) -> tuple[dict[str, Any], int]:
    """Apply all applicable migration steps to *data*.

    Returns ``(migrated_data, final_version)``.
    The data dict is mutated in place and also returned.
    """
    migrations = registry.get(schema_id, [])
    if not migrations:
        version = data.get("schema_version")
        if version is None:
            version = data.get("version", 0)
        return data, int(version) if isinstance(version, (int, float)) else 0

    current_version = data.get("schema_version")
    if current_version is None:
        current_version = data.get("version", 0)
    if not isinstance(current_version, (int, float)):
        current_version = 0
    current_version = int(current_version)

    for step in migrations:
        if step["from_version"] == current_version:
            for operation in step.get("operations", []):
                _apply_operation(data, operation)
            current_version = step["to_version"]

    if "schema_version" in data:
        data["schema_version"] = current_version
    elif "version" in data:
        data["version"] = current_version

    return data, current_version


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def cmd_migrate(repo_root: Path, *, registry_path: Path | None = None, dry_run: bool = False) -> int:
    """Run ``workspace migrate`` — detect and upgrade old artifacts.

    Returns 0 on success, 1 if any artifact failed to migrate.
    """
    if registry_path is None:
        # Default: look in meta/schemas/ relative to the monorepo root.
        # Walk up from repo_root to find the monorepo root (has meta/ dir).
        candidate = repo_root
        registry_filename = "migration_registry_v1.json"
        for _ in range(10):
            if (candidate / "meta" / "schemas" / registry_filename).exists():
                break
            parent = candidate.parent
            if parent == candidate:
                break
            candidate = parent
        registry_path = candidate / "meta" / "schemas" / registry_filename

    if not registry_path.exists():
        print(f"[migrate] no migration registry at {registry_path}")
        return 0

    registry = load_registry(registry_path)
    artifacts = detect_old_artifacts(repo_root)

    if not artifacts:
        print("[migrate] no versioned artifacts found")
        return 0

    errors = 0
    migrated = 0
    for artifact_info in artifacts:
        artifact_path: Path = artifact_info["path"]
        data: dict[str, Any] = artifact_info["data"]
        old_version = artifact_info["schema_version"]

        # Try to determine schema_id from filename
        schema_id = artifact_path.stem
        if schema_id not in registry:
            continue

        try:
            migrated_data, new_version = migrate_artifact(data, schema_id, registry)
        except Exception as exc:
            print(f"[migrate] FAILED {artifact_path}: {exc}")
            errors += 1
            continue

        if new_version == old_version:
            continue

        if dry_run:
            print(f"[migrate] would upgrade {artifact_path}: v{old_version} → v{new_version}")
        else:
            # Atomic write: .tmp → fsync → rename
            fd, tmp_path = tempfile.mkstemp(
                suffix=".tmp",
                dir=artifact_path.parent,
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(migrated_data, f, indent=2, sort_keys=True)
                    f.write("\n")
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_path, artifact_path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
            print(f"[migrate] upgraded {artifact_path}: v{old_version} → v{new_version}")
        migrated += 1

    print(f"[migrate] done: {migrated} migrated, {errors} errors")
    return 1 if errors > 0 else 0
