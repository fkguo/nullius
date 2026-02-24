#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import re
import sys
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
PKG_DIR = ROOT / "packages"
SCHEMA_PATH = ROOT / "schemas" / "market-package.schema.json"
INDEX_PATH = PKG_DIR / "index.json"
DEFAULT_META_ROOT = ROOT.parent / "autoresearch-meta"
META_ROOT = pathlib.Path(os.environ.get("AUTORESEARCH_META_ROOT", str(DEFAULT_META_ROOT))).expanduser()
META_MANIFEST_PATH = pathlib.Path(
    os.environ.get(
        "AUTORESEARCH_META_MANIFEST",
        str(META_ROOT / "compatibility-matrix" / "ecosystem-manifest.json"),
    )
).expanduser()
EXPLICIT_META_PATH = "AUTORESEARCH_META_ROOT" in os.environ or "AUTORESEARCH_META_MANIFEST" in os.environ

ALLOWED_PLATFORMS = {"claude_code", "codex", "opencode"}
RE_VERSION = re.compile(r"^(v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.]+)?|schemas-v[0-9]+\.[0-9]+\.[0-9]+)$")
RE_INDEX_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
RE_PACKAGE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
RE_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RE_RANGE = re.compile(r"^>=?[0-9]+\.[0-9]+\.[0-9]+(?:\s+<[=]?[0-9]+\.[0-9]+\.[0-9]+)?$")
RE_SEMVER = re.compile(r"^(?:schemas-)?v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][A-Za-z0-9.]+)?$")
RE_NON_PORTABLE_SOURCE = re.compile(r"^(?:/Users/|/home/|[A-Za-z]:\\Users\\)")
# Keep "~" literal here because source_path metadata is normalized to "~/.codex/skills/...".
RE_SKILL_SOURCE_PATH = re.compile(r"^~/\.codex/skills/[A-Za-z0-9_.-]+/SKILL\.md$")
RE_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
RE_SOURCE_REF = re.compile(r"^(?!/)(?!.*\.\.)(?!.*//)[A-Za-z0-9._/-]+$")


