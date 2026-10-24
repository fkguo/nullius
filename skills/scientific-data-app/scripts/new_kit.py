#!/usr/bin/env python3
"""Scaffold a scientific-data-app design kit into a repository.

Copies the skill's templates into --target without overwriting existing files.
Refuses when a destination file already exists unless --force is given.

Usage:
    python3 new_kit.py --target /path/to/design-docs-repo
    python3 new_kit.py --target . --force
    python3 new_kit.py --target . --dry-run
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATES = HERE.parent / "assets" / "templates"

# template path -> destination path inside the target repository
LAYOUT = {
    "AGENTS.md": "AGENTS.md",
    "PORT_LEDGER.md": "PORT_LEDGER.md",
    "docs/00-data-atlas.md": "docs/00-data-atlas.md",
    "docs/01-product-ux.md": "docs/01-product-ux.md",
    "docs/02-interface-contract.md": "docs/02-interface-contract.md",
    "docs/03-frozen-rules.md": "docs/03-frozen-rules.md",
    "docs/04-acceptance-matrix.md": "docs/04-acceptance-matrix.md",
    "docs/05-review-record.md": "docs/reviews/00-review-record.md",
    "docs/06-handoff.md": "docs/06-handoff.md",
    "docs/07-release.md": "docs/07-release.md",
    "criteria/product.md": "docs/criteria/product.md",
    "criteria/technical.md": "docs/criteria/technical.md",
    "tool/fixture_generator.py": "tool/fixture_generator.py",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--force", action="store_true", help="overwrite existing files")
    parser.add_argument("--dry-run", action="store_true", help="print actions only")
    args = parser.parse_args()

    target = args.target.resolve()
    if not target.is_dir():
        print(f"new_kit: target is not a directory: {target}", file=sys.stderr)
        return 2
    if not TEMPLATES.is_dir():
        print(f"new_kit: templates missing at {TEMPLATES}", file=sys.stderr)
        return 2

    conflicts = [
        dest for dest in LAYOUT.values() if (target / dest).exists() and not args.force
    ]
    if conflicts and not args.dry_run:
        print("new_kit: refusing to overwrite existing files:", file=sys.stderr)
        for dest in conflicts:
            print(f"  {dest}", file=sys.stderr)
        print("Use --force to overwrite.", file=sys.stderr)
        return 1

    created = 0
    for src_rel, dest_rel in LAYOUT.items():
        src = TEMPLATES / src_rel
        dest = target / dest_rel
        if args.dry_run:
            print(f"would copy {src_rel} -> {dest_rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        created += 1

    if args.dry_run:
        return 0

    print(f"new_kit: created {created} files under {target}")
    print("Next:")
    print("  1. Fill docs/00-data-atlas.md and verify its counts independently.")
    print(f"  2. Run: python3 {HERE / 'check_kit.py'} --kit-root . --gate G0")
    print("  3. Do not start application code before G2 is recorded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
