#!/usr/bin/env python3
"""Normalize and check clickable Markdown links in idea reports.

Human-facing reports can live below ``artifacts/<campaign>/`` or deeper, so a
repo-root-looking target such as ``ideas/gaia/.../starmap.html`` is ambiguous:
standard Markdown resolves it relative to the report file and opens the wrong
path. This helper resolves repo-local targets against both the report directory
and the project root, then writes the Markdown target relative to the report
file itself. Machine references such as ``project://...#sha256`` remain the
portable source of truth; Markdown links are the click target for humans.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Callable, Iterable, Optional, Tuple
from urllib.parse import unquote, urlparse

LINK_RE = re.compile(r"(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(\s+\"[^\"]*\")?\)")
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
REPO_LOCAL_PREFIXES = ("artifacts/", "idea-store/", "ideas/", "argument-graphs/", "knowledge_base/")
BARE_LOCAL_PATH_RE = re.compile(
    r"(?<![\w./-])((?:artifacts|idea-store|ideas|argument-graphs|knowledge_base)/[^\s)\],;]+)"
)
ARXIV_RE = re.compile(r"(?<![\w/])arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?", re.IGNORECASE)
DOI_RE = re.compile(r"(?<![\w/])DOI:\s*(10\.\d{4,9}/[^\s)\],;]+)", re.IGNORECASE)
INSPIRE_RE = re.compile(r"(?<![\w/])INSPIRE\s+recid\s*:?\s*(\d+)", re.IGNORECASE)


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

    rel = os.path.relpath(candidate, report_path.parent)
    return Path(rel).as_posix() + fragment


def _protected_ranges(line: str) -> list[tuple[int, int]]:
    ranges = [(m.start(), m.end()) for m in LINK_RE.finditer(line)]
    ranges.extend((m.start(), m.end()) for m in INLINE_CODE_RE.finditer(line))
    ranges.sort()
    merged: list[tuple[int, int]] = []
    for start, end in ranges:
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _rewrite_unprotected(line: str, rewrite: Callable[[str], str]) -> str:
    ranges = _protected_ranges(line)
    pieces: list[str] = []
    cursor = 0
    for start, end in ranges:
        pieces.append(rewrite(line[cursor:start]))
        pieces.append(line[start:end])
        cursor = end
    pieces.append(rewrite(line[cursor:]))
    return "".join(pieces)


def _autolink_literature_refs(segment: str) -> str:
    def arxiv_replace(match: re.Match[str]) -> str:
        paper_id = match.group(1) + (match.group(2) or "")
        return f"[arXiv:{paper_id}](https://arxiv.org/abs/{paper_id})"

    def doi_replace(match: re.Match[str]) -> str:
        doi = match.group(1).rstrip(".")
        suffix = "." if match.group(1).endswith(".") else ""
        return f"[DOI:{doi}](https://doi.org/{doi}){suffix}"

    def inspire_replace(match: re.Match[str]) -> str:
        recid = match.group(1)
        return f"[INSPIRE recid {recid}](https://inspirehep.net/literature/{recid})"

    segment = ARXIV_RE.sub(arxiv_replace, segment)
    segment = DOI_RE.sub(doi_replace, segment)
    segment = INSPIRE_RE.sub(inspire_replace, segment)
    return segment


def _autolink_local_paths(segment: str, report_path: Path, project_root: Path) -> str:
    def replace(match: re.Match[str]) -> str:
        label = match.group(1)
        normalized = normalize_target(label, report_path, project_root)
        if normalized == label and _candidate_path(label, report_path, project_root) is None:
            return label
        return f"[{label}]({normalized})"

    return BARE_LOCAL_PATH_RE.sub(replace, segment)


def _inline_code_to_link(line: str, report_path: Path, project_root: Path) -> str:
    def replace(match: re.Match[str]) -> str:
        content = match.group(0)[1:-1]
        if content.startswith(REPO_LOCAL_PREFIXES):
            normalized = normalize_target(content, report_path, project_root)
            if normalized != content or _candidate_path(content, report_path, project_root) is not None:
                return f"[{content}]({normalized})"
        linked = _autolink_literature_refs(content)
        if linked != content:
            return linked
        return match.group(0)

    return INLINE_CODE_RE.sub(replace, line)


def autolink_text(text: str, report_path: Path, project_root: Path) -> str:
    lines: list[str] = []
    in_fence = False
    for line in text.splitlines(keepends=True):
        body = line[:-1] if line.endswith("\n") else line
        newline = "\n" if line.endswith("\n") else ""
        if FENCE_RE.match(body):
            in_fence = not in_fence
            lines.append(line)
            continue
        if in_fence:
            lines.append(line)
            continue
        body = _inline_code_to_link(body, report_path, project_root)

        def rewrite(segment: str) -> str:
            return _autolink_local_paths(_autolink_literature_refs(segment), report_path, project_root)

        lines.append(_rewrite_unprotected(body, rewrite) + newline)
    return "".join(lines)


def report_link_issues(path: Path, project_root: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    issues: list[str] = []
    in_fence = False
    for lineno, line in enumerate(text.splitlines(), start=1):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for match in LINK_RE.finditer(line):
            target = match.group(2)
            if target.startswith("#"):
                continue
            path_part, _fragment = _split_fragment(target)
            if path_part == "":
                continue
            if SCHEME_RE.match(path_part):
                uri_path = _file_uri_path(path_part) or _project_uri_path(path_part, project_root)
                if uri_path is None:
                    continue
                candidate = uri_path.resolve()
            else:
                candidate = _candidate_path(path_part, path, project_root)
                if candidate is None:
                    issues.append(
                        f"{path}:{lineno}: local link target does not exist from the "
                        f"report location or project root: {target}"
                    )
                    continue

            if not _inside(candidate, project_root):
                issues.append(f"{path}:{lineno}: local link escapes project root: {target}")
                continue
            if not candidate.exists():
                issues.append(f"{path}:{lineno}: local link target does not exist: {target}")
    return issues


def normalize_file(path: Path, project_root: Path, check: bool = False) -> bool:
    original = path.read_text(encoding="utf-8")

    def replace(match: re.Match[str]) -> str:
        label, target, title = match.group(1), match.group(2), match.group(3) or ""
        normalized = normalize_target(target, path, project_root)
        return f"[{label}]({normalized}{title})"

    updated = LINK_RE.sub(replace, original)
    updated = autolink_text(updated, path, project_root)
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
    issues: list[str] = []
    for path in iter_report_paths(args.paths):
        if path.suffix.lower() != ".md":
            continue
        resolved = path.resolve()
        if normalize_file(resolved, project_root, check=args.check):
            changed.append(str(path))
        issues.extend(report_link_issues(resolved, project_root))

    if changed:
        for path in changed:
            print(path)
    if issues:
        for issue in issues:
            print(issue, file=sys.stderr)
    if changed or issues:
        return 1 if args.check or issues else 0
    return 0


if __name__ == "__main__":
    sys.exit(run())
