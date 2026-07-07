#!/usr/bin/env python3
"""Normalize human-facing posterior values in Markdown idea reports.

Exact posterior values live in JSON artifacts and the idea-store snapshot.
Markdown reports are for readers, so ``Posterior value:`` lines display a
three-decimal value such as ``0.926``.
"""

from __future__ import annotations

import argparse
import re
import sys
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Iterable, Optional

POSTERIOR_VALUE_RE = re.compile(
    r"(?P<prefix>^(?:\s*[-*]\s*)?(?:\*\*)?Posterior value(?:\*\*)?:\s*)"
    r"(?P<open>`?)"
    r"(?P<value>[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
    r"(?P=open)"
    r"(?P<suffix>.*)$",
    re.IGNORECASE | re.MULTILINE,
)

THREE_DECIMALS = Decimal("0.001")


def rounded_posterior(value: str) -> str:
    try:
        decimal = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"posterior value is not numeric: {value!r}") from exc
    if decimal < 0 or decimal > 1:
        raise ValueError(f"posterior value must be in [0, 1], got {value!r}")
    return format(decimal.quantize(THREE_DECIMALS, rounding=ROUND_HALF_UP), "f")


def normalize_text(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        value = rounded_posterior(match.group("value"))
        return f"{match.group('prefix')}{match.group('open')}{value}{match.group('open')}{match.group('suffix')}"

    return POSTERIOR_VALUE_RE.sub(replace, text)


def normalize_file(path: Path, check: bool = False) -> bool:
    original = path.read_text(encoding="utf-8")
    updated = normalize_text(original)
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
    parser.add_argument("--check", action="store_true", help="Exit nonzero if any file would change")
    parser.add_argument("paths", nargs="+", help="Markdown report files or directories")
    args = parser.parse_args(argv)

    changed: list[str] = []
    try:
        for path in iter_report_paths(args.paths):
            if path.suffix.lower() != ".md":
                continue
            if normalize_file(path.resolve(), check=args.check):
                changed.append(str(path))
    except ValueError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2

    if changed:
        for path in changed:
            print(path)
        return 1 if args.check else 0
    return 0


if __name__ == "__main__":
    sys.exit(run())
