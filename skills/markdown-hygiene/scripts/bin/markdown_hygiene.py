#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse


TOC_START_RE = re.compile(r"^\s*##+\s+(目录|table of contents|contents)\b", re.IGNORECASE)
HR_RE = re.compile(r"^\s*---\s*$")
FENCE_RE = re.compile(r"^\s*```")
DISPLAY_MATH_BRACKET_START_RE = re.compile(r"^\s*\\\[\s*$")
DISPLAY_MATH_BRACKET_END_RE = re.compile(r"^\s*\\\]\s*$")
DISPLAY_MATH_DOLLAR_RE = re.compile(r"^\s*\$\$\s*$")
DISPLAY_MATH_ENV_START_RE = re.compile(
    r"\\begin\{(?:equation|equation\*|align|align\*|aligned|gather|gather\*|multline|multline\*|split)\}"
)
DISPLAY_MATH_ENV_END_RE = re.compile(
    r"\\end\{(?:equation|equation\*|align|align\*|aligned|gather|gather\*|multline|multline\*|split)\}"
)
DISPLAY_MATH_LEADING_CONTINUATION_RE = re.compile(r"^(\s*)([=+-])(.*)$")

SINGLE_DOLLAR_MATH_RE = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)")
DOUBLE_DOLLAR_MATH_RE = re.compile(r"\$\$(.+?)\$\$")
HTML_LINK_RE = re.compile(r"<a\s+[^>]*href=[\"']([^\"']+)[\"']", re.IGNORECASE)
REFERENCE_LINK_DEF_RE = re.compile(r"^\s{0,3}\[[^\]\n]+]:\s+(<[^>\n]+>|\S+)")
CODE_SPAN_MD_PATH_RE = re.compile(r"`([^`\n]*\.m(?:ark)?d(?:#[^`\s]+)?[^`\n]*)`", re.IGNORECASE)
RAW_MATH_PRESETS = {
    "ascii-math": (
        r"(?<![-<=>])(?:<->|->|<-|<=>|=>)(?![-<=>])",
        r"\b[A-Za-z][A-Za-z0-9_]*\^[A-Za-z0-9+-]+\b",
    )
}

DEFAULT_BARE_MD_PATH_PREFIXES = (
    "notes",
    "knowledge_base",
    "literature",
    "papers",
    "figures",
    "slides",
    "assets",
)
EXTERNAL_SCHEMES = {
    "arxiv",
    "data",
    "doi",
    "ftp",
    "http",
    "https",
    "mailto",
    "zotero",
}


@dataclass
class HygieneIssue:
    path: Path
    line: int
    message: str


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


def normalize_markdown_link_target(raw_target: str) -> str:
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        target = target[1 : target.index(">")]
    else:
        target = target.split(None, 1)[0]
    return target.strip()


def iter_inline_markdown_link_targets(segment: str) -> Iterable[str]:
    cursor = 0
    while cursor < len(segment):
        close_label = segment.find("](", cursor)
        if close_label < 0:
            return

        target_start = close_label + 2
        depth = 1
        escaped = False
        in_angle = False
        pos = target_start
        while pos < len(segment):
            ch = segment[pos]
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == "<":
                in_angle = True
            elif ch == ">" and in_angle:
                in_angle = False
            elif ch == "(" and not in_angle:
                depth += 1
            elif ch == ")" and not in_angle:
                depth -= 1
                if depth == 0:
                    yield segment[target_start:pos]
                    cursor = pos + 1
                    break
            pos += 1
        else:
            return


def iter_link_targets(segment: str) -> Iterable[str]:
    yield from iter_inline_markdown_link_targets(segment)
    for match in HTML_LINK_RE.finditer(segment):
        yield match.group(1)
    reference_definition = REFERENCE_LINK_DEF_RE.match(segment)
    if reference_definition:
        yield reference_definition.group(1)


