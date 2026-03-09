#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.ingest import IngestInputs, ingest_one  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="ingest runner (deterministic, v0).")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--inspire-recid", help="INSPIRE literature recid, e.g. 1234567")
    group.add_argument("--arxiv-id", help="arXiv id, e.g. 2210.03629")
    group.add_argument("--doi", help="DOI, e.g. 10.1103/PhysRevLett.116.061102")

    parser.add_argument("--refkey", help="Optional RefKey (defaults to a stable derived key)")
    parser.add_argument("--tag", default="M1-r1", help="Run tag, e.g. M1-r1")
    parser.add_argument(
        "--download",
        default="auto",
        choices=["none", "auto", "arxiv_source", "arxiv_pdf", "both"],
        help="Download policy for arXiv assets (if arXiv id is available).",
    )
    parser.add_argument(
        "--overwrite-note",
        action="store_true",
        help="Overwrite existing knowledge_base note (default: keep existing).",
    )
    parser.add_argument(
        "--no-query-log",
        action="store_true",
        help="Do not append to knowledge_base/methodology_traces/literature_queries.md",
    )
    args = parser.parse_args()

    repo_root = Path.cwd()
    inps = IngestInputs(
        inspire_recid=args.inspire_recid,
        arxiv_id=args.arxiv_id,
        doi=args.doi,
        refkey=args.refkey,
        tag=args.tag,
        download=args.download,
        overwrite_note=args.overwrite_note,
        append_query_log=not args.no_query_log,
    )
    result = ingest_one(inps, repo_root=repo_root)
    if result.get("errors"):
        print("ingest: completed with warnings/errors:")
        for e in result["errors"]:
            print(f"- {e}")
        return 2
    print("ingest: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
