from __future__ import annotations

import json
import pathlib
import re
from typing import Any

RE_PACKAGE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")


def default_market_root(script_file: pathlib.Path) -> pathlib.Path:
    return script_file.resolve().parents[1]


def load_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"invalid JSON: {path}: {exc}") from exc


def load_packages(market_root: pathlib.Path) -> dict[str, dict[str, Any]]:
    index_path = market_root / "packages" / "index.json"
    index = load_json(index_path)
    listed = index.get("packages")
    if not isinstance(listed, list) or not listed:
        raise RuntimeError("packages/index.json must contain a non-empty 'packages' list")

    packages: dict[str, dict[str, Any]] = {}
    for rel in listed:
        if not isinstance(rel, str):
            raise RuntimeError(f"package index entry must be string, got {type(rel).__name__}")
        pkg_path = market_root / "packages" / rel
        if not pkg_path.exists():
            raise RuntimeError(f"package metadata listed but missing: {pkg_path}")
        pkg = load_json(pkg_path)
        package_id = pkg.get("package_id")
        if not isinstance(package_id, str) or not package_id:
            raise RuntimeError(f"invalid package_id in {pkg_path}")
        if not RE_PACKAGE_ID.fullmatch(package_id):
            raise RuntimeError(f"{pkg_path}: package_id must match ^[A-Za-z0-9_.-]+$")
        packages[package_id] = pkg
    return packages


def pick_packages(
    *,
    all_skills: bool,
    package_ids: list[str],
    packages: dict[str, dict[str, Any]],
) -> list[str]:
    if all_skills:
        return sorted(
            package_id
            for package_id, package in packages.items()
            if package.get("package_type") == "skill-pack"
        )
    if not package_ids:
        raise RuntimeError("select at least one skill with --package, or use --all")
    missing = [package_id for package_id in package_ids if package_id not in packages]
    if missing:
        raise RuntimeError(f"unknown package_id(s): {missing}")
    return package_ids


def resolve_dependency_order(
    roots: list[str],
    *,
    packages: dict[str, dict[str, Any]],
    install_deps: bool,
) -> tuple[list[str], dict[str, list[str]]]:
    if not install_deps:
        return roots, {}

    order: list[str] = []
    permanent: set[str] = set()
    temporary: set[str] = set()
    non_skill_deps: dict[str, list[str]] = {}

    def dfs(package_id: str) -> None:
        if package_id in permanent:
            return
        if package_id in temporary:
            raise RuntimeError(f"dependency cycle detected at {package_id}")
        package = packages.get(package_id)
        if package is None:
            raise RuntimeError(f"depends_on unknown package {package_id}")

        temporary.add(package_id)
        depends_on = package.get("depends_on") or {}
        if not isinstance(depends_on, dict):
            raise RuntimeError(f"{package_id}: depends_on must be an object")

        for dep_id in depends_on:
            dep_pkg = packages.get(dep_id)
            if dep_pkg is None:
                raise RuntimeError(f"{package_id}: depends_on unknown package {dep_id}")
            if dep_pkg.get("package_type") == "skill-pack":
                dfs(dep_id)
            else:
                non_skill_deps.setdefault(package_id, []).append(dep_id)

        temporary.remove(package_id)
        permanent.add(package_id)
        order.append(package_id)

    for root in roots:
        dfs(root)

    seen: set[str] = set()
    deduped: list[str] = []
    for package_id in order:
        if package_id not in seen:
            seen.add(package_id)
            deduped.append(package_id)
    return deduped, non_skill_deps
