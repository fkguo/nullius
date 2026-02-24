#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def _replace_pointer_lint_section(lines: list[str], replacement: str) -> tuple[list[str], bool]:
    start = None
    for i, ln in enumerate(lines):
        if re.match(r"^##\s+1\.5\)\s+Pointer\s+lint\s+preflight\s*\(auto\)\s*$", ln.strip()):
            start = i
            break
    if start is None:
        return (lines, False)

    end = len(lines)
    for j in range(start + 1, len(lines)):
        if re.match(r"^##\s+", lines[j]):
            end = j
            break

    new_lines = lines[: start + 1]
    new_lines.append("\n")
    if replacement:
        for ln in replacement.splitlines():
            new_lines.append(ln.rstrip() + "\n")
    new_lines.append("\n")
    new_lines.extend(lines[end:])
    return (new_lines, True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Patch a team packet copy for traceability (tag + pointer-lint section).")
    ap.add_argument("--src", type=Path, required=True, help="Source packet file.")
    ap.add_argument("--dst", type=Path, required=True, help="Destination patched packet file.")
    ap.add_argument("--tag", required=True, help="Resolved tag to stamp into the packet.")
    ap.add_argument("--pointer-lint-report", type=Path, required=True, help="Pointer lint report path (may be missing).")
    args = ap.parse_args()

    src = args.src
    dst = args.dst
    tag = args.tag
    lint = args.pointer_lint_report

    if not src.is_file():
        print(f"ERROR: packet not found: {src}", file=sys.stderr)
        return 2

    text = src.read_text(encoding="utf-8", errors="replace").splitlines(True)
    out: list[str] = []
    lint_text = lint.read_text(encoding="utf-8", errors="replace").rstrip() if lint.is_file() else ""

    text, replaced = _replace_pointer_lint_section(text, lint_text)
    has_appendix_lint = any("Appendix B) Pointer lint preflight (auto)" in ln for ln in text)

    for line in text:
        if re.match(r"^Tag:\s*", line):
            out.append(f"Tag: {tag}\n")
            continue
        if re.match(r"^-\s+Round/tag:\s*", line):
            out.append(f"- Round/tag: {tag}\n")
            continue
        out.append(line)

    if not replaced and not has_appendix_lint and lint_text:
        out.append("\n")
        out.append("## Appendix B) Pointer lint preflight (auto)\n\n")
        out.append(lint_text + "\n")

    dst.write_text("".join(out), encoding="utf-8")
    print("Wrote patched packet:", dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

