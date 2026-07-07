#!/usr/bin/env python3
"""Normalize repo-local Markdown links in idea reports.

Codex sidebar link resolution treats Markdown link targets as workspace-root
relative. For repo-local artifacts, report files therefore use project-root
relative targets such as ``ideas/gaia/.../starmap.html`` and
``artifacts/<campaign>/...``.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Iterable, Optional, Tuple
from urllib.parse import unquote, urlparse

LINK_RE = re.compile(r"(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(\s+\"[^\"]*\")?\)")
SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
PROJECT_ROOT_PREFIXES = ("artifacts/", "idea-store/", "ideas/")


def _split_fragment(target: str) -> Tuple[str, str]:
    path, sep, fragment = target.partition("#")
    return path, f"{sep}{fragment}" if sep else ""


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _file_uri_path(target: str) -> Optional[Path]:
    parsed = urlparse(target)
    if parsed.scheme != "file":
        return None
    return Path(unquote(parsed.path))


def _project_uri_path(target: str, project_root: Path) -> Optional[Path]:
    if not target.startswith("project://"):
        return None
    body = target[len("project://") :]
    encoded_path, _, _fragment = body.partition("#")
    if not encoded_path or encoded_path.startswith("/"):
        return None
    segments = encoded_path.split("/")
    if any(segment == "" for segment in segments):
        return None
    try:
        decoded_segments = [unquote(segment) for segment in segments]
    except Exception:
        return None
    if any(segment in ("", ".", "..") or "/" in segment for segment in decoded_segments):
        return None
    return (project_root.joinpath(*decoded_segments)).resolve()


def _candidate_path(path_part: str, report_path: Path, project_root: Path) -> Optional[Path]:
    if path_part.startswith("/"):
        return Path(path_part).resolve()

    if path_part.startswith(PROJECT_ROOT_PREFIXES):
        rooted = (project_root / path_part).resolve()
        if rooted.exists():
            return rooted

    doc_relative = (report_path.parent / path_part).resolve()
    if doc_relative.exists():
        return doc_relative

    rooted = (project_root / path_part).resolve()
    if rooted.exists():
        return rooted

    return None


def normalize_target(target: str, report_path: Path, project_root: Path) -> str:
    if target.startswith("#"):
        return target

    path_part, fragment = _split_fragment(target)
    if SCHEME_RE.match(path_part):
        uri_path = _file_uri_path(path_part) or _project_uri_path(path_part, project_root)
        if uri_path is None:
            return target
        candidate = uri_path.resolve()
    else:
        candidate = _candidate_path(path_part, report_path, project_root)
        if candidate is None:
            return target

    if not _inside(candidate, project_root):
        return target

    return candidate.relative_to(project_root).as_posix() + fragment


def normalize_file(path: Path, project_root: Path, check: bool = False) -> bool:
    original = path.read_text(encoding="utf-8")

    def replace(match: re.Match[str]) -> str:
        label, target, title = match.group(1), match.group(2), match.group(3) or ""
        normalized = normalize_target(target, path, project_root)
        return f"[{label}]({normalized}{title})"

    updated = LINK_RE.sub(replace, original)
    if updated == original:
        return False
    if check:
        return True
    path.write_text(updated, encoding="utf-8")
    return True


def iter_report_paths(values: Iterable[str]) -> Iterable[Path]:
    for value in values:
        path = Path(value)
        if path.is_dir():
            yield from sorted(path.rglob("*.md"))
        else:
            yield path


def run(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True, help="Project root used for repo-local link targets")
    parser.add_argument("--check", action="store_true", help="Exit nonzero if any file would change")
    parser.add_argument("paths", nargs="+", help="Markdown report files or directories")
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    changed: list[str] = []
    for path in iter_report_paths(args.paths):
        if path.suffix.lower() != ".md":
            continue
        if normalize_file(path.resolve(), project_root, check=args.check):
            changed.append(str(path))

    if changed:
        for path in changed:
            print(path)
        return 1 if args.check else 0
    return 0


if __name__ == "__main__":
    sys.exit(run())