def is_safe_relative_path(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    if text.startswith("/") or text.startswith("\\") or RE_WINDOWS_DRIVE.match(text):
        return False
    if "\\" in text:
        return False
    parts = pathlib.PurePosixPath(text).parts
    if any(part == ".." for part in parts):
        return False
    return True


def is_safe_glob_pattern(value: str) -> bool:
    text = value.strip()
    if not is_safe_relative_path(text):
        return False
    # Keep patterns portable and predictable for installer-side globbing.
    if "//" in text:
        return False
    return True


def load_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Invalid JSON: {path}: {exc}") from exc


def parse_timestamp(value: str) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def build_constraints_from_schema(schema: dict[str, Any]) -> tuple[set[str], set[str], set[str], set[str]]:
    required = set(schema.get("required", []))
    props = schema.get("properties", {})
    types = set(props.get("package_type", {}).get("enum", []))
    channels = set(props.get("channel", {}).get("enum", []))
    platforms = set(props.get("platforms", {}).get("items", {}).get("enum", []))
    return required, types, channels, platforms


def parse_semver(value: str) -> tuple[int, int, int] | None:
    m = RE_SEMVER.fullmatch(value)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def parse_bound(token: str) -> tuple[str, tuple[int, int, int]] | None:
    for op in (">=", ">", "<=", "<"):
        if token.startswith(op):
            ver = parse_semver(token[len(op) :])
            if ver is None:
                return None
            return op, ver
    return None


def satisfies_range(version: str, dep_range: str) -> bool | None:
    parsed = parse_semver(version)
    if parsed is None:
        return None

    for token in dep_range.split():
        bound = parse_bound(token)
        if bound is None:
            return None
        op, edge = bound
        if op == ">=" and not (parsed >= edge):
            return False
        if op == ">" and not (parsed > edge):
            return False
        if op == "<=" and not (parsed <= edge):
            return False
        if op == "<" and not (parsed < edge):
            return False

    return True


def validate_package(
    *,
    path: pathlib.Path,
    data: dict[str, Any],
    required_keys: set[str],
    allowed_types: set[str],
    allowed_channels: set[str],
    allowed_platforms: set[str],
    package_versions: dict[str, str],
    allowed_properties: set[str],
) -> list[str]:
    errs: list[str] = []

    extra = set(data) - allowed_properties
    if extra:
        errs.append(f"{path.name}: unknown keys not allowed by schema: {sorted(extra)}")

    missing = required_keys - set(data)
    if missing:
        errs.append(f"{path.name}: missing keys: {sorted(missing)}")

    package_id = str(data.get("package_id", ""))
    if not package_id:
        errs.append(f"{path.name}: package_id must be non-empty")
    elif not RE_PACKAGE_ID.fullmatch(package_id):
        errs.append(f"{path.name}: package_id must match ^[A-Za-z0-9_.-]+$")
    elif path.stem != package_id:
        errs.append(f"{path.name}: filename stem must equal package_id ({package_id})")

    package_type = data.get("package_type")
    if package_type not in allowed_types:
        errs.append(f"{path.name}: invalid package_type")

    if data.get("channel") not in allowed_channels:
        errs.append(f"{path.name}: invalid channel")

    summary = data.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        errs.append(f"{path.name}: summary must be a non-empty string")

    openrpc = data.get("openrpc")
    if openrpc is not None and (not isinstance(openrpc, str) or not openrpc.strip()):
        errs.append(f"{path.name}: openrpc must be a non-empty string when present")

    plats = data.get("platforms")
    if not isinstance(plats, list) or not plats:
        errs.append(f"{path.name}: platforms must be non-empty list")
    else:
        bad = [p for p in plats if p not in allowed_platforms]
        if bad:
            errs.append(f"{path.name}: invalid platforms: {bad}")

    repo = str(data.get("repo", ""))
    if not RE_REPO.fullmatch(repo):
        errs.append(f"{path.name}: repo must be owner/name")

    version = str(data.get("version", ""))
    if not version or not RE_VERSION.fullmatch(version):
        errs.append(f"{path.name}: version format is invalid")

    depends_on = data.get("depends_on", {})
    if depends_on is not None:
        if not isinstance(depends_on, dict):
            errs.append(f"{path.name}: depends_on must be object when present")
        else:
            for dep_id, dep_range in depends_on.items():
                if dep_id not in package_versions:
                    errs.append(f"{path.name}: depends_on references unknown package_id: {dep_id}")
                if not isinstance(dep_range, str) or not RE_RANGE.fullmatch(dep_range):
                    errs.append(f"{path.name}: depends_on range must match '>=x.y.z <a.b.c': {dep_id}={dep_range!r}")
                    continue

                dep_version = package_versions.get(dep_id)
                if dep_version:
                    satisfied = satisfies_range(dep_version, dep_range)
                    if satisfied is False:
                        errs.append(
                            f"{path.name}: depends_on range does not match {dep_id} version {dep_version!r}: {dep_range!r}"
                        )

    source_path = data.get("source_path")
    if package_type == "skill-pack" and source_path is None:
        errs.append(f"{path.name}: source_path is required for package_type=skill-pack")

    if source_path is not None:
        if not isinstance(source_path, str) or not source_path.strip():
            errs.append(f"{path.name}: source_path must be a non-empty string when present")
        else:
            normalized = source_path.strip()
            if RE_NON_PORTABLE_SOURCE.match(normalized):
                errs.append(f"{path.name}: source_path must not use host-specific absolute user path: {normalized!r}")
            if package_type == "skill-pack" and not RE_SKILL_SOURCE_PATH.fullmatch(normalized):
                errs.append(
                    f"{path.name}: source_path for skill-pack must match '~/.codex/skills/<name>/SKILL.md', got {normalized!r}"
                )

    install = data.get("install")
    if install is not None:
        if not isinstance(install, dict):
            errs.append(f"{path.name}: install must be object when present")
        else:
            bad_keys = sorted(set(install.keys()) - allowed_platforms)
            if bad_keys:
                errs.append(f"{path.name}: install contains unsupported keys: {bad_keys}")
            for k, v in install.items():
                if not isinstance(v, str) or not v.strip():
                    errs.append(f"{path.name}: install.{k} must be a non-empty string")

    source = data.get("source")
    if package_type == "skill-pack" and source is None:
        errs.append(f"{path.name}: source is required for package_type=skill-pack")
    if source is not None:
        if not isinstance(source, dict):
            errs.append(f"{path.name}: source must be object when present")
        else:
            allowed_source_keys = {"repo", "ref", "subpath", "include", "exclude"}
            extra_source_keys = sorted(set(source.keys()) - allowed_source_keys)
            if extra_source_keys:
                errs.append(f"{path.name}: source has unsupported keys: {extra_source_keys}")

            source_repo = source.get("repo")
            if not isinstance(source_repo, str) or not RE_REPO.fullmatch(source_repo):
                errs.append(f"{path.name}: source.repo must be owner/name")

            source_ref = source.get("ref")
            if not isinstance(source_ref, str) or not source_ref.strip():
                errs.append(f"{path.name}: source.ref must be a non-empty string")
            elif not RE_SOURCE_REF.fullmatch(source_ref.strip()):
                errs.append(
                    f"{path.name}: source.ref must match ^[A-Za-z0-9._/-]+$, got {source_ref!r}"
                )

            source_subpath = source.get("subpath")
            if not isinstance(source_subpath, str) or not source_subpath.strip():
                errs.append(f"{path.name}: source.subpath must be a non-empty string")
            else:
                normalized_subpath = source_subpath.strip()
                if not is_safe_relative_path(normalized_subpath):
                    errs.append(
                        f"{path.name}: source.subpath must be a safe relative path (no absolute, backslash, drive-letter, or '..'): {normalized_subpath!r}"
                    )

            include = source.get("include")
            if not isinstance(include, list) or not include:
                errs.append(f"{path.name}: source.include must be a non-empty list")
            else:
                normalized_include: list[str] = []
                for idx, pat in enumerate(include):
                    if not isinstance(pat, str) or not pat.strip():
                        errs.append(f"{path.name}: source.include[{idx}] must be a non-empty string")
                        continue
                    normalized_pat = pat.strip()
                    normalized_include.append(normalized_pat)
                    if not is_safe_glob_pattern(normalized_pat):
                        errs.append(f"{path.name}: source.include[{idx}] must be a safe relative glob pattern: {pat!r}")
                if package_type == "skill-pack" and "SKILL.md" not in normalized_include:
                    errs.append(f"{path.name}: source.include must explicitly include 'SKILL.md' for skill-pack")

            exclude = source.get("exclude")
            if exclude is not None:
                if not isinstance(exclude, list):
                    errs.append(f"{path.name}: source.exclude must be a list when present")
                else:
                    for idx, pat in enumerate(exclude):
                        if not isinstance(pat, str) or not pat.strip():
                            errs.append(f"{path.name}: source.exclude[{idx}] must be a non-empty string")
                            continue
                        if not is_safe_glob_pattern(pat):
                            errs.append(f"{path.name}: source.exclude[{idx}] must be a safe relative glob pattern: {pat!r}")

    return errs


def validate_manifest_alignment(package_data_by_id: dict[str, dict[str, Any]]) -> tuple[list[str], list[str]]:
    errs: list[str] = []
    warns: list[str] = []

    if not META_MANIFEST_PATH.exists():
        if EXPLICIT_META_PATH:
            errs.append(
                f"cross-repo check failed: configured manifest path not found: {META_MANIFEST_PATH}"
            )
            return errs, warns
        warns.append(f"cross-repo check skipped: sibling manifest not found: {META_MANIFEST_PATH}")
        return errs, warns

    try:
        manifest = load_json(META_MANIFEST_PATH)
    except RuntimeError as exc:
        errs.append(f"cross-repo check failed to parse manifest: {exc}")
        return errs, warns

    comps = manifest.get("components")
    if not isinstance(comps, dict):
        errs.append("cross-repo check: manifest.components must be an object")
        return errs, warns

    market_ids = set(package_data_by_id.keys())
    manifest_ids = set(comps.keys())

    only_market = sorted(market_ids - manifest_ids)
    if only_market:
        errs.append(f"cross-repo check: package ids missing in manifest: {only_market}")

    only_manifest = sorted(manifest_ids - market_ids)
    if only_manifest:
        errs.append(f"cross-repo check: manifest components missing in market index: {only_manifest}")

    for pid in sorted(market_ids & manifest_ids):
        package = package_data_by_id[pid]
        component = comps.get(pid)
        if not isinstance(component, dict):
            errs.append(f"cross-repo check: manifest component {pid!r} must be object")
            continue

        pairs = [
            ("package_type", "type"),
            ("repo", "repo"),
            ("channel", "channel"),
            ("version", "version"),
            ("openrpc", "openrpc"),
            ("source_path", "source_path"),
        ]
        for package_key, manifest_key in pairs:
            package_val = package.get(package_key)
            manifest_val = component.get(manifest_key)
            if package_val is None and manifest_val is None:
                continue
            if package_val != manifest_val:
                errs.append(
                    f"cross-repo check: {package_key}/{manifest_key} mismatch for {pid}: "
                    f"market={package_val!r} manifest={manifest_val!r}"
                )

    return errs, warns


def main() -> int:
    errs: list[str] = []
    warns: list[str] = []

    if not SCHEMA_PATH.exists():
        errs.append(f"missing schema: {SCHEMA_PATH}")
        print("\n".join(errs), file=sys.stderr)
        return 1

    schema = load_json(SCHEMA_PATH)
    required_keys, allowed_types, allowed_channels, allowed_platforms = build_constraints_from_schema(schema)
    allowed_properties = set(schema.get("properties", {}).keys())

    if not (required_keys and allowed_types and allowed_channels and allowed_platforms):
        errs.append("schema missing expected required/enum constraints")

    if not INDEX_PATH.exists():
        errs.append(f"missing index: {INDEX_PATH}")
        print("\n".join(errs), file=sys.stderr)
        return 1

    index = load_json(INDEX_PATH)
    index_version = index.get("index_version")
    if not isinstance(index_version, str) or not RE_INDEX_VERSION.fullmatch(index_version):
        errs.append("packages/index.json: index_version must be semver (x.y.z)")

    updated_at = index.get("updated_at")
    if not isinstance(updated_at, str):
        errs.append("packages/index.json: updated_at must be a string")
    else:
        ts = parse_timestamp(updated_at)
        if ts is None:
            errs.append("packages/index.json: updated_at must be RFC3339/ISO datetime")
        elif ts > dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=24):
            warns.append(f"packages/index.json: updated_at is more than 24h in the future: {updated_at}")

    listed = index.get("packages", [])
    if not isinstance(listed, list) or not listed:
        errs.append("packages/index.json must contain non-empty 'packages' list")
        print("\n".join(errs), file=sys.stderr)
        return 1

    if len(set(listed)) != len(listed):
        errs.append("packages/index.json contains duplicate entries")

    package_data_by_path: dict[pathlib.Path, dict[str, Any]] = {}
    package_data_by_id: dict[str, dict[str, Any]] = {}
    package_versions: dict[str, str] = {}

    for rel in listed:
        if not isinstance(rel, str):
            errs.append(f"index entry must be string, got: {type(rel).__name__}")
            continue

        p = (PKG_DIR / rel).resolve()
        try:
            p.relative_to(PKG_DIR.resolve())
        except Exception:
            errs.append(f"index entry escapes packages dir: {rel}")
            continue

        if not p.exists():
            errs.append(f"index listed missing file: {rel}")
            continue

        data = load_json(p)
        package_data_by_path[p] = data
        package_id = str(data.get("package_id", ""))
        if package_id:
            if package_id in package_data_by_id:
                errs.append(f"duplicate package_id in index: {package_id}")
            package_data_by_id[package_id] = data
            version = data.get("version")
            if isinstance(version, str):
                package_versions[package_id] = version

    for p, data in package_data_by_path.items():
        errs.extend(
            validate_package(
                path=p,
                data=data,
                required_keys=required_keys,
                allowed_types=allowed_types,
                allowed_channels=allowed_channels,
                allowed_platforms=allowed_platforms,
                package_versions=package_versions,
                allowed_properties=allowed_properties,
            )
        )

    on_disk = {f.name for f in PKG_DIR.glob("*.json") if f.name != "index.json"}
    indexed = {pathlib.Path(str(x)).name for x in listed if isinstance(x, str)}

    orphans = sorted(on_disk - indexed)
    if orphans:
        errs.append(f"package files not in index: {orphans}")

    missing_from_disk = sorted(indexed - on_disk)
    if missing_from_disk:
        errs.append(f"index entries missing on disk: {missing_from_disk}")

    cross_errs, cross_warns = validate_manifest_alignment(package_data_by_id)
    errs.extend(cross_errs)
    warns.extend(cross_warns)

    if errs:
        print("\n".join(errs), file=sys.stderr)
        return 1

    for w in warns:
        print(f"[warn] {w}", file=sys.stderr)

    print("[ok] market metadata validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
