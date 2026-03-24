from __future__ import annotations

import pathlib
from typing import Any

from .contracts import (
    RE_NON_PORTABLE_SOURCE,
    RE_PACKAGE_ID,
    RE_RANGE,
    RE_REPO,
    RE_SKILL_SOURCE_PATH,
    RE_SOURCE_REF,
    RE_VERSION,
    is_safe_glob_pattern,
    is_safe_relative_path,
    satisfies_range,
)


def build_constraints_from_schema(schema: dict[str, Any]) -> tuple[set[str], set[str], set[str], set[str]]:
    props = schema.get("properties", {})
    return (
        set(schema.get("required", [])),
        set(props.get("package_type", {}).get("enum", [])),
        set(props.get("channel", {}).get("enum", [])),
        set(props.get("platforms", {}).get("items", {}).get("enum", [])),
    )


def _validate_python_runtime(path: pathlib.Path, package_type: Any, runtime: Any) -> list[str]:
    errs: list[str] = []
    if runtime is None:
        return errs
    if package_type != "skill-pack":
        return [f"{path.name}: runtime is only allowed for skill-pack entries"]
    if not isinstance(runtime, dict):
        return [f"{path.name}: runtime must be an object when present"]

    python_runtime = runtime.get("python")
    if not isinstance(python_runtime, dict):
        return [f"{path.name}: runtime.python must be an object"]
    if set(runtime.keys()) != {"python"}:
        errs.append(f"{path.name}: runtime has unsupported keys: {sorted(set(runtime.keys()) - {'python'})}")

    mode = python_runtime.get("mode")
    packages = python_runtime.get("packages")
    if mode != "isolated-venv":
        errs.append(f"{path.name}: runtime.python.mode must be 'isolated-venv'")
    if not isinstance(packages, list):
        errs.append(f"{path.name}: runtime.python.packages must be an array")
    else:
        for idx, item in enumerate(packages):
            if not isinstance(item, str) or not item.strip():
                errs.append(f"{path.name}: runtime.python.packages[{idx}] must be a non-empty string")
    extra_keys = sorted(set(python_runtime.keys()) - {"mode", "packages"})
    if extra_keys:
        errs.append(f"{path.name}: runtime.python has unsupported keys: {extra_keys}")
    return errs


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
    package_type = data.get("package_type")
    if not package_id:
        errs.append(f"{path.name}: package_id must be non-empty")
    elif not RE_PACKAGE_ID.fullmatch(package_id):
        errs.append(f"{path.name}: package_id must match ^[A-Za-z0-9_.-]+$")
    elif path.stem != package_id:
        errs.append(f"{path.name}: filename stem must equal package_id ({package_id})")
    if package_type not in allowed_types:
        errs.append(f"{path.name}: invalid package_type")
    if data.get("channel") not in allowed_channels:
        errs.append(f"{path.name}: invalid channel")
    if not isinstance(data.get("summary"), str) or not str(data.get("summary")).strip():
        errs.append(f"{path.name}: summary must be a non-empty string")
    if data.get("openrpc") is not None and (not isinstance(data.get("openrpc"), str) or not str(data.get("openrpc")).strip()):
        errs.append(f"{path.name}: openrpc must be a non-empty string when present")

    platforms = data.get("platforms")
    if not isinstance(platforms, list) or not platforms:
        errs.append(f"{path.name}: platforms must be non-empty list")
    elif any(platform not in allowed_platforms for platform in platforms):
        errs.append(f"{path.name}: invalid platforms: {[platform for platform in platforms if platform not in allowed_platforms]}")

    repo = str(data.get("repo", ""))
    if not RE_REPO.fullmatch(repo):
        errs.append(f"{path.name}: repo must be owner/name")
    version = str(data.get("version", ""))
    if not RE_VERSION.fullmatch(version):
        errs.append(f"{path.name}: version format is invalid")

    depends_on = data.get("depends_on", {})
    if depends_on is not None:
        if not isinstance(depends_on, dict):
            errs.append(f"{path.name}: depends_on must be object when present")
        else:
            for dep_id, dep_range in depends_on.items():
                if dep_id not in package_versions:
                    errs.append(f"{path.name}: depends_on references unknown package_id: {dep_id}")
                elif not isinstance(dep_range, str) or not RE_RANGE.fullmatch(dep_range):
                    errs.append(f"{path.name}: depends_on range must match '>=x.y.z <a.b.c': {dep_id}={dep_range!r}")
                elif satisfies_range(package_versions[dep_id], dep_range) is False:
                    errs.append(f"{path.name}: depends_on range does not match {dep_id} version {package_versions[dep_id]!r}: {dep_range!r}")

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
                errs.append(f"{path.name}: source_path for skill-pack must match '~/.codex/skills/<name>/SKILL.md', got {normalized!r}")

    install = data.get("install")
    if install is not None:
        if not isinstance(install, dict):
            errs.append(f"{path.name}: install must be object when present")
        else:
            for key, value in install.items():
                if key not in allowed_platforms:
                    errs.append(f"{path.name}: install contains unsupported keys: {sorted(set(install.keys()) - allowed_platforms)}")
                    break
                if not isinstance(value, str) or not value.strip():
                    errs.append(f"{path.name}: install.{key} must be a non-empty string")

    source = data.get("source")
    if package_type == "skill-pack" and source is None:
        errs.append(f"{path.name}: source is required for package_type=skill-pack")
    if source is not None:
        if not isinstance(source, dict):
            errs.append(f"{path.name}: source must be object when present")
        else:
            extras = sorted(set(source.keys()) - {"repo", "ref", "subpath", "include", "exclude"})
            if extras:
                errs.append(f"{path.name}: source has unsupported keys: {extras}")
            if not isinstance(source.get("repo"), str) or not RE_REPO.fullmatch(str(source.get("repo"))):
                errs.append(f"{path.name}: source.repo must be owner/name")
            if not isinstance(source.get("ref"), str) or not RE_SOURCE_REF.fullmatch(str(source.get("ref")).strip()):
                errs.append(f"{path.name}: source.ref must match ^[A-Za-z0-9._/-]+$, got {source.get('ref')!r}")
            if not isinstance(source.get("subpath"), str) or not is_safe_relative_path(str(source.get("subpath"))):
                errs.append(f"{path.name}: source.subpath must be a safe relative path")
            include = source.get("include")
            if not isinstance(include, list) or not include:
                errs.append(f"{path.name}: source.include must be a non-empty list")
            else:
                normalized = [item.strip() for item in include if isinstance(item, str) and item.strip()]
                for idx, item in enumerate(include):
                    if not isinstance(item, str) or not item.strip() or not is_safe_glob_pattern(item.strip()):
                        errs.append(f"{path.name}: source.include[{idx}] must be a safe relative glob pattern: {item!r}")
                if package_type == "skill-pack" and "SKILL.md" not in normalized:
                    errs.append(f"{path.name}: source.include must explicitly include 'SKILL.md' for skill-pack")
            exclude = source.get("exclude")
            if exclude is not None:
                if not isinstance(exclude, list):
                    errs.append(f"{path.name}: source.exclude must be a list when present")
                else:
                    for idx, item in enumerate(exclude):
                        if not isinstance(item, str) or not item.strip() or not is_safe_glob_pattern(item.strip()):
                            errs.append(f"{path.name}: source.exclude[{idx}] must be a safe relative glob pattern: {item!r}")

    errs.extend(_validate_python_runtime(path, package_type, data.get("runtime")))
    return errs
