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
    r"\\begin\{(?:equation|equation\*|align|align\*|gather|gather\*|multline|multline\*)\}"
)
DISPLAY_MATH_ENV_END_RE = re.compile(
    r"\\end\{(?:equation|equation\*|align|align\*|gather|gather\*|multline|multline\*)\}"
)
DISPLAY_MATH_LEADING_CONTINUATION_RE = re.compile(r"^(\s*)([=+-])(.*)$")
TABLE_DELIMITER_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$")

SINGLE_DOLLAR_MATH_RE = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)")
DOUBLE_DOLLAR_MATH_RE = re.compile(r"\$\$(.+?)\$\$")
PAREN_INLINE_MATH_RE = re.compile(r"\\\((.+?)\\\)")
BRACKET_INLINE_MATH_RE = re.compile(r"\\\[(.+?)\\\]")
CODE_SPAN_WRAPPER_RE = re.compile(r"^(`+)(.*)\1$", re.DOTALL)
LATEX_COMMAND_RE = re.compile(r"\\[A-Za-z]+")
CODE_MATH_SUB_SUP_RE = re.compile(r"^[A-Za-z](?:_[A-Za-z0-9{}\\]+|\^[A-Za-z0-9{}\\+-]+)+$")
CODE_MATH_FUNCTION_RE = re.compile(r"^[A-Za-z](?:_[A-Za-z0-9{}\\]+)?\([A-Za-z0-9_{}\\,+\-*/\s]+\)$")
CODE_MATH_RATIO_RE = re.compile(r"^[A-Za-z](?:_[A-Za-z]+|\d+)?/[A-Za-z](?:_[A-Za-z]+|\d+)?$")
CODE_MATH_OPERATOR_RE = re.compile(r"(?:<->|->|<-|<=>|=>|<=|>=|[+*^=]|≈|≃|≲|≳|≤|≥|±|×|·|√|→|←|↔)")
CODE_ESCAPE_RE = re.compile(r"\\[ntr0abfv]$")
UNESCAPED_PIPE_RE = re.compile(r"(?<!\\)\|")
UNESCAPED_ASTERISK_RE = re.compile(r"(?<!\\)\*")
GFM_FRAGILE_BAR_RE = re.compile(r"\\bar\{[^{}]+}\s*_[A-Za-z]")
HTML_LINK_RE = re.compile(r"<a\s+[^>]*href=[\"']([^\"']+)[\"']", re.IGNORECASE)
HTML_LINK_TAG_RE = re.compile(r"<a\s+[^>]*href=[\"'][^\"']+[\"'][^>]*>", re.IGNORECASE | re.DOTALL)
HTML_ANCHOR_RE = re.compile(r"<a\b[^>]*>.*?</a>", re.IGNORECASE | re.DOTALL)
HTML_IMG_TAG_RE = re.compile(r"<img\s+[^>]*src=[\"'][^\"']+[\"'][^>]*>", re.IGNORECASE | re.DOTALL)
REFERENCE_LINK_DEF_RE = re.compile(r"^\s{0,3}\[[^\]\n]+]:\s+(<[^>\n]+>|\S+)")
REFERENCE_LINK_DEF_LABEL_RE = re.compile(r"^\s{0,3}\[([^\]\n]+)]:\s+")
CODE_SPAN_MD_PATH_RE = re.compile(r"`([^`\n]*\.m(?:ark)?d(?:#[^`\s]+)?[^`\n]*)`", re.IGNORECASE)
REFERENCE_LINK_SPAN_RE = re.compile(r"!?\[[^\]\n]+\]\[[^\]\n]*\]")
SHORTCUT_REFERENCE_LINK_SPAN_RE = re.compile(r"!?\[([^\]\n]+)]")
AUTOLINK_RE = re.compile(r"<https?://[^<>\s]+>", re.IGNORECASE)
BARE_WEB_URL_RE = re.compile(r"https?://[^\s<>\[\]`]+", re.IGNORECASE)
BARE_DOI_RE = re.compile(r"(?<![\w./-])(?:doi:\s*)?10\.\d{4,9}/[^\s<>\[\]`]+", re.IGNORECASE)
BARE_ARXIV_RE = re.compile(
    r"(?<![\w/-])arXiv:\s*(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Za-z-]+)?/\d{7}(?:v\d+)?)",
    re.IGNORECASE,
)
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


