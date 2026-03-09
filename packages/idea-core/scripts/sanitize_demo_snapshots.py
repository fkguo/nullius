#!/usr/bin/env python3
"""Rewrite checked-in demo snapshots to remove machine-local absolute paths."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

DEFAULT_DEMO_ROOT = Path("docs/demos/2026-02-13-m2.12-demo-v1")
PORTABLE_URI_ROOT = "demo://m2-12-replay-demo"


def _portable_run_path(demo_root: Path, run_tag: str) -> str:
    return demo_root.as_posix().rstrip("/") + f"/{run_tag}"


def _portable_run_uri(run_tag: str) -> str:
    return f"{PORTABLE_URI_ROOT}/{run_tag}"


def _replace_string(
    value: str,
    *,
    demo_root_rel: Path,
) -> str:
    demo_root_rel_str = demo_root_rel.as_posix().rstrip("/")
    updated = value
    demo_rel_regex = re.escape(demo_root_rel_str)
    run_tag_pattern = r"run-[A-Za-z0-9._-]+|<run_tag>"
    file_uri_pattern = re.compile(
        rf"file://[^\"']*?{demo_rel_regex}/(?P<run_tag>{run_tag_pattern})(?P<suffix>/[^\"']*)?"
    )
    abs_path_pattern = re.compile(
        rf"/[^\"']*?{demo_rel_regex}/(?P<run_tag>{run_tag_pattern})(?P<suffix>/[^\"']*)?"
    )

    updated = file_uri_pattern.sub(
        lambda match: _portable_run_uri(match.group("run_tag")) + (match.group("suffix") or ""),
        updated,
    )
    updated = abs_path_pattern.sub(
        lambda match: _portable_run_path(demo_root_rel, match.group("run_tag"))
        + (match.group("suffix") or ""),
        updated,
    )
    return updated


def _rewrite_json(value: Any, *, demo_root_rel: Path) -> Any:
    if isinstance(value, dict):
        return {
            key: _rewrite_json(child, demo_root_rel=demo_root_rel)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [
            _rewrite_json(item, demo_root_rel=demo_root_rel)
            for item in value
        ]
    if isinstance(value, str):
        return _replace_string(value, demo_root_rel=demo_root_rel)
    return value


def _rewrite_file(path: Path, *, demo_root_rel: Path) -> bool:
    original = json.loads(path.read_text(encoding="utf-8"))
    rewritten = _rewrite_json(original, demo_root_rel=demo_root_rel)
    if rewritten == original:
        return False
    path.write_text(json.dumps(rewritten, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--demo-root",
        type=Path,
        default=DEFAULT_DEMO_ROOT,
        help="Path to the checked-in M2.12 demo root.",
    )
    args = parser.parse_args()

    demo_root = args.demo_root.resolve()
    if not demo_root.is_dir():
        raise SystemExit(f"demo root not found: {demo_root}")

    repo_root = Path.cwd().resolve()
    demo_root_rel = args.demo_root if args.demo_root.is_absolute() else args.demo_root

    updated_files = 0
    for path in sorted(demo_root.rglob("*.json")):
        updated_files += int(_rewrite_file(path, demo_root_rel=demo_root_rel))

    print(f"Updated {updated_files} demo snapshot file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
