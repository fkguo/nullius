#!/usr/bin/env python3
"""Commit the comparison criteria for one pairwise idea match.

Produces a criteria_commitment JSON object and writes it to disk BEFORE any
advocacy statement is drafted and BEFORE any judge runs:

    {
      "committed_at": "2026-07-05T08:00:00+00:00",
      "criteria": ["...", "..."],
      "commitment_hash": "sha256:<64 hex digits>"
    }

The hash covers ONLY the canonicalized criteria list, never the timestamp, so
the same criteria set yields the same hash regardless of input order, spacing,
or Unicode normalization form of the input strings.

Canonicalization, in order:
  1. Unicode NFC normalization of each criterion.
  2. Trim leading and trailing whitespace; collapse internal whitespace runs
     to a single space.
  3. Reject empty strings and duplicates (both are caller mistakes).
  4. Sort by Unicode code point.
  5. Serialize the sorted list as compact JSON (ensure_ascii=False,
     separators "," and ":"), encode UTF-8, hash with sha256.

The stored "criteria" array is the canonicalized, sorted list, so identical
criteria sets produce byte-identical criteria arrays everywhere downstream.

This script refuses to overwrite an existing commitment file: changing the
criteria after a commitment exists means starting a new match, not editing
the commitment in place. There is deliberately no override flag for this.

Standard library only. Python >= 3.9.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

# Default criteria library. The five entries mirror the worth decomposition
# used by the belief layer, so a match probes the residual relative merit on
# the same axes. Callers may add or remove criteria, but only before the
# commitment file is written.
DEFAULT_CRITERIA = [
    "tension resolution",
    "downstream reach and breadth of applicability",
    "mechanism insight",
    "testability and timing",
    "verification cost",
]

HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class CriteriaError(ValueError):
    """Raised when a criteria list cannot be canonicalized."""


def canonicalize_criteria(criteria):
    """Return the canonical (normalized, deduplicated, sorted) criteria list.

    Raises CriteriaError on non-string entries, empty entries, duplicates,
    or an empty list.
    """
    if not isinstance(criteria, (list, tuple)):
        raise CriteriaError("criteria must be a list of strings")
    normalized = []
    for item in criteria:
        if not isinstance(item, str):
            raise CriteriaError("criterion is not a string: %r" % (item,))
        text = unicodedata.normalize("NFC", item)
        text = " ".join(text.split())
        if not text:
            raise CriteriaError("criterion is empty after normalization")
        normalized.append(text)
    if not normalized:
        raise CriteriaError("criteria list is empty")
    duplicates = sorted({c for c in normalized if normalized.count(c) > 1})
    if duplicates:
        raise CriteriaError(
            "duplicate criteria after normalization: %s" % ", ".join(duplicates)
        )
    return sorted(normalized)


def commitment_hash(criteria):
    """Return "sha256:<hex>" over the canonicalized criteria list."""
    canonical = canonicalize_criteria(criteria)
    payload = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def utc_now_iso():
    """Current UTC time as an RFC 3339 string with an explicit offset."""
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def parse_rfc3339(value):
    """Parse an RFC 3339 timestamp; require an explicit timezone offset.

    Accepts a trailing "Z" as an alias for "+00:00" (Python 3.9 fromisoformat
    does not). Raises ValueError on anything unparseable or offset-free.
    """
    if not isinstance(value, str):
        raise ValueError("timestamp is not a string")
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = _dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("timestamp lacks a timezone offset: %r" % (value,))
    return parsed


def build_commitment(criteria, committed_at=None):
    """Build a criteria_commitment object from a raw criteria list."""
    canonical = canonicalize_criteria(criteria)
    return {
        "committed_at": committed_at or utc_now_iso(),
        "criteria": canonical,
        "commitment_hash": commitment_hash(canonical),
    }


def validate_commitment(obj):
    """Structurally validate a criteria_commitment object.

    Returns a list of problem strings; an empty list means valid. The check
    recomputes the hash from the stored criteria, so a commitment whose
    criteria were edited after the fact fails here.
    """
    errors = []
    if not isinstance(obj, dict):
        return ["criteria_commitment is not a JSON object"]
    expected = {"committed_at", "criteria", "commitment_hash"}
    unknown = sorted(set(obj) - expected)
    if unknown:
        errors.append("criteria_commitment has unknown keys: %s" % ", ".join(unknown))
    for key in sorted(expected - set(obj)):
        errors.append("criteria_commitment is missing key: %s" % key)
    if "committed_at" in obj:
        try:
            parse_rfc3339(obj["committed_at"])
        except ValueError as exc:
            errors.append("committed_at is invalid: %s" % exc)
    if "criteria" in obj:
        try:
            canonical = canonicalize_criteria(obj["criteria"])
        except CriteriaError as exc:
            errors.append("criteria are invalid: %s" % exc)
        else:
            if list(obj["criteria"]) != canonical:
                errors.append(
                    "criteria are not stored in canonical sorted form"
                )
            if "commitment_hash" in obj:
                recomputed = commitment_hash(canonical)
                stored = obj["commitment_hash"]
                if not isinstance(stored, str) or not HASH_RE.match(stored):
                    errors.append(
                        "commitment_hash does not match the form sha256:<64 hex>"
                    )
                elif stored != recomputed:
                    errors.append(
                        "commitment_hash %s does not match the stored criteria "
                        "(recomputed %s)" % (stored, recomputed)
                    )
    return errors


def write_json_atomic(path, obj):
    """Write JSON via a temporary file and os.replace in the same directory."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(obj, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Write the criteria_commitment file for one pairwise match."
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help="Output path for commitment.json (refuses to overwrite).",
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--criteria",
        nargs="+",
        help="Criteria strings for this match (default: the built-in library).",
    )
    source.add_argument(
        "--criteria-file",
        type=Path,
        help="JSON file holding an array of criteria strings.",
    )
    args = parser.parse_args(argv)

    if args.criteria is not None:
        criteria = args.criteria
    elif args.criteria_file is not None:
        try:
            criteria = json.loads(args.criteria_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print("error: cannot read --criteria-file: %s" % exc, file=sys.stderr)
            return 1
    else:
        criteria = DEFAULT_CRITERIA

    if args.out.exists():
        print(
            "error: %s already exists; a commitment is never overwritten. "
            "Start a new match directory instead." % args.out,
            file=sys.stderr,
        )
        return 2

    try:
        commitment = build_commitment(criteria)
    except CriteriaError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1

    write_json_atomic(args.out, commitment)
    print("committed %d criteria" % len(commitment["criteria"]))
    print("commitment_hash: %s" % commitment["commitment_hash"])
    print("written: %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
