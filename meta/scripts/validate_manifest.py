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
MATRIX_DIR = ROOT / "compatibility-matrix"
MANIFEST = MATRIX_DIR / "ecosystem-manifest.json"
SCHEMA = MATRIX_DIR / "ecosystem-manifest.schema.json"
DEFAULT_MARKET_ROOT = ROOT.parent / "skills-market"
MARKET_ROOT = pathlib.Path(os.environ.get("SKILLS_MARKET_ROOT", str(DEFAULT_MARKET_ROOT))).expanduser()
MARKET_PACKAGES_DIR = pathlib.Path(
    os.environ.get("SKILLS_MARKET_PACKAGES_DIR", str(MARKET_ROOT / "packages"))
).expanduser()
MARKET_INDEX = pathlib.Path(
    os.environ.get("SKILLS_MARKET_INDEX", str(MARKET_PACKAGES_DIR / "index.json"))
).expanduser()
EXPLICIT_MARKET_PATH = (
    "SKILLS_MARKET_ROOT" in os.environ
    or "SKILLS_MARKET_PACKAGES_DIR" in os.environ
    or "SKILLS_MARKET_INDEX" in os.environ
)

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RE_MANIFEST_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
RE_VERSION = re.compile(r"^(v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.]+)?|schemas-v[0-9]+\.[0-9]+\.[0-9]+)$")
RE_RANGE = re.compile(r"^>=?[0-9]+\.[0-9]+\.[0-9]+(?:\s+<[=]?[0-9]+\.[0-9]+\.[0-9]+)?$")
RE_SEMVER = re.compile(r"^(?:schemas-)?v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][A-Za-z0-9.]+)?$")
RE_NON_PORTABLE_SOURCE = re.compile(r"^(?:/Users/|/home/|[A-Za-z]:\\Users\\)")
# Keep "~" literal here because source_path metadata is normalized to "~/.codex/skills/...".
RE_SKILL_SOURCE_PATH = re.compile(r"^~/\.codex/skills/[A-Za-z0-9_.-]+/SKILL\.md$")


def load_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"invalid JSON ({path}): {exc}") from exc


def parse_timestamp(value: str) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


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


def validate_cross_repo(manifest_components: dict[str, Any]) -> tuple[list[str], list[str]]:
    errs: list[str] = []
    warns: list[str] = []

    if not MARKET_INDEX.exists():
        if EXPLICIT_MARKET_PATH:
            errs.append(f"cross-repo check failed: configured market index not found: {MARKET_INDEX}")
            return errs, warns
        warns.append(f"cross-repo check skipped: sibling market index not found: {MARKET_INDEX}")
        return errs, warns

    try:
        market_index = load_json(MARKET_INDEX)
    except RuntimeError as exc:
        errs.append(f"cross-repo check failed to parse market index: {exc}")
        return errs, warns

    listed = market_index.get("packages")
    if not isinstance(listed, list):
        errs.append("cross-repo check: skills-market packages/index.json must contain list field 'packages'")
        return errs, warns

    market_packages: dict[str, dict[str, Any]] = {}

    for rel in listed:
        if not isinstance(rel, str):
            errs.append(f"cross-repo check: market index entry must be string, got {type(rel).__name__}")
            continue
        p = (MARKET_PACKAGES_DIR / rel).resolve()
        try:
            p.relative_to(MARKET_PACKAGES_DIR.resolve())
        except Exception:
            errs.append(f"cross-repo check: market index entry escapes packages dir: {rel}")
            continue
        if not p.exists():
            errs.append(f"cross-repo check: market index listed missing file: {rel}")
            continue

        try:
            pkg = load_json(p)
        except RuntimeError as exc:
            errs.append(f"cross-repo check failed to parse package {rel}: {exc}")
            continue

        pid = pkg.get("package_id")
        if not isinstance(pid, str) or not pid:
            errs.append(f"cross-repo check: package {rel} has invalid package_id")
            continue

        market_packages[pid] = pkg

    manifest_ids = set(manifest_components.keys())
    market_ids = set(market_packages.keys())

    only_manifest = sorted(manifest_ids - market_ids)
    if only_manifest:
        errs.append(f"cross-repo check: manifest components missing in market index: {only_manifest}")

    only_market = sorted(market_ids - manifest_ids)
    if only_market:
        errs.append(f"cross-repo check: market package ids missing in manifest: {only_market}")

    for pid in sorted(manifest_ids & market_ids):
        comp = manifest_components.get(pid)
        pkg = market_packages.get(pid)
        if not isinstance(comp, dict) or not isinstance(pkg, dict):
            continue

        pairs = [
            ("type", "package_type"),
            ("repo", "repo"),
            ("channel", "channel"),
            ("version", "version"),
            ("openrpc", "openrpc"),
            ("source_path", "source_path"),
        ]
        for manifest_key, package_key in pairs:
            comp_val = comp.get(manifest_key)
            pkg_val = pkg.get(package_key)
            if comp_val is None and pkg_val is None:
                continue
            if comp_val != pkg_val:
                errs.append(
                    f"cross-repo check: {manifest_key}/{package_key} mismatch for {pid}: "
                    f"manifest={comp_val!r} market={pkg_val!r}"
                )

    return errs, warns


