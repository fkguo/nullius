from __future__ import annotations

import pathlib
import re
from typing import Any

from market_install_policy import ensure_install_policy as _ensure_install_policy

RE_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RE_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
RE_SOURCE_REF = re.compile(r"^(?!/)(?!.*\.\.)(?!.*//)[A-Za-z0-9._/-]+$")


def platform_root(platform: str, target_root_override: pathlib.Path | None) -> pathlib.Path:
    if target_root_override is not None:
        return target_root_override.expanduser().resolve()
    home = pathlib.Path.home()
    roots = {
        "codex": home / ".codex" / "skills",
        "claude_code": home / ".claude" / "skills",
        "opencode": home / ".config" / "opencode" / "skills",
    }
    try:
        return roots[platform]
    except KeyError as exc:
        raise RuntimeError(f"unsupported platform: {platform}") from exc


def is_safe_relative_path(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    if text.startswith("/") or text.startswith("\\") or RE_WINDOWS_DRIVE.match(text):
        return False
    if "\\" in text:
        return False
    return ".." not in pathlib.PurePosixPath(text).parts


def is_safe_glob_pattern(value: str) -> bool:
    text = value.strip()
    return is_safe_relative_path(text) and "//" not in text


def ensure_skill_source(package_id: str, package: dict[str, Any]) -> dict[str, Any]:
    if package.get("package_type") != "skill-pack":
        raise RuntimeError(f"{package_id}: package_type must be skill-pack for skill installation")
    source = package.get("source")
    if not isinstance(source, dict):
        raise RuntimeError(f"{package_id}: missing or invalid 'source' metadata")

    repo = source.get("repo")
    if not isinstance(repo, str) or not RE_REPO.fullmatch(repo):
        raise RuntimeError(f"{package_id}: source.repo must be owner/name")
    ref = source.get("ref")
    if not isinstance(ref, str) or not RE_SOURCE_REF.fullmatch(ref.strip()):
        raise RuntimeError(f"{package_id}: source.ref must match ^[A-Za-z0-9._/-]+$")
    subpath = source.get("subpath")
    if not isinstance(subpath, str) or not is_safe_relative_path(subpath):
        raise RuntimeError(f"{package_id}: source.subpath must be a safe relative path")

    include = source.get("include")
    if not isinstance(include, list) or not include:
        raise RuntimeError(f"{package_id}: source.include must be non-empty list")
    for pattern in include:
        if not isinstance(pattern, str) or not is_safe_glob_pattern(pattern):
            raise RuntimeError(f"{package_id}: source.include contains unsafe pattern: {pattern!r}")

    exclude = source.get("exclude") or []
    if not isinstance(exclude, list):
        raise RuntimeError(f"{package_id}: source.exclude must be a list when present")
    for pattern in exclude:
        if not isinstance(pattern, str) or not is_safe_glob_pattern(pattern):
            raise RuntimeError(f"{package_id}: source.exclude contains unsafe pattern: {pattern!r}")
    return source


def ensure_python_runtime(package_id: str, package: dict[str, Any]) -> dict[str, Any] | None:
    runtime = package.get("runtime")
    if runtime is None:
        return None
    if package.get("package_type") != "skill-pack":
        raise RuntimeError(f"{package_id}: runtime is only supported for skill-pack entries")
    if not isinstance(runtime, dict):
        raise RuntimeError(f"{package_id}: runtime must be an object when present")

    python_runtime = runtime.get("python")
    if not isinstance(python_runtime, dict):
        raise RuntimeError(f"{package_id}: runtime.python must be an object")

    mode = python_runtime.get("mode")
    packages = python_runtime.get("packages")
    if mode != "isolated-venv":
        raise RuntimeError(f"{package_id}: runtime.python.mode must be 'isolated-venv'")
    if not isinstance(packages, list):
        raise RuntimeError(f"{package_id}: runtime.python.packages must be an array")
    normalized: list[str] = []
    for idx, item in enumerate(packages):
        if not isinstance(item, str) or not item.strip():
            raise RuntimeError(f"{package_id}: runtime.python.packages[{idx}] must be a non-empty string")
        normalized.append(item.strip())
    return {"mode": mode, "packages": normalized}


def ensure_install_policy(package_id: str, package: dict[str, Any]) -> dict[str, Any] | None:
    return _ensure_install_policy(package_id, package)
