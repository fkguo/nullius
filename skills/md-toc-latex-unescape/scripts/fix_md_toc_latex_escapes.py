#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


TOC_START_RE = re.compile(r"^\s*##+\s+(目录|table of contents|contents)\b", re.IGNORECASE)
HR_RE = re.compile(r"^\s*---\s*$")
FENCE_RE = re.compile(r"^\s*```")

SINGLE_DOLLAR_MATH_RE = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)")
DOUBLE_DOLLAR_MATH_RE = re.compile(r"\$\$(.+?)\$\$")


def fix_math(expr: str) -> str:
    # Undo TOC-generator escaping inside math, without touching legit LaTeX line breaks ("\\"
    # followed by whitespace/end).
    expr = re.sub(r"\\\\(?=[A-Za-z_])", r"\\", expr)
    expr = expr.replace(r"\_", "_")
    expr = expr.replace(r"\*", "*")
    expr = expr.replace(r"\^", "^")
    return expr


def fix_math_in_line(line: str) -> str:
    line = DOUBLE_DOLLAR_MATH_RE.sub(lambda m: "$$" + fix_math(m.group(1)) + "$$", line)
    line = SINGLE_DOLLAR_MATH_RE.sub(lambda m: "$" + fix_math(m.group(1)) + "$", line)
    return line


def process_text(text: str) -> tuple[str, int]:
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    in_toc = False
    in_code = False
    changes = 0

    for line in lines:
        if FENCE_RE.match(line):
            in_code = not in_code

        if not in_toc and not in_code and TOC_START_RE.match(line):
            in_toc = True
            out.append(line)
            continue

        if in_toc and not in_code and HR_RE.match(line):
            in_toc = False
            out.append(line)
            continue

        if in_toc and not in_code:
            fixed = fix_math_in_line(line)
            if fixed != line:
                changes += 1
            out.append(fixed)
        else:
            out.append(line)

    return ("".join(out), changes)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Fix LaTeX escaping introduced by Markdown TOC generators inside the TOC block "
            "(between a TOC heading and the next '---'), rewriting only math segments."
        )
    )
    parser.add_argument(
        "paths",
        nargs="+",
        type=Path,
        help="Markdown files to process (in-place by default).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write; exit 1 if changes would be made.",
    )
    args = parser.parse_args(argv)

    any_changes = False

    for path in args.paths:
        original = path.read_text(encoding="utf-8")
        updated, changed_lines = process_text(original)

        if changed_lines > 0:
            any_changes = True

        if not args.check and updated != original:
            path.write_text(updated, encoding="utf-8")

    return 1 if (args.check and any_changes) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

