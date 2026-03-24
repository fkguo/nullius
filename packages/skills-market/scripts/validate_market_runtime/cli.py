from __future__ import annotations

import datetime as dt
import os
import pathlib
import sys

from .contracts import RE_INDEX_VERSION, load_json, parse_timestamp
from .manifest_alignment import validate_manifest_alignment
from .package_checks import build_constraints_from_schema, validate_package


def main() -> int:
    root = pathlib.Path(__file__).resolve().parents[2]
    pkg_dir = root / "packages"
    schema_path = root / "schemas" / "market-package.schema.json"
    index_path = pkg_dir / "index.json"
    meta_root = pathlib.Path(os.environ.get("AUTORESEARCH_META_ROOT", str(root.parent / "autoresearch-meta"))).expanduser()
    manifest_path = pathlib.Path(
        os.environ.get(
            "AUTORESEARCH_META_MANIFEST",
            str(meta_root / "compatibility-matrix" / "ecosystem-manifest.json"),
        )
    ).expanduser()
    explicit_manifest_path = "AUTORESEARCH_META_ROOT" in os.environ or "AUTORESEARCH_META_MANIFEST" in os.environ

    errs: list[str] = []
    warns: list[str] = []
    if not schema_path.exists():
        print(f"missing schema: {schema_path}", file=sys.stderr)
        return 1
    if not index_path.exists():
        print(f"missing index: {index_path}", file=sys.stderr)
        return 1

    schema = load_json(schema_path)
    index = load_json(index_path)
    required_keys, allowed_types, allowed_channels, allowed_platforms = build_constraints_from_schema(schema)
    allowed_properties = set(schema.get("properties", {}).keys())
    if not (required_keys and allowed_types and allowed_channels and allowed_platforms):
        errs.append("schema missing expected required/enum constraints")

    if not isinstance(index.get("index_version"), str) or not RE_INDEX_VERSION.fullmatch(index["index_version"]):
        errs.append("packages/index.json: index_version must be semver (x.y.z)")
    updated_at = index.get("updated_at")
    if not isinstance(updated_at, str):
        errs.append("packages/index.json: updated_at must be a string")
    else:
        timestamp = parse_timestamp(updated_at)
        if timestamp is None:
            errs.append("packages/index.json: updated_at must be RFC3339/ISO datetime")
        elif timestamp > dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=24):
            warns.append(f"packages/index.json: updated_at is more than 24h in the future: {updated_at}")

    listed = index.get("packages")
    if not isinstance(listed, list) or not listed:
        errs.append("packages/index.json must contain non-empty 'packages' list")
        print("\n".join(errs), file=sys.stderr)
        return 1
    if len(set(listed)) != len(listed):
        errs.append("packages/index.json contains duplicate entries")

    package_data_by_path: dict[pathlib.Path, dict[str, object]] = {}
    package_data_by_id: dict[str, dict[str, object]] = {}
    package_versions: dict[str, str] = {}
    for rel in listed:
        if not isinstance(rel, str):
            errs.append(f"index entry must be string, got: {type(rel).__name__}")
            continue
        path = (pkg_dir / rel).resolve()
        try:
            path.relative_to(pkg_dir.resolve())
        except Exception:
            errs.append(f"index entry escapes packages dir: {rel}")
            continue
        if not path.exists():
            errs.append(f"index listed missing file: {rel}")
            continue
        data = load_json(path)
        package_data_by_path[path] = data
        package_id = str(data.get("package_id", ""))
        if package_id:
            if package_id in package_data_by_id:
                errs.append(f"duplicate package_id in index: {package_id}")
            package_data_by_id[package_id] = data
            if isinstance(data.get("version"), str):
                package_versions[package_id] = str(data["version"])

    for path, data in package_data_by_path.items():
        errs.extend(
            validate_package(
                path=path,
                data=data,
                required_keys=required_keys,
                allowed_types=allowed_types,
                allowed_channels=allowed_channels,
                allowed_platforms=allowed_platforms,
                package_versions=package_versions,
                allowed_properties=allowed_properties,
            )
        )

    on_disk = {file.name for file in pkg_dir.glob("*.json") if file.name != "index.json"}
    indexed = {pathlib.Path(str(item)).name for item in listed if isinstance(item, str)}
    if on_disk - indexed:
        errs.append(f"package files not in index: {sorted(on_disk - indexed)}")
    if indexed - on_disk:
        errs.append(f"index entries missing on disk: {sorted(indexed - on_disk)}")

    alignment_errs, alignment_warns = validate_manifest_alignment(
        package_data_by_id,
        manifest_path=manifest_path,
        explicit_manifest_path=explicit_manifest_path,
    )
    errs.extend(alignment_errs)
    warns.extend(alignment_warns)
    if errs:
        print("\n".join(errs), file=sys.stderr)
        return 1
    for warning in warns:
        print(f"[warn] {warning}", file=sys.stderr)
    print("[ok] market metadata validation passed")
    return 0
