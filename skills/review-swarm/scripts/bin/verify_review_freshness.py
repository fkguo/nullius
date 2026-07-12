#!/usr/bin/env python3
"""Verify that a review still applies to the current input bytes.

The reviewer judges the packet assembled at launch. This checker compares every
file-backed input and any git-diff target with the hashes recorded in
``inputs/review_input_manifest.json``. A changed, missing, or unreadable input
makes the review stale; it does not rewrite the model's historical verdict. The
manifest is the trusted launch record, not a signature: commit it or record its
hash outside the mutable review directory when deliberate co-editing is in scope.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


MANIFEST_RELATIVE_PATH = Path("inputs") / "review_input_manifest.json"
REPORT_FILENAME = "post_review_freshness.json"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _check_file_entry(entry: dict[str, Any]) -> dict[str, Any]:
    path = Path(str(entry.get("path", "")))
    reviewed_sha256 = str(entry.get("sha256", ""))
    result = {
        "kind": entry.get("kind"),
        "path": str(path),
        "reviewed_sha256": reviewed_sha256,
        "current_sha256": None,
        "status": "unreadable",
    }
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        result["status"] = "missing"
        return result
    except OSError as exc:
        result["status"] = "unreadable"
        result["error"] = str(exc)
        return result

    current_sha256 = _sha256(data)
    result["current_sha256"] = current_sha256
    result["status"] = "fresh" if current_sha256 == reviewed_sha256 else "changed"
    return result


def _check_diff_target(entry: dict[str, Any], *, working_directory: Path) -> dict[str, Any]:
    diff_range = str(entry.get("range", ""))
    reviewed_sha256 = str(entry.get("sha256", ""))
    result = {
        "range": diff_range,
        "working_directory": str(working_directory),
        "reviewed_sha256": reviewed_sha256,
        "current_sha256": None,
        "status": "unreadable",
    }
    if not diff_range or diff_range.startswith("-"):
        result["status"] = "invalid_range"
        result["error"] = "diff range is empty or starts with '-'"
        return result
    try:
        proc = subprocess.run(
            ["git", "diff", "--no-ext-diff", "--no-textconv", diff_range],
            cwd=working_directory,
            check=False,
            capture_output=True,
        )
    except OSError as exc:
        result["status"] = "unreadable"
        result["error"] = str(exc)
        return result
    if proc.returncode != 0:
        result["status"] = "diff_failed"
        result["error"] = proc.stderr.decode("utf-8", errors="replace").strip()
        return result

    current_sha256 = _sha256(proc.stdout)
    result["current_sha256"] = current_sha256
    result["status"] = "fresh" if current_sha256 == reviewed_sha256 else "changed"
    return result


def build_report(manifest: dict[str, Any]) -> dict[str, Any]:
    working_directory = Path(str(manifest.get("working_directory", "")))
    file_results = [
        _check_file_entry(entry) for entry in list(manifest.get("file_inputs") or [])
    ]
    diff_result = None
    diff_entry = manifest.get("target_diff")
    if isinstance(diff_entry, dict):
        diff_result = _check_diff_target(diff_entry, working_directory=working_directory)

    statuses = [entry["status"] for entry in file_results]
    if diff_result is not None:
        statuses.append(diff_result["status"])
    fresh = bool(statuses) and all(status == "fresh" for status in statuses)
    return {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "status": "FRESH" if fresh else "STALE",
        "role": manifest.get("role"),
        "file_inputs": file_results,
        "target_diff": diff_result,
    }


def verify_review_dir(review_dir: Path) -> tuple[dict[str, Any], Path]:
    review_dir = review_dir.expanduser().resolve()
    manifest_path = review_dir / MANIFEST_RELATIVE_PATH
    if not manifest_path.is_file():
        raise ValueError(f"review input manifest not found: {manifest_path}")
    try:
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read review input manifest {manifest_path}: {exc}") from exc
    if manifest.get("schema_version") != 1:
        raise ValueError(
            f"unsupported review input manifest version: {manifest.get('schema_version')!r}"
        )
    file_inputs = manifest.get("file_inputs")
    if not isinstance(file_inputs, list) or any(
        not isinstance(entry, dict) for entry in file_inputs
    ):
        raise ValueError("review input manifest file_inputs must be a list of objects")
    target_diff = manifest.get("target_diff")
    if target_diff is not None and not isinstance(target_diff, dict):
        raise ValueError("review input manifest target_diff must be an object or null")
    working_directory = manifest.get("working_directory")
    if not isinstance(working_directory, str) or not working_directory:
        raise ValueError("review input manifest working_directory must be a non-empty string")
    report = build_report(manifest)
    report["manifest_sha256"] = _sha256(manifest_bytes)
    return report, manifest_path


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-dir", required=True, type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional JSON report path; stdout always receives the report.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    try:
        report, manifest_path = verify_review_dir(args.review_dir)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    report["manifest_path"] = str(manifest_path)
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        output_path = args.output.expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if report["status"] == "FRESH" else 3


if __name__ == "__main__":
    raise SystemExit(main())
