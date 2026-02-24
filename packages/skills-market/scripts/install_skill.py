#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any


DEFAULT_EXCLUDES = {
    ".git",
    ".git/**",
    "**/.git/**",
    "tests/**",
    "test/**",
    "**/.pytest_cache/**",
    "**/__pycache__/**",
    "**/*.pyc",
    "**/.DS_Store",
}
RE_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RE_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
RE_SOURCE_REF = re.compile(r"^(?!/)(?!.*\.\.)(?!.*//)[A-Za-z0-9._/-]+$")
RE_PACKAGE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")


def repo_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parents[1]


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
        pid = pkg.get("package_id")
        if not isinstance(pid, str) or not pid:
            raise RuntimeError(f"invalid package_id in {pkg_path}")
        if not RE_PACKAGE_ID.fullmatch(pid):
            raise RuntimeError(f"{pkg_path}: package_id must match ^[A-Za-z0-9_.-]+$")
        packages[pid] = pkg
    return packages


def platform_root(platform: str, target_root_override: pathlib.Path | None) -> pathlib.Path:
    if target_root_override is not None:
        return target_root_override.expanduser().resolve()
    home = pathlib.Path.home()
    if platform == "codex":
        return home / ".codex" / "skills"
    if platform == "claude_code":
        return home / ".claude" / "skills"
    if platform == "opencode":
        return home / ".config" / "opencode" / "skills"
    raise RuntimeError(f"unsupported platform: {platform}")


def run_checked(cmd: list[str], *, cwd: pathlib.Path | None = None) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "command failed:\n"
            f"$ {' '.join(cmd)}\n"
            f"exit={proc.returncode}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )
    return proc


def git_head(repo_path: pathlib.Path) -> str | None:
    try:
        proc = run_checked(["git", "-C", str(repo_path), "rev-parse", "HEAD"])
    except RuntimeError:
        return None
    return proc.stdout.strip() or None


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
    if "//" in text:
        return False
    return True


def ensure_skill_source(package_id: str, package: dict[str, Any]) -> dict[str, Any]:
    if package.get("package_type") != "skill-pack":
        raise RuntimeError(f"{package_id}: package_type must be skill-pack for skill installation")
    source = package.get("source")
    if not isinstance(source, dict):
        raise RuntimeError(f"{package_id}: missing or invalid 'source' metadata")
    required = ("repo", "ref", "subpath", "include")
    missing = [k for k in required if k not in source]
    if missing:
        raise RuntimeError(f"{package_id}: source missing keys: {missing}")

    repo = source.get("repo")
    if not isinstance(repo, str) or not RE_REPO.fullmatch(repo):
        raise RuntimeError(f"{package_id}: source.repo must be owner/name")

    ref = source.get("ref")
    if not isinstance(ref, str) or not ref.strip():
        raise RuntimeError(f"{package_id}: source.ref must be non-empty string")
    if not RE_SOURCE_REF.fullmatch(ref.strip()):
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


def pick_packages(
    *,
    all_skills: bool,
    package_ids: list[str],
    packages: dict[str, dict[str, Any]],
) -> list[str]:
    if all_skills:
        picked = [
            pid
            for pid, pkg in packages.items()
            if pkg.get("package_type") == "skill-pack"
        ]
        return sorted(picked)
    if not package_ids:
        raise RuntimeError("select at least one skill with --package, or use --all")
    missing = [pid for pid in package_ids if pid not in packages]
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
    perm: set[str] = set()
    temp: set[str] = set()
    non_skill_deps: dict[str, list[str]] = {}

    def dfs(pid: str, owner: str) -> None:
        if pid in perm:
            return
        if pid in temp:
            raise RuntimeError(f"dependency cycle detected at {pid}")
        pkg = packages.get(pid)
        if pkg is None:
            raise RuntimeError(f"{owner}: depends_on unknown package {pid}")

        temp.add(pid)
        depends_on = pkg.get("depends_on") or {}
        if not isinstance(depends_on, dict):
            raise RuntimeError(f"{pid}: depends_on must be an object")

        for dep_id in depends_on:
            dep_pkg = packages.get(dep_id)
            if dep_pkg is None:
                raise RuntimeError(f"{pid}: depends_on unknown package {dep_id}")
            dep_type = dep_pkg.get("package_type")
            if dep_type == "skill-pack":
                dfs(dep_id, owner=pid)
            else:
                non_skill_deps.setdefault(pid, []).append(dep_id)

        temp.remove(pid)
        perm.add(pid)
        order.append(pid)

    for root in roots:
        dfs(root, owner=root)

    # Deduplicate while keeping order.
    deduped: list[str] = []
    seen: set[str] = set()
    for pid in order:
        if pid not in seen:
            seen.add(pid)
            deduped.append(pid)
    return deduped, non_skill_deps


