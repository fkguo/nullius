#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Callable, Iterable
from pathlib import Path


TOC_START_RE = re.compile(r"^\s*##+\s+(目录|table of contents|contents)\b", re.IGNORECASE)
HR_RE = re.compile(r"^\s*---\s*$")
FENCE_RE = re.compile(r"^\s*```")

SINGLE_DOLLAR_MATH_RE = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)")
DOUBLE_DOLLAR_MATH_RE = re.compile(r"\$\$(.+?)\$\$")


def iter_markdown_files(root: Path) -> Iterable[Path]:
    if root.is_file():
        if root.suffix.lower() in {".md", ".markdown"}:
            yield root
        return

    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix.lower() in {".md", ".markdown"}:
            yield path


def split_fenced_lines(text: str) -> Iterable[tuple[str, bool]]:
    in_code = False
    for line in text.splitlines(keepends=True):
        if FENCE_RE.match(line):
            yield line, in_code
            in_code = not in_code
            continue
        yield line, in_code


def split_inline_code_segments(line: str) -> Iterable[tuple[str, bool]]:
    cursor = 0
    while cursor < len(line):
        start = line.find("`", cursor)
        if start < 0:
            yield line[cursor:], False
            return
        if start > cursor:
            yield line[cursor:start], False

        tick_count = 1
        while start + tick_count < len(line) and line[start + tick_count] == "`":
            tick_count += 1
        fence = "`" * tick_count
        end = line.find(fence, start + tick_count)
        if end < 0:
            yield line[start:], False
            return
        end += tick_count
        yield line[start:end], True
        cursor = end


def fix_toc_math(expr: str) -> str:
    # Undo TOC-generator escaping without touching legitimate LaTeX line breaks.
    expr = re.sub(r"\\\\(?=[A-Za-z_])", r"\\", expr)
    expr = expr.replace(r"\\_", "_")
    expr = expr.replace(r"\_", "_")
    expr = expr.replace(r"\\*", "*")
    expr = expr.replace(r"\*", "*")
    expr = expr.replace(r"\\^", "^")
    expr = expr.replace(r"\^", "^")
    return expr


def fix_doubled_math_commands(expr: str) -> str:
    # Fix common accidental command doubling, but leave line breaks and spacing intact.
    return re.sub(r"\\\\(?=[A-Za-z])", r"\\", expr)


def rewrite_math_in_line(line: str, fixer: Callable[[str], str]) -> str:
    rewritten: list[str] = []
    for segment, is_code in split_inline_code_segments(line):
        if is_code:
            rewritten.append(segment)
            continue
        segment = DOUBLE_DOLLAR_MATH_RE.sub(lambda m: "$$" + fixer(m.group(1)) + "$$", segment)
        segment = SINGLE_DOLLAR_MATH_RE.sub(lambda m: "$" + fixer(m.group(1)) + "$", segment)
        rewritten.append(segment)
    return "".join(rewritten)


def fix_toc_latex_escapes(text: str) -> tuple[str, int]:
    out: list[str] = []
    in_toc = False
    changes = 0

    for line, in_code in split_fenced_lines(text):
        if not in_toc and not in_code and TOC_START_RE.match(line):
            in_toc = True
            out.append(line)
            continue

        if in_toc and not in_code and HR_RE.match(line):
            in_toc = False
            out.append(line)
            continue

        if in_toc and not in_code:
            fixed = rewrite_math_in_line(line, fix_toc_math)
            if fixed != line:
                changes += 1
            out.append(fixed)
            continue

        out.append(line)

    return "".join(out), changes


def fix_markdown_math_double_backslash(text: str) -> tuple[str, int]:
    out: list[str] = []
    changes = 0

    for line, in_code in split_fenced_lines(text):
        if in_code:
            out.append(line)
            continue
        fixed = rewrite_math_in_line(line, fix_doubled_math_commands)
        if fixed != line:
            changes += 1
        out.append(fixed)

    return "".join(out), changes


def apply_fixers(text: str, fixers: list[Callable[[str], tuple[str, int]]]) -> tuple[str, int]:
    total = 0
    updated = text
    for fixer in fixers:
        updated, changes = fixer(updated)
        total += changes
    return updated, total


def process_path(path: Path, fixers: list[Callable[[str], tuple[str, int]]], check: bool) -> int:
    original = path.read_text(encoding="utf-8")
    updated, changes = apply_fixers(original, fixers)
    if changes <= 0:
        return 0

    print(f"{path}: {changes} line(s) need Markdown hygiene fixes", file=sys.stderr)
    if not check and updated != original:
        path.write_text(updated, encoding="utf-8")
    return changes


def run(root: Path, fixers: list[Callable[[str], tuple[str, int]]], check: bool) -> int:
    paths = list(iter_markdown_files(root))
    if not paths:
        print(f"[warn] no Markdown files found under {root}", file=sys.stderr)
        return 0

    total = 0
    for path in paths:
        total += process_path(path, fixers, check)
    return 1 if check and total > 0 else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Check or fix deterministic Markdown hygiene issues.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in ("check", "fix", "fix-toc"):
        subparser = subparsers.add_parser(name)
        subparser.add_argument("--root", type=Path, required=True, help="Markdown file or directory to process.")
        if name == "fix-toc":
            subparser.add_argument("--check", action="store_true", help="Do not write; exit 1 if changes would be made.")

    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "check":
        return run(args.root, [fix_markdown_math_double_backslash, fix_toc_latex_escapes], check=True)
    if args.command == "fix":
        return run(args.root, [fix_markdown_math_double_backslash, fix_toc_latex_escapes], check=False)
    if args.command == "fix-toc":
        return run(args.root, [fix_toc_latex_escapes], check=args.check)

    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
