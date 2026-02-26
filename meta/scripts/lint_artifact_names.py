#!/usr/bin/env python3
"""M-01: Lint hardcoded artifact filenames in writeRunJsonArtifact / writeRunArtifact calls.

Scans packages/hep-mcp/src/ for string-literal artifact names and validates
them against the naming convention:

    ^[a-z]+_[a-z_]+(_\\d{3})?_v\\d+\\.(json|tex|jsonl|md)$

Exemptions:
  - packet_short.md / packet.md  (GATE-05 human-approval artifacts)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCAN_DIR = REPO_ROOT / "packages" / "hep-mcp" / "src"

# Matches: writeRunJsonArtifact(xxx, 'name.json', ...) or writeRunArtifact(xxx, 'name.ext', ...)
# Captures the string literal (group 1) used as the second argument.
CALL_RE = re.compile(
    r"""(?:writeRunJsonArtifact|writeRunArtifact)\s*\(\s*"""
    r"""[^,]+,\s*"""           # first arg (run_id)
    r"""['"]([^'"]+)['"]\s*""" # second arg: captured string literal
    r"""[,)]""",
)

NAME_RE = re.compile(r"^[a-z]+_[a-z_]+(_\d{3})?_v\d+\.(json|tex|jsonl|md)$")

EXEMPT = {"packet_short.md", "packet.md"}

violations: list[tuple[str, int, str]] = []


def scan_file(path: Path) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        for m in CALL_RE.finditer(line):
            name = m.group(1)
            if name in EXEMPT:
                continue
            if not NAME_RE.match(name):
                rel = path.relative_to(REPO_ROOT)
                violations.append((str(rel), i, name))


def main() -> int:
    if not SCAN_DIR.is_dir():
        print(f"ERROR: scan directory not found: {SCAN_DIR}", file=sys.stderr)
        return 1

    for ts_file in sorted(SCAN_DIR.rglob("*.ts")):
        scan_file(ts_file)

    if violations:
        print(f"M-01 artifact naming violations ({len(violations)}):\n")
        for rel, line, name in violations:
            print(f"  {rel}:{line}  {name}")
        print(
            f"\nExpected pattern: [a-z]+_[a-z_]+(_\\d{{3}})?_v\\d+.(json|tex|jsonl|md)"
        )
        return 1

    print("M-01 artifact naming: OK — all hardcoded names conform")
    return 0


if __name__ == "__main__":
    sys.exit(main())