def clone_source_repo(repo: str, ref: str, temp_dir: pathlib.Path) -> pathlib.Path:
    clone_dir = temp_dir / f"{repo.replace('/', '__')}@{ref}"
    if clone_dir.exists():
        return clone_dir
    clone_dir.parent.mkdir(parents=True, exist_ok=True)
    try:
        run_checked(
            [
                "git",
                "clone",
                "--depth",
                "1",
                "--branch",
                ref,
                f"https://github.com/{repo}.git",
                str(clone_dir),
            ]
        )
    except RuntimeError:
        # Fallback for commit-hash refs (or branch lookup failures in shallow mode).
        run_checked(
            [
                "git",
                "clone",
                f"https://github.com/{repo}.git",
                str(clone_dir),
            ]
        )
        run_checked(["git", "-C", str(clone_dir), "checkout", ref])
    return clone_dir


def collect_payload_files(source_dir: pathlib.Path, include: list[str], exclude: list[str]) -> list[pathlib.Path]:
    if not source_dir.is_dir():
        raise RuntimeError(f"source subpath does not exist: {source_dir}")

    source_root = source_dir.resolve()
    selected: set[pathlib.Path] = set()
    for pattern in include:
        matches = list(source_dir.glob(pattern))
        for match in matches:
            if match.is_symlink():
                continue
            if match.is_file():
                selected.add(match)
            elif match.is_dir():
                for child in match.rglob("*"):
                    if child.is_symlink():
                        continue
                    if child.is_file():
                        selected.add(child)

    if not selected:
        raise RuntimeError(f"include patterns matched no files under {source_dir}")

    excluded_patterns = list(DEFAULT_EXCLUDES) + exclude

    def is_excluded(rel_path: pathlib.PurePosixPath) -> bool:
        rel = rel_path.as_posix()
        for pattern in excluded_patterns:
            if rel_path.match(pattern):
                return True
            # pathlib.PurePosixPath.match can be depth-sensitive for patterns
            # like "scripts/dev/**"; treat these as directory-prefix excludes.
            if pattern.endswith("/**"):
                prefix = pattern[:-3].rstrip("/")
                if rel == prefix or rel.startswith(prefix + "/"):
                    return True
            if fnmatch.fnmatch(rel, pattern):
                return True
        return False

    final_files: list[pathlib.Path] = []
    for file_path in sorted(selected):
        try:
            file_path.resolve().relative_to(source_root)
        except Exception as exc:
            raise RuntimeError(
                f"include pattern resolved outside source root: {file_path}"
            ) from exc
        rel = file_path.relative_to(source_dir).as_posix()
        rel_path = pathlib.PurePosixPath(rel)
        if is_excluded(rel_path):
            continue
        final_files.append(file_path)

    if not any(fp.relative_to(source_dir).as_posix() == "SKILL.md" for fp in final_files):
        raise RuntimeError("payload must include SKILL.md")
    return final_files