def is_external_target(target: str) -> bool:
    if target.startswith("#"):
        return True
    parsed = urlparse(target)
    if parsed.scheme == "file":
        return False
    return parsed.scheme in EXTERNAL_SCHEMES


def strip_target_fragment(target: str) -> str:
    return target.split("#", 1)[0]


def check_local_links_in_file(path: Path, project_root: Path, text: str) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    project_root = project_root.resolve()

    for line_number, (line, in_code_block) in enumerate(split_fenced_lines(text), start=1):
        if in_code_block:
            continue
        for segment, is_inline_code in split_inline_code_segments(line):
            if is_inline_code:
                continue
            for raw_target in iter_link_targets(segment):
                target = normalize_markdown_link_target(raw_target)
                if not target or is_external_target(target):
                    continue
                if urlparse(target).scheme == "file":
                    issues.append(HygieneIssue(path, line_number, f"file URL is not portable: {target}"))
                    continue

                without_fragment = unquote(strip_target_fragment(target))
                if not without_fragment:
                    continue
                target_path = Path(without_fragment)
                if target_path.is_absolute():
                    issues.append(HygieneIssue(path, line_number, f"absolute local link is not portable: {target}"))
                    continue

                resolved = (path.parent / target_path).resolve()
                try:
                    resolved.relative_to(project_root)
                except ValueError:
                    issues.append(HygieneIssue(path, line_number, f"local link escapes the checked root: {target}"))
                    continue
                if not resolved.exists():
                    issues.append(HygieneIssue(path, line_number, f"local link target does not exist: {target}"))

    return issues


def looks_like_prefixed_markdown_path(value: str, prefixes: tuple[str, ...]) -> bool:
    normalized = value.strip().strip("'\"")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    while normalized.startswith("../"):
        normalized = normalized[3:]
    if not re.search(r"\.m(?:ark)?d(?:#|\s|$)", normalized, re.IGNORECASE):
        return False
    return any(normalized == prefix or normalized.startswith(prefix + "/") for prefix in prefixes)


def check_bare_markdown_paths_in_file(path: Path, text: str, prefixes: tuple[str, ...]) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    for line_number, (line, in_code_block) in enumerate(split_fenced_lines(text), start=1):
        if in_code_block:
            continue
        for match in CODE_SPAN_MD_PATH_RE.finditer(line):
            candidate = match.group(1)
            if looks_like_prefixed_markdown_path(candidate, prefixes):
                issues.append(
                    HygieneIssue(
                        path,
                        line_number,
                        f"Markdown path is shown as code instead of a link: {candidate}",
                    )
                )
    return issues


def check_raw_tokens_in_file(path: Path, text: str, raw_patterns: tuple[tuple[str, re.Pattern[str]], ...]) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    for line_number, (line, in_code_block) in enumerate(split_fenced_lines(text), start=1):
        if in_code_block:
            continue
        for segment, is_inline_code in split_inline_code_segments(line):
            if is_inline_code:
                continue
            for token, pattern in raw_patterns:
                if pattern.search(segment):
                    issues.append(HygieneIssue(path, line_number, f"raw token matched configurable pattern: {token}"))
    return issues


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


def fix_display_math_leading_continuation_lines(text: str) -> tuple[str, int]:
    out: list[str] = []
    changes = 0
    in_display_math = False

    for line, in_code in split_fenced_lines(text):
        if in_code:
            out.append(line)
            continue

        if DISPLAY_MATH_DOLLAR_RE.match(line):
            out.append(line)
            in_display_math = not in_display_math
            continue

        if DISPLAY_MATH_BRACKET_START_RE.match(line):
            out.append(line)
            in_display_math = True
            continue

        if DISPLAY_MATH_BRACKET_END_RE.match(line):
            out.append(line)
            in_display_math = False
            continue

        starts_env = DISPLAY_MATH_ENV_START_RE.search(line) is not None
        ends_env = DISPLAY_MATH_ENV_END_RE.search(line) is not None
        active_for_line = in_display_math or starts_env

        fixed = line
        if active_for_line:
            fixed_candidate = DISPLAY_MATH_LEADING_CONTINUATION_RE.sub(r"\1{}\2\3", line, count=1)
            if fixed_candidate != line:
                changes += 1
                fixed = fixed_candidate

        out.append(fixed)

        if starts_env and not ends_env:
            in_display_math = True
        if ends_env:
            in_display_math = False

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


