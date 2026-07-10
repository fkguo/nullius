#!/usr/bin/env python3
"""Fail if any connected data series mixes evaluator fingerprints.

The plotting table must expose one row per plotted point, a series identifier,
and a SHA-256 evaluator fingerprint produced upstream from canonical serialized
model/branch, numerical configuration, source/dependency, and transformation
metadata. This tool verifies presence and within-series homogeneity; it cannot
prove that an upstream fingerprint omitted no fields.

Exit codes: 0 homogeneous, 1 provenance findings, 2 usage/schema error.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path


_SHA256 = re.compile(r"(?:sha256:)?([0-9a-fA-F]{64})\Z", re.IGNORECASE)
_TRUTHY = {"1", "true", "yes", "y", "connected"}
_FALSY = {"0", "false", "no", "n", "unconnected", ""}


def _normalise_fingerprint(raw: str) -> str | None:
    match = _SHA256.fullmatch(raw.strip())
    return match.group(1).lower() if match else None


def check_table(
    path: Path,
    *,
    series_column: str,
    fingerprint_column: str,
    connected_column: str | None,
) -> tuple[list[dict[str, object]], dict[str, object]]:
    findings: list[dict[str, object]] = []
    groups: dict[str, list[tuple[int, str | None, str]]] = defaultdict(list)

    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        fieldnames = list(reader.fieldnames or [])
        if len(fieldnames) != len(set(fieldnames)):
            # DictReader silently keeps the LAST duplicate column, so a
            # malformed table (column-concatenation tools produce these) could
            # pass a genuinely mixed series as clean. Refuse instead.
            duplicates = sorted({name for name in fieldnames if fieldnames.count(name) > 1})
            raise ValueError(f"duplicate column header(s): {', '.join(duplicates)}")
        fields = set(fieldnames)
        required = {series_column, fingerprint_column}
        if connected_column:
            required.add(connected_column)
        missing_columns = sorted(required - fields)
        if missing_columns:
            raise ValueError(f"missing required column(s): {', '.join(missing_columns)}")

        input_rows = 0
        connected_rows = 0
        for row_number, row in enumerate(reader, start=2):
            input_rows += 1
            if connected_column:
                connected = (row.get(connected_column) or "").strip().lower()
                if connected in _FALSY:
                    continue
                if connected not in _TRUTHY:
                    # An unrecognized value must not silently exempt the row:
                    # a typo in the status column would otherwise skip the check.
                    raise ValueError(
                        f"row {row_number}: unrecognized {connected_column} value {connected!r} "
                        f"(recognized true: {sorted(_TRUTHY)}; false: {sorted(_FALSY - {''})} or empty)"
                    )
            connected_rows += 1
            series = (row.get(series_column) or "").strip()
            raw = (row.get(fingerprint_column) or "").strip()
            if not series:
                findings.append(
                    {
                        "kind": "missing-series-id",
                        "row": row_number,
                        "message": f"row {row_number} has no {series_column}",
                    }
                )
                continue
            groups[series].append((row_number, _normalise_fingerprint(raw), raw))

    if input_rows == 0:
        raise ValueError("data table has no rows")
    if connected_rows == 0:
        raise ValueError("data table has no connected rows to check")

    for series, rows in sorted(groups.items()):
        invalid = [(row_number, raw) for row_number, fingerprint, raw in rows if fingerprint is None]
        for row_number, raw in invalid:
            kind = "missing-fingerprint" if not raw else "invalid-fingerprint"
            findings.append(
                {
                    "kind": kind,
                    "series": series,
                    "row": row_number,
                    "message": (
                        f"series {series!r} row {row_number} has no evaluator fingerprint"
                        if not raw
                        else f"series {series!r} row {row_number} fingerprint is not SHA-256"
                    ),
                }
            )
        valid = sorted({fingerprint for _, fingerprint, _ in rows if fingerprint is not None})
        if len(valid) > 1:
            findings.append(
                {
                    "kind": "mixed-fingerprints",
                    "series": series,
                    "fingerprints": valid,
                    "message": f"series {series!r} contains {len(valid)} evaluator fingerprints",
                }
            )

    summary = {
        "data": str(path),
        "series_checked": len(groups),
        "connected_rows_checked": connected_rows,
        "homogeneous": not findings,
    }
    return findings, summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", required=True, help="CSV table with one row per plotted point")
    parser.add_argument("--series-column", default="series_id")
    parser.add_argument("--fingerprint-column", default="evaluator_fingerprint")
    parser.add_argument(
        "--connected-column",
        help="optional boolean/status column; only truthy connected rows are checked",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    path = Path(args.data)
    if not path.is_file():
        print(f"check_series_provenance: data not found: {path}", file=sys.stderr)
        return 2
    try:
        findings, summary = check_table(
            path,
            series_column=args.series_column,
            fingerprint_column=args.fingerprint_column,
            connected_column=args.connected_column,
        )
    except (OSError, csv.Error, ValueError) as exc:
        print(f"check_series_provenance: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps({**summary, "findings": findings}, indent=2))
    else:
        for finding in findings:
            print(f"{finding['kind']}: {finding['message']}")
        if not findings:
            print(
                "series provenance clean: "
                f"{summary['series_checked']} series, "
                f"{summary['connected_rows_checked']} connected rows"
            )
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