def parse_inline_code_span(segment: str) -> tuple[str, str] | None:
    match = CODE_SPAN_WRAPPER_RE.match(segment)
    if not match:
        return None
    return match.group(1), match.group(2)


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


def iter_inline_markdown_link_spans(segment: str) -> Iterable[tuple[int, int]]:
    cursor = 0
    while cursor < len(segment):
        close_label = segment.find("](", cursor)
        if close_label < 0:
            return

        label_start = segment.rfind("[", 0, close_label)
        if label_start < 0:
            cursor = close_label + 2
            continue

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
                    yield label_start, pos + 1
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


def has_alnum(value: str) -> bool:
    return any(ch.isalnum() for ch in value)


def is_code_span_math_like(inner: str) -> bool:
    stripped = inner.strip()
    if not stripped:
        return False
    lower = stripped.lower()
    if "://" in stripped or BARE_WEB_URL_RE.fullmatch(stripped):
        return False
    if BARE_DOI_RE.fullmatch(stripped) or BARE_ARXIV_RE.fullmatch(stripped):
        return False
    if "/" in stripped and ("." in stripped or stripped.count("/") > 1):
        return False
    if lower.endswith((".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".txt")):
        return False
    if stripped in {"C++", "c++", "C#", "F#"}:
        return False
    if CODE_ESCAPE_RE.fullmatch(stripped):
        return False
    if stripped.startswith("$") and stripped.endswith("$"):
        return True
    if stripped.startswith(r"\(") and stripped.endswith(r"\)"):
        return True
    if stripped.startswith(r"\[") and stripped.endswith(r"\]"):
        return True
    if DISPLAY_MATH_ENV_START_RE.search(stripped) and DISPLAY_MATH_ENV_END_RE.search(stripped):
        return True
    if LATEX_COMMAND_RE.search(stripped):
        return True
    if CODE_MATH_SUB_SUP_RE.match(stripped):
        return True
    if CODE_MATH_FUNCTION_RE.match(stripped):
        return True
    if CODE_MATH_RATIO_RE.match(stripped):
        return True
    return has_alnum(stripped) and CODE_MATH_OPERATOR_RE.search(stripped) is not None


def unwrap_delimited_code_math(inner: str, *, whole_line: bool) -> str:
    stripped = inner.strip()
    if stripped.startswith("$$") and stripped.endswith("$$") and len(stripped) >= 4:
        content = stripped[2:-2].strip()
        if whole_line:
            return f"$$\n{content}\n$$"
        return f"${content}$"
    if stripped.startswith("$") and stripped.endswith("$") and len(stripped) >= 2:
        return stripped
    if stripped.startswith(r"\(") and stripped.endswith(r"\)") and len(stripped) >= 4:
        return f"${stripped[2:-2].strip()}$"
    if stripped.startswith(r"\[") and stripped.endswith(r"\]") and len(stripped) >= 4:
        content = stripped[2:-2].strip()
        if whole_line:
            return f"$$\n{content}\n$$"
        return f"${content}$"
    return f"${stripped}$"


def convert_code_span_math(segment: str, *, whole_line: bool) -> str | None:
    parsed = parse_inline_code_span(segment)
    if parsed is None:
        return None
    _, inner = parsed
    if not is_code_span_math_like(inner):
        return None
    return unwrap_delimited_code_math(inner, whole_line=whole_line)


def check_code_math_spans_in_file(path: Path, text: str) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    for line_number, (line, in_code_block) in enumerate(split_fenced_lines(text), start=1):
        if in_code_block:
            continue
        for segment, is_inline_code in split_inline_code_segments(line):
            if not is_inline_code:
                continue
            parsed = parse_inline_code_span(segment)
            if parsed is None:
                continue
            _, inner = parsed
            if is_code_span_math_like(inner):
                issues.append(
                    HygieneIssue(path, line_number, f"math is shown as inline code instead of Markdown math: {inner}")
                )
    return issues


def mask_spans(text: str, spans: Iterable[tuple[int, int]]) -> str:
    chars = list(text)
    for start, end in spans:
        for index in range(max(0, start), min(len(chars), end)):
            chars[index] = " "
    return "".join(chars)


def iter_inline_math_spans(segment: str) -> Iterable[tuple[int, int]]:
    spans = [(match.start(), match.end()) for match in DOUBLE_DOLLAR_MATH_RE.finditer(segment)]
    masked = mask_spans(segment, spans)
    spans.extend((match.start(), match.end()) for match in SINGLE_DOLLAR_MATH_RE.finditer(masked))
    masked = mask_spans(segment, spans)
    spans.extend((match.start(), match.end()) for match in PAREN_INLINE_MATH_RE.finditer(masked))
    masked = mask_spans(segment, spans)
    spans.extend((match.start(), match.end()) for match in BRACKET_INLINE_MATH_RE.finditer(masked))
    return spans


def mask_inline_math_spans(segment: str) -> str:
    return mask_spans(segment, iter_inline_math_spans(segment))


def iter_inline_math_contents(segment: str) -> Iterable[tuple[int, int, str, str]]:
    double_spans: list[tuple[int, int]] = []
    for match in DOUBLE_DOLLAR_MATH_RE.finditer(segment):
        double_spans.append((match.start(), match.end()))
        yield match.start(), match.end(), match.group(1), "$$"

    masked = mask_spans(segment, double_spans)
    single_spans: list[tuple[int, int]] = []
    for match in SINGLE_DOLLAR_MATH_RE.finditer(masked):
        single_spans.append((match.start(), match.end()))
        yield match.start(), match.end(), match.group(1), "$"

    masked = mask_spans(masked, single_spans)
    paren_spans: list[tuple[int, int]] = []
    for match in PAREN_INLINE_MATH_RE.finditer(masked):
        paren_spans.append((match.start(), match.end()))
        yield match.start(), match.end(), match.group(1), r"\("

    masked = mask_spans(masked, paren_spans)
    for match in BRACKET_INLINE_MATH_RE.finditer(masked):
        yield match.start(), match.end(), match.group(1), r"\["


def is_display_math_boundary(line: str) -> bool:
    return bool(
        DISPLAY_MATH_DOLLAR_RE.match(line)
        or DISPLAY_MATH_BRACKET_START_RE.match(line)
        or DISPLAY_MATH_BRACKET_END_RE.match(line)
        or DISPLAY_MATH_ENV_START_RE.search(line)
        or DISPLAY_MATH_ENV_END_RE.search(line)
    )


def display_math_state_after_line(line: str, in_display_math: bool) -> bool:
    if DISPLAY_MATH_DOLLAR_RE.match(line):
        return not in_display_math
    if DISPLAY_MATH_BRACKET_START_RE.match(line):
        return True
    if DISPLAY_MATH_BRACKET_END_RE.match(line):
        return False
    starts_env = DISPLAY_MATH_ENV_START_RE.search(line) is not None
    ends_env = DISPLAY_MATH_ENV_END_RE.search(line) is not None
    if starts_env and not ends_env:
        return True
    if ends_env:
        return False
    return in_display_math


def has_table_separator_outside_inline_math(line: str) -> bool:
    masked_parts: list[str] = []
    for segment, is_inline_code in split_inline_code_segments(line):
        if is_inline_code:
            masked_parts.append(" " * len(segment))
            continue
        masked_parts.append(mask_inline_math_spans(segment))
    return UNESCAPED_PIPE_RE.search("".join(masked_parts)) is not None


def collect_markdown_table_lines(text: str) -> set[int]:
    lines = text.splitlines()
    table_lines: set[int] = set()
    in_code_block = False
    code_lines: set[int] = set()

    for index, line in enumerate(lines):
        line_number = index + 1
        if FENCE_RE.match(line):
            code_lines.add(line_number)
            in_code_block = not in_code_block
            continue
        if in_code_block:
            code_lines.add(line_number)

    for index, line in enumerate(lines):
        line_number = index + 1
        if line_number in code_lines or not TABLE_DELIMITER_RE.match(line):
            continue
        if index == 0:
            continue

        header_number = index
        header_line = lines[index - 1]
        if header_number in code_lines or not has_table_separator_outside_inline_math(header_line):
            continue

        table_lines.add(header_number)
        table_lines.add(line_number)

        body_index = index + 1
        while body_index < len(lines):
            body_number = body_index + 1
            if body_number in code_lines or not has_table_separator_outside_inline_math(lines[body_index]):
                break
            table_lines.add(body_number)
            body_index += 1

    return table_lines


def strip_trailing_sentence_punctuation(value: str) -> str:
    stripped = value.rstrip(".,;:!?")
    while stripped.endswith(")") and stripped.count(")") > stripped.count("("):
        stripped = stripped[:-1]
    while stripped.endswith("]") and stripped.count("]") > stripped.count("["):
        stripped = stripped[:-1]
    return stripped


def normalize_reference_label(label: str) -> str:
    return " ".join(label.strip().casefold().split())


def collect_reference_labels(text: str) -> set[str]:
    labels: set[str] = set()
    for line, in_code_block in split_fenced_lines(text):
        if in_code_block:
            continue
        match = REFERENCE_LINK_DEF_LABEL_RE.match(line)
        if match:
            labels.add(normalize_reference_label(match.group(1)))
    return labels


def mask_multiline_clickable_html_spans(text: str) -> str:
    spans: list[tuple[int, int]] = []
    spans.extend((match.start(), match.end()) for match in HTML_ANCHOR_RE.finditer(text))
    spans.extend((match.start(), match.end()) for match in HTML_LINK_TAG_RE.finditer(text))
    spans.extend((match.start(), match.end()) for match in HTML_IMG_TAG_RE.finditer(text))
    return mask_spans(text, spans)


def mask_clickable_reference_spans(segment: str, reference_labels: set[str]) -> str:
    spans: list[tuple[int, int]] = []
    reference_definition = REFERENCE_LINK_DEF_RE.match(segment)
    if reference_definition:
        spans.append((0, len(segment)))
    spans.extend(iter_inline_markdown_link_spans(segment))
    spans.extend((match.start(), match.end()) for match in REFERENCE_LINK_SPAN_RE.finditer(segment))
    spans.extend(
        (match.start(), match.end())
        for match in SHORTCUT_REFERENCE_LINK_SPAN_RE.finditer(segment)
        if normalize_reference_label(match.group(1)) in reference_labels
    )
    spans.extend((match.start(), match.end()) for match in HTML_ANCHOR_RE.finditer(segment))
    spans.extend((match.start(), match.end()) for match in HTML_LINK_TAG_RE.finditer(segment))
    spans.extend((match.start(), match.end()) for match in HTML_IMG_TAG_RE.finditer(segment))
    spans.extend((match.start(), match.end()) for match in AUTOLINK_RE.finditer(segment))
    return mask_spans(segment, spans)


def check_clickable_references_in_file(path: Path, text: str) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    reference_labels = collect_reference_labels(text)
    clickable_text = mask_multiline_clickable_html_spans(text)
    in_display_math = False
    for line_number, (line, in_code_block) in enumerate(split_fenced_lines(clickable_text), start=1):
        if in_code_block:
            continue
        if in_display_math or is_display_math_boundary(line):
            in_display_math = display_math_state_after_line(line, in_display_math)
            continue
        for segment, is_inline_code in split_inline_code_segments(line):
            if is_inline_code:
                continue

            searchable = mask_inline_math_spans(mask_clickable_reference_spans(segment, reference_labels))
            bare_url_spans: list[tuple[int, int]] = []
            for match in BARE_WEB_URL_RE.finditer(searchable):
                bare_url_spans.append((match.start(), match.end()))
                target = strip_trailing_sentence_punctuation(match.group(0))
                issues.append(HygieneIssue(path, line_number, f"bare web URL is not a Markdown link: {target}"))

            searchable_without_urls = mask_spans(searchable, bare_url_spans)
            for match in BARE_DOI_RE.finditer(searchable_without_urls):
                target = strip_trailing_sentence_punctuation(match.group(0))
                issues.append(HygieneIssue(path, line_number, f"bare DOI is not a Markdown link: {target}"))
            for match in BARE_ARXIV_RE.finditer(searchable_without_urls):
                target = strip_trailing_sentence_punctuation(match.group(0))
                issues.append(HygieneIssue(path, line_number, f"bare arXiv identifier is not a Markdown link: {target}"))
    return issues


def check_raw_tokens_in_file(path: Path, text: str, raw_patterns: tuple[tuple[str, re.Pattern[str]], ...]) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    in_display_math = False
    for line_number, (line, in_code_block) in enumerate(split_fenced_lines(text), start=1):
        if in_code_block:
            continue
        if in_display_math or is_display_math_boundary(line):
            in_display_math = display_math_state_after_line(line, in_display_math)
            continue
        for segment, is_inline_code in split_inline_code_segments(line):
            if is_inline_code:
                continue
            searchable = mask_inline_math_spans(segment)
            for token, pattern in raw_patterns:
                if pattern.search(searchable):
                    issues.append(HygieneIssue(path, line_number, f"raw token matched configurable pattern: {token}"))
    return issues


def check_display_math_spacing_in_file(path: Path, text: str) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    lines = text.splitlines()
    in_code_block = False
    in_dollar_display = False

    for index, line in enumerate(lines):
        line_number = index + 1
        if FENCE_RE.match(line):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue

        if "$$" in line and not DISPLAY_MATH_DOLLAR_RE.match(line):
            issues.append(HygieneIssue(path, line_number, "display math delimiter must be on a standalone line"))
            continue

        if not DISPLAY_MATH_DOLLAR_RE.match(line):
            continue

        if not in_dollar_display:
            previous_line = lines[index - 1] if index > 0 else ""
            if previous_line.strip():
                issues.append(HygieneIssue(path, line_number, "opening $$ display delimiter needs a blank line before it"))
            in_dollar_display = True
            continue

        next_line = lines[index + 1] if index + 1 < len(lines) else ""
        if next_line.strip():
            issues.append(HygieneIssue(path, line_number, "closing $$ display delimiter needs a blank line after it"))
        in_dollar_display = False

    return issues


def check_table_math_pipes_in_file(path: Path, text: str) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    table_lines = collect_markdown_table_lines(text)
    in_display_math = False
    for line_number, (line, in_code_block) in enumerate(split_fenced_lines(text), start=1):
        if in_code_block:
            continue
        if in_display_math or is_display_math_boundary(line):
            in_display_math = display_math_state_after_line(line, in_display_math)
            continue
        if line_number not in table_lines:
            continue
        for segment, is_inline_code in split_inline_code_segments(line):
            if is_inline_code:
                continue
            for _, _, content, _ in iter_inline_math_contents(segment):
                if UNESCAPED_PIPE_RE.search(content):
                    issues.append(
                        HygieneIssue(
                            path,
                            line_number,
                            r"literal pipe inside table math can break Markdown tables; use \mid, \lvert/\rvert, or \lVert/\rVert",
                        )
                    )
    return issues


def check_github_math_in_file(path: Path, text: str) -> list[HygieneIssue]:
    issues: list[HygieneIssue] = []
    in_display_math = False
    for line_number, (line, in_code_block) in enumerate(split_fenced_lines(text), start=1):
        if in_code_block:
            continue
        if in_display_math:
            if UNESCAPED_ASTERISK_RE.search(line):
                issues.append(HygieneIssue(path, line_number, r"raw * inside display math may break GitHub math; use \ast"))
            if GFM_FRAGILE_BAR_RE.search(line):
                issues.append(HygieneIssue(path, line_number, r"\bar{...}_... can be fragile in GitHub math; prefer \bar X_..."))
            in_display_math = display_math_state_after_line(line, in_display_math)
            continue
        if is_display_math_boundary(line):
            in_display_math = display_math_state_after_line(line, in_display_math)
            continue

        for segment, is_inline_code in split_inline_code_segments(line):
            if is_inline_code:
                continue
            for start, end, content, delimiter in iter_inline_math_contents(segment):
                if UNESCAPED_ASTERISK_RE.search(content):
                    issues.append(HygieneIssue(path, line_number, r"raw * inside Markdown math may break GitHub math; use \ast"))
                if GFM_FRAGILE_BAR_RE.search(content):
                    issues.append(HygieneIssue(path, line_number, r"\bar{...}_... can be fragile in GitHub math; prefer \bar X_..."))
                if delimiter == "$" and end < len(segment) and segment[end] == ")":
                    issues.append(
                        HygieneIssue(
                            path,
                            line_number,
                            "closing inline math delimiter is immediately followed by ')', which is fragile in GitHub math",
                        )
                    )
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


def fix_code_wrapped_math(text: str) -> tuple[str, int]:
    out: list[str] = []
    changes = 0

    for line, in_code_block in split_fenced_lines(text):
        if in_code_block:
            out.append(line)
            continue

        line_ending = "\n" if line.endswith("\n") else ""
        body = line[:-1] if line_ending else line
        rewritten: list[str] = []
        for segment, is_inline_code in split_inline_code_segments(body):
            if not is_inline_code:
                rewritten.append(segment)
                continue
            replacement = convert_code_span_math(segment, whole_line=body.strip() == segment.strip())
            if replacement is None:
                rewritten.append(segment)
                continue
            rewritten.append(replacement)
            changes += 1
        out.append("".join(rewritten) + line_ending)

    return "".join(out), changes


def fix_display_math_blank_lines(text: str) -> tuple[str, int]:
    out: list[str] = []
    changes = 0
    in_code_block = False
    in_dollar_display = False
    lines = text.splitlines(keepends=True)

    for index, line in enumerate(lines):
        if FENCE_RE.match(line):
            out.append(line)
            in_code_block = not in_code_block
            continue
        if in_code_block or not DISPLAY_MATH_DOLLAR_RE.match(line):
            out.append(line)
            continue

        if not in_dollar_display:
            if out and out[-1].strip():
                out.append("\n")
                changes += 1
            out.append(line)
            in_dollar_display = True
            continue

        out.append(line)
        in_dollar_display = False
        next_line = lines[index + 1] if index + 1 < len(lines) else ""
        if next_line.strip():
            out.append("\n")
            changes += 1

    return "".join(out), changes


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
    check_clickable_refs: bool,
    check_code_math: bool,
    check_display_spacing: bool,
    check_table_math_pipes: bool,
    check_github_math: bool,
    path_prefixes: tuple[str, ...],
    raw_tokens: tuple[str, ...],
) -> int:
    if not (
        check_local_links
        or check_bare_md_paths
        or check_clickable_refs
        or check_code_math
        or check_display_spacing
        or check_table_math_pipes
        or check_github_math
        or raw_tokens
    ):
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
        if check_clickable_refs:
            issues.extend(check_clickable_references_in_file(path, text))
        if check_code_math:
            issues.extend(check_code_math_spans_in_file(path, text))
        if check_display_spacing:
            issues.extend(check_display_math_spacing_in_file(path, text))
        if check_table_math_pipes:
            issues.extend(check_table_math_pipes_in_file(path, text))
        if check_github_math:
            issues.extend(check_github_math_in_file(path, text))
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
                "--check-clickable-refs",
                action="store_true",
                help="Fail when human-facing Markdown has bare web URLs, DOIs, or arXiv IDs instead of clickable links.",
            )
            subparser.add_argument(
                "--check-code-math",
                action="store_true",
                help="Fail when likely math formulas are shown as inline code instead of Markdown math.",
            )
            subparser.add_argument(
                "--check-display-spacing",
                action="store_true",
                help="Fail when $$ display delimiters are not standalone and separated from surrounding prose.",
            )
            subparser.add_argument(
                "--check-table-math-pipes",
                action="store_true",
                help=r"Fail when math inside a Markdown table cell contains literal | instead of \mid or \lVert/\rVert.",
            )
            subparser.add_argument(
                "--check-github-math",
                action="store_true",
                help="Fail on known GitHub/GFM-fragile Markdown math patterns such as raw * inside math.",
            )
            subparser.add_argument(
                "--human-facing",
                action="store_true",
                help=(
                    "Enable human-facing rendered-document checks: local links, bare Markdown paths, "
                    "clickable web/paper references, code-wrapped math, display spacing, table math pipes, "
                    "and the ascii-math raw-math preset."
                ),
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
        human_facing = args.human_facing
        fix_exit = run(
            args.root,
            [
                fix_code_wrapped_math,
                fix_display_math_blank_lines,
                fix_markdown_math_double_backslash,
                fix_toc_latex_escapes,
                fix_display_math_leading_continuation_lines,
            ],
            check=True,
        )
        preset_tokens: list[str] = []
        raw_math_presets = list(args.raw_math_preset)
        if human_facing and "ascii-math" not in raw_math_presets:
            raw_math_presets.append("ascii-math")
        for preset_name in raw_math_presets:
            preset_tokens.extend(RAW_MATH_PRESETS[preset_name])

        extra_exit = run_extra_checks(
            args.root,
            check_local_links=args.check_local_links or human_facing,
            check_bare_md_paths=args.check_bare_md_paths or human_facing,
            check_clickable_refs=args.check_clickable_refs or human_facing,
            check_code_math=args.check_code_math or human_facing,
            check_display_spacing=args.check_display_spacing or human_facing,
            check_table_math_pipes=args.check_table_math_pipes or human_facing,
            check_github_math=args.check_github_math,
            path_prefixes=tuple(DEFAULT_BARE_MD_PATH_PREFIXES + tuple(args.path_prefix)),
            raw_tokens=tuple(args.raw_token + preset_tokens),
        )
        return 1 if fix_exit or extra_exit else 0
    if args.command == "fix":
        return run(
            args.root,
            [
                fix_code_wrapped_math,
                fix_display_math_blank_lines,
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