def safe_remove(path: pathlib.Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    if path.is_dir():
        shutil.rmtree(path)


def install_payload(
    *,
    package_id: str,
    target_root: pathlib.Path,
    source_dir: pathlib.Path,
    files: list[pathlib.Path],
    metadata: dict[str, Any],
    force: bool,
    dry_run: bool,
) -> None:
    destination = target_root / package_id
    if destination.exists() or destination.is_symlink():
        if not force:
            if dry_run:
                print(
                    f"[dry-run] {package_id}: target exists and would fail without --force: {destination}"
                )
                return
            raise RuntimeError(
                f"target already exists: {destination} (use --force to replace)"
            )
        if not dry_run:
            safe_remove(destination)

    if dry_run:
        print(f"[dry-run] {package_id}: would install {len(files)} files to {destination}")
        return

    destination.mkdir(parents=True, exist_ok=True)
    for source_file in files:
        if source_file.is_symlink():
            raise RuntimeError(f"refuse to copy symlink payload file: {source_file}")
        rel = source_file.relative_to(source_dir)
        out = destination / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, out, follow_symlinks=False)

    install_record = {
        "package_id": package_id,
        "installed_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        **metadata,
        "file_count": len(files),
    }
    (destination / ".market_install.json").write_text(
        json.dumps(install_record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[ok] installed {package_id} -> {destination}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Install selected skills from skills-market metadata."
    )
    p.add_argument(
        "--platform",
        required=True,
        choices=["codex", "claude_code", "opencode"],
        help="Target platform install root.",
    )
    p.add_argument(
        "--package",
        action="append",
        default=[],
        help="Package id to install. Repeatable. Defaults to none.",
    )
    p.add_argument(
        "--all",
        action="store_true",
        help="Install all skill-pack packages from the market index.",
    )
    p.add_argument(
        "--market-root",
        default=str(repo_root()),
        help="Path to skills-market repository root.",
    )
    p.add_argument(
        "--source-root",
        default=None,
        help="Use local source repo root instead of cloning from GitHub.",
    )
    p.add_argument(
        "--target-root",
        default=None,
        help="Override target install root for the selected platform.",
    )
    p.add_argument(
        "--no-deps",
        action="store_true",
        help="Do not auto-install skill-pack dependencies.",
    )
    p.add_argument(
        "--strict-deps",
        action="store_true",
        help="Fail if non-skill dependencies are detected (tool/workflow/engine/contract packs).",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Replace existing installed skill directories.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve and print installation plan without writing files.",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    try:
        market_root = pathlib.Path(args.market_root).expanduser().resolve()
        target_root = platform_root(
            args.platform,
            pathlib.Path(args.target_root).expanduser() if args.target_root else None,
        )
        packages = load_packages(market_root)
        selected = pick_packages(
            all_skills=args.all,
            package_ids=args.package,
            packages=packages,
        )
        order, non_skill_deps = resolve_dependency_order(
            selected,
            packages=packages,
            install_deps=not args.no_deps,
        )

        if non_skill_deps:
            lines = []
            for pid, deps in sorted(non_skill_deps.items()):
                lines.append(f"  - {pid}: {', '.join(sorted(set(deps)))}")
            msg = (
                "non-skill dependencies detected (must be installed/configured separately):\n"
                + "\n".join(lines)
            )
            if args.strict_deps:
                raise RuntimeError(msg)
            print(f"[warn] {msg}", file=sys.stderr)

        local_source_root = (
            pathlib.Path(args.source_root).expanduser().resolve()
            if args.source_root
            else None
        )

        clone_cache: dict[tuple[str, str], pathlib.Path] = {}
        with tempfile.TemporaryDirectory(prefix="skills-market-install-") as tmp:
            temp_dir = pathlib.Path(tmp)
            for pid in order:
                pkg = packages[pid]
                if pkg.get("package_type") != "skill-pack":
                    print(f"[skip] {pid}: package_type={pkg.get('package_type')} (not a skill-pack)")
                    continue

                source = ensure_skill_source(pid, pkg)
                repo = str(source["repo"])
                ref = str(source["ref"])
                subpath = pathlib.Path(str(source["subpath"]))
                include = [str(x) for x in source.get("include", [])]
                exclude = [str(x) for x in source.get("exclude", [])]

                if local_source_root is not None:
                    repo_root_path = local_source_root
                else:
                    cache_key = (repo, ref)
                    if cache_key not in clone_cache:
                        clone_cache[cache_key] = clone_source_repo(repo, ref, temp_dir)
                    repo_root_path = clone_cache[cache_key]

                source_dir = (repo_root_path / subpath).resolve()
                try:
                    source_dir.relative_to(repo_root_path.resolve())
                except Exception as exc:
                    raise RuntimeError(
                        f"{pid}: source.subpath escapes repository root: {subpath}"
                    ) from exc
                files = collect_payload_files(source_dir, include, exclude)
                source_commit = git_head(repo_root_path)

                install_payload(
                    package_id=pid,
                    target_root=target_root,
                    source_dir=source_dir,
                    files=files,
                    metadata={
                        "source_repo": repo,
                        "source_ref": ref,
                        "source_subpath": str(subpath.as_posix()),
                        "source_commit": source_commit,
                    },
                    force=args.force,
                    dry_run=args.dry_run,
                )
        return 0
    except RuntimeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