def run_extra_checks(
    root: Path,
    *,
    check_local_links: bool,
    check_bare_md_paths: bool,
    path_prefixes: tuple[str, ...],
    raw_tokens: tuple[str, ...],
) -> int:
    if not (check_local_links or check_bare_md_paths or raw_tokens):
        return 0

    paths = list(iter_markdown_files(root))
    if not paths:
        return 0

    project_root = root.resolve() if root.is_dir() else root.parent.resolve()
    raw_patterns = tuple((token, re.compile(token)) for token in raw_tokens)
    issues: list[HygieneIssue] = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        if check_local_links:
            issues.extend(check_local_links_in_file(path, project_root, text))
        if check_bare_md_paths:
            issues.extend(check_bare_markdown_paths_in_file(path, text, path_prefixes))
        if raw_patterns:
            issues.extend(check_raw_tokens_in_file(path, text, raw_patterns))

    for issue in issues:
        print(f"{issue.path}:{issue.line}: {issue.message}", file=sys.stderr)
    return 1 if issues else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Check or fix deterministic Markdown hygiene issues.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in ("check", "fix", "fix-toc"):
        subparser = subparsers.add_parser(name)
        subparser.add_argument("--root", type=Path, required=True, help="Markdown file or directory to process.")
        if name == "check":
            subparser.add_argument(
                "--check-local-links",
                action="store_true",
                help="Fail on broken, absolute, file://, or root-escaping local Markdown links.",
            )
            subparser.add_argument(
                "--check-bare-md-paths",
                action="store_true",
                help="Fail when likely note paths are shown as inline code instead of Markdown links.",
            )
            subparser.add_argument(
                "--path-prefix",
                action="append",
                default=[],
                help="Additional relative path prefix for --check-bare-md-paths.",
            )
            subparser.add_argument(
                "--raw-token",
                action="append",
                default=[],
                help="Regex pattern that must not appear outside fenced code blocks.",
            )
            subparser.add_argument(
                "--raw-math-preset",
                choices=sorted(RAW_MATH_PRESETS),
                action="append",
                default=[],
                help="Named raw-math regex preset to add to --raw-token checks.",
            )
        if name == "fix-toc":
            subparser.add_argument("--check", action="store_true", help="Do not write; exit 1 if changes would be made.")

    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "check":
        fix_exit = run(
            args.root,
            [
                fix_markdown_math_double_backslash,
                fix_toc_latex_escapes,
                fix_display_math_leading_continuation_lines,
            ],
            check=True,
        )
        preset_tokens: list[str] = []
        for preset_name in args.raw_math_preset:
            preset_tokens.extend(RAW_MATH_PRESETS[preset_name])

        extra_exit = run_extra_checks(
            args.root,
            check_local_links=args.check_local_links,
            check_bare_md_paths=args.check_bare_md_paths,
            path_prefixes=tuple(DEFAULT_BARE_MD_PATH_PREFIXES + tuple(args.path_prefix)),
            raw_tokens=tuple(args.raw_token + preset_tokens),
        )
        return 1 if fix_exit or extra_exit else 0
    if args.command == "fix":
        return run(
            args.root,
            [
                fix_markdown_math_double_backslash,
                fix_toc_latex_escapes,
                fix_display_math_leading_continuation_lines,
            ],
            check=False,
        )
    if args.command == "fix-toc":
        return run(args.root, [fix_toc_latex_escapes], check=args.check)

    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