def main() -> int:
    errs: list[str] = []
    warns: list[str] = []

    if not MANIFEST.exists():
        print(f"missing manifest: {MANIFEST}", file=sys.stderr)
        return 1
    if not SCHEMA.exists():
        print(f"missing schema: {SCHEMA}", file=sys.stderr)
        return 1

    try:
        data = load_json(MANIFEST)
        schema = load_json(SCHEMA)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    required_top = set(schema.get("required", []))
    missing = required_top - set(data)
    if missing:
        errs.append(f"missing top-level keys: {sorted(missing)}")

    manifest_version = data.get("manifest_version")
    if not isinstance(manifest_version, str) or not RE_MANIFEST_VERSION.fullmatch(manifest_version):
        errs.append("manifest_version must be semver (x.y.z)")

    org = data.get("org")
    if not isinstance(org, str) or not org.strip():
        errs.append("org must be a non-empty string")

    allowed_channels = set(
        schema.get("properties", {})
        .get("channels", {})
        .get("items", {})
        .get("enum", [])
    )

    channels = data.get("channels")
    if not isinstance(channels, list) or len(channels) != len(allowed_channels):
        errs.append("channels must be a unique 3-item list")
    else:
        if len(set(channels)) != len(channels):
            errs.append("channels contains duplicates")
        if set(channels) != allowed_channels:
            errs.append(f"channels must be exactly: {sorted(allowed_channels)}")

    updated_at = data.get("updated_at")
    if not isinstance(updated_at, str):
        errs.append("updated_at must be a string")
    else:
        ts = parse_timestamp(updated_at)
        if ts is None:
            errs.append("updated_at must be valid RFC3339/ISO datetime")
        elif ts > dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=24):
            warns.append(f"updated_at is more than 24h in the future: {updated_at}")

    component_schema = (
        schema.get("properties", {})
        .get("components", {})
        .get("additionalProperties", {})
    )
    required_component_keys = set(component_schema.get("required", []))
    allowed_component_keys = set(component_schema.get("properties", {}).keys())
    allowed_types = set(component_schema.get("properties", {}).get("type", {}).get("enum", []))

    comps = data.get("components")
    if not isinstance(comps, dict) or not comps:
        errs.append("components must be a non-empty object")
        comps = {}

    component_names = set(comps.keys())
    component_versions: dict[str, str] = {}

    for name, meta in comps.items():
        if not isinstance(meta, dict):
            errs.append(f"component {name}: must be object")
            continue

        extra = set(meta) - allowed_component_keys
        if extra:
            errs.append(f"component {name}: unknown keys not allowed by schema: {sorted(extra)}")

        need = required_component_keys - set(meta)
        if need:
            errs.append(f"component {name}: missing keys {sorted(need)}")

        ctype = meta.get("type")
        if ctype not in allowed_types:
            errs.append(f"component {name}: invalid type {ctype!r}")

        channel = meta.get("channel")
        if channel not in allowed_channels:
            errs.append(f"component {name}: invalid channel {channel!r}")

        repo = str(meta.get("repo", ""))
        if not REPO_RE.fullmatch(repo):
            errs.append(f"component {name}: repo must match owner/name")

        version = str(meta.get("version", ""))
        if not RE_VERSION.fullmatch(version):
            errs.append(f"component {name}: invalid version format: {version!r}")
        else:
            component_versions[name] = version

        openrpc = meta.get("openrpc")
        if openrpc is not None and (not isinstance(openrpc, str) or not openrpc.strip()):
            errs.append(f"component {name}: openrpc must be non-empty string when present")

        source_path = meta.get("source_path")
        if ctype == "skill-pack" and source_path is None:
            errs.append(f"component {name}: source_path is required for type=skill-pack")
        if source_path is not None:
            if not isinstance(source_path, str) or not source_path.strip():
                errs.append(f"component {name}: source_path must be non-empty string when present")
            else:
                normalized = source_path.strip()
                if RE_NON_PORTABLE_SOURCE.match(normalized):
                    errs.append(f"component {name}: source_path must not use host-specific absolute user path: {normalized!r}")
                if ctype == "skill-pack" and not RE_SKILL_SOURCE_PATH.fullmatch(normalized):
                    errs.append(
                        f"component {name}: source_path for skill-pack must match '~/.codex/skills/<name>/SKILL.md', got {normalized!r}"
                    )

    for name, meta in comps.items():
        if not isinstance(meta, dict):
            continue

        depends_on = meta.get("depends_on")
        if depends_on is not None:
            if not isinstance(depends_on, dict):
                errs.append(f"component {name}: depends_on must be object when present")
                continue

            for dep_name, dep_range in depends_on.items():
                if dep_name not in component_names:
                    errs.append(f"component {name}: depends_on unknown component: {dep_name}")
                    continue

                if not isinstance(dep_range, str) or not RE_RANGE.fullmatch(dep_range):
                    errs.append(
                        f"component {name}: depends_on range must match '>=x.y.z <a.b.c': {dep_name}={dep_range!r}"
                    )
                    continue

                dep_version = component_versions.get(dep_name)
                if dep_version:
                    satisfied = satisfies_range(dep_version, dep_range)
                    if satisfied is False:
                        errs.append(
                            f"component {name}: depends_on range does not match {dep_name} version {dep_version!r}: {dep_range!r}"
                        )

    plats = data.get("platforms")
    if not isinstance(plats, dict):
        errs.append("platforms must be an object")
        plats = {}

    for p in ["claude_code", "codex", "opencode"]:
        if p not in plats:
            errs.append(f"platforms missing key: {p}")
            continue
        install_mode = plats[p].get("install_mode") if isinstance(plats[p], dict) else None
        if not isinstance(install_mode, str) or not install_mode.strip():
            errs.append(f"platform {p}: install_mode must be non-empty string")

    cross_errs, cross_warns = validate_cross_repo(comps)
    errs.extend(cross_errs)
    warns.extend(cross_warns)

    if errs:
        print("\n".join(errs), file=sys.stderr)
        return 1

    for w in warns:
        print(f"[warn] {w}", file=sys.stderr)

    print("[ok] ecosystem manifest validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
