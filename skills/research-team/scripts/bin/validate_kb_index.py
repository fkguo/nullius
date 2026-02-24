#!/usr/bin/env python3
"""
Validate a kb_index.json produced by `kb_export.py kb-index`.

This script is offline/deterministic. It prefers `jsonschema` if installed, but
falls back to a minimal built-in validator (covers the required fields/types).

Usage:
  python3 validate_kb_index.py /path/to/kb_index.json
  python3 validate_kb_index.py /path/to/kb_index.json --schema scripts/schemas/kb_index.schema.json

Exit codes:
  0  PASS
  1  FAIL (schema/structure errors)
  2  Input/execution error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_LAYER_SET = {"Library", "Methodology", "Priors"}


def _default_schema_path() -> Path:
    return (Path(__file__).resolve().parent.parent / "schemas" / "kb_index.schema.json").resolve()


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _validate_minimal(obj: Any) -> list[str]:
    issues: list[str] = []
    if not isinstance(obj, dict):
        return ["top-level must be an object"]

    if obj.get("version") != 1:
        issues.append("version must be 1")
    if obj.get("kb_root") != "knowledge_base":
        issues.append("kb_root must be 'knowledge_base'")

    entries = obj.get("entries")
    if not isinstance(entries, list):
        issues.append("entries must be a list")
        return issues

    for i, e in enumerate(entries):
        if not isinstance(e, dict):
            issues.append(f"entries[{i}] must be an object")
            continue
        layer = e.get("layer")
        if layer not in _LAYER_SET:
            issues.append(f"entries[{i}].layer must be one of {sorted(_LAYER_SET)}")
        for k in ("refkey", "title", "path"):
            v = e.get(k)
            if not isinstance(v, str) or not v.strip():
                issues.append(f"entries[{i}].{k} must be a non-empty string")

        links = e.get("links")
        if not isinstance(links, dict):
            issues.append(f"entries[{i}].links must be an object")
        else:
            for k in ("inspire", "arxiv", "doi", "other"):
                v = links.get(k)
                if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
                    issues.append(f"entries[{i}].links.{k} must be a list of strings")

        ev = e.get("evidence_paths")
        if not isinstance(ev, list) or not ev or any(not isinstance(x, str) or not x.strip() for x in ev):
            issues.append(f"entries[{i}].evidence_paths must be a non-empty list of non-empty strings")

        mtime_ns = e.get("mtime_ns")
        if not isinstance(mtime_ns, int) or mtime_ns < 0:
            issues.append(f"entries[{i}].mtime_ns must be a non-negative integer")

        sha256 = e.get("sha256")
        if not isinstance(sha256, str) or not _SHA256_RE.match(sha256):
            issues.append(f"entries[{i}].sha256 must be a 64-hex sha256 string")

    return issues


def _validate_jsonschema(obj: Any, schema: Any) -> list[str]:
    try:
        import jsonschema  # type: ignore
    except Exception:
        return ["jsonschema not installed (fallback validator only)"]

    try:
        jsonschema.validate(instance=obj, schema=schema)
        return []
    except Exception as exc:
        return [str(exc)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("kb_index", type=Path, help="Path to kb_index.json")
    ap.add_argument("--schema", type=Path, default=_default_schema_path(), help="Path to kb_index JSON schema.")
    ap.add_argument("--prefer-jsonschema", action="store_true", help="Fail if jsonschema is not installed.")
    args = ap.parse_args()

    if not args.kb_index.is_file():
        print(f"ERROR: not found: {args.kb_index}", file=sys.stderr)
        return 2
    if not args.schema.is_file():
        print(f"ERROR: schema not found: {args.schema}", file=sys.stderr)
        return 2

    try:
        obj = _load_json(args.kb_index)
    except Exception as exc:
        print(f"ERROR: failed to parse JSON: {args.kb_index}: {exc}", file=sys.stderr)
        return 2

    try:
        schema = _load_json(args.schema)
    except Exception as exc:
        print(f"ERROR: failed to parse schema JSON: {args.schema}: {exc}", file=sys.stderr)
        return 2

    schema_issues = _validate_jsonschema(obj, schema)
    if schema_issues:
        if args.prefer_jsonschema and any("not installed" in x for x in schema_issues):
            print("Gate: FAIL (jsonschema missing)", file=sys.stderr)
            for it in schema_issues:
                print(f"- {it}", file=sys.stderr)
            return 1
        if not any("not installed" in x for x in schema_issues):
            print("Gate: FAIL (jsonschema)", file=sys.stderr)
            for it in schema_issues:
                print(f"- {it}", file=sys.stderr)
            return 1

    fallback_issues = _validate_minimal(obj)
    if fallback_issues:
        print("Gate: FAIL", file=sys.stderr)
        for it in fallback_issues[:200]:
            print(f"- {it}", file=sys.stderr)
        if len(fallback_issues) > 200:
            print(f"... ({len(fallback_issues) - 200} more)", file=sys.stderr)
        return 1

    print("Gate: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

