#!/usr/bin/env python3
"""Independent fixture generator for <DATASET>.

Contract for this file
----------------------
- It must NOT import application code. The whole point is an independent second
  implementation of the frozen rules.
- It opens the dataset read-only.
- It pins the schema version and refuses to run against another version.
- Its output is deterministic: sorted keys, explicit ordering, no timestamps, no
  environment-dependent fields. Two runs must be byte-identical.

Fill the SPEC block, then:

    python3 tool/fixture_generator.py --db <dataset> --out <fixture.json>
    python3 tool/fixture_generator.py --db <dataset> --out <fixture.json> --check

`--check` regenerates in memory and compares with the committed fixture.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

GENERATOR_VERSION = "1"

# --------------------------------------------------------------------------
# SPEC — fill this in. Every query must be read-only and deterministic.
# --------------------------------------------------------------------------
SPEC = {
    "dataset": "<DATASET>",
    "schema_probe": "SELECT value FROM <meta_table> WHERE key = 'schema_version'",
    "schema_expected": "<SCHEMA_VERSION>",
    # Partition: one entry per frozen-rule class. "total" must equal the sum.
    "partition": [
        {"class": "<class_a>", "sql": "SELECT COUNT(*) FROM <table> WHERE <cond>"},
        {"class": "<class_b>", "sql": "SELECT COUNT(*) FROM <table> WHERE <cond>"},
    ],
    "total_sql": "SELECT COUNT(*) FROM <table>",
    # Named examples backing the rules: positive and negative.
    "examples": [
        {"id": "<example_id>", "sql": "SELECT <cols> FROM <table> WHERE <key> = ?", "params": ["<key>"]},
    ],
}

PLACEHOLDER = "<"


def fail(message: str, code: int = 1) -> "NoReturn":
    print(f"fixture_generator: {message}", file=sys.stderr)
    raise SystemExit(code)


def open_readonly(path: Path) -> sqlite3.Connection:
    uri = f"file:{path}?mode=ro&immutable=1"
    return sqlite3.connect(uri, uri=True)


def check_spec() -> None:
    blob = json.dumps(SPEC, ensure_ascii=False)
    if PLACEHOLDER in blob:
        fail("SPEC still contains placeholder values; fill them before running", code=2)


def scalar(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> object:
    row = conn.execute(sql, params).fetchone()
    if row is None:
        fail(f"query returned no row: {sql}")
    return row[0]


def build(conn: sqlite3.Connection, dataset_sha: str, schema: str) -> dict:
    partition = {}
    for entry in SPEC["partition"]:
        partition[entry["class"]] = int(scalar(conn, entry["sql"]))
    total = int(scalar(conn, SPEC["total_sql"]))
    if sum(partition.values()) != total:
        fail(
            "partition does not cover the dataset: "
            f"{partition} sums to {sum(partition.values())}, total is {total}"
        )

    examples = {}
    for entry in SPEC["examples"]:
        rows = conn.execute(entry["sql"], tuple(entry.get("params", ()))).fetchall()
        examples[entry["id"]] = [list(row) for row in rows]

    return {
        "schema": "scientific_data_app_fixture_v1",
        "generator_version": GENERATOR_VERSION,
        "dataset": SPEC["dataset"],
        "dataset_sha256": dataset_sha,
        "dataset_schema": schema,
        "partition": dict(sorted(partition.items())),
        "total": total,
        "examples": dict(sorted(examples.items())),
    }


def canonical(payload: dict) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--check",
        action="store_true",
        help="regenerate in memory and compare with --out instead of writing",
    )
    args = parser.parse_args()

    if not args.db.exists():
        fail(f"dataset not found: {args.db}", code=2)
    check_spec()

    dataset_sha = hashlib.sha256(args.db.read_bytes()).hexdigest()
    conn = open_readonly(args.db)
    try:
        schema = str(scalar(conn, SPEC["schema_probe"]))
        if schema != SPEC["schema_expected"]:
            fail(f"schema mismatch: dataset has {schema}, generator expects {SPEC['schema_expected']}", code=2)
        payload = build(conn, dataset_sha, schema)
    finally:
        conn.close()

    data = canonical(payload)
    if args.check:
        if not args.out.exists():
            fail(f"no committed fixture at {args.out}", code=2)
        if args.out.read_bytes() != data:
            fail(f"fixture drift: {args.out} differs from a fresh run")
        print(f"fixture ok: {args.out} ({len(data)} bytes)")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(data)
    print(f"wrote {args.out} ({len(data)} bytes, {payload['total']} records)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
