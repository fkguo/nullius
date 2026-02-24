#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.evals import run_all_evals, write_eval_artifacts  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Eval runner v0 (required_paths + reading_note fields).")
    parser.add_argument("--tag", default="M1-eval-r1", help="Run tag for artifacts output.")
    parser.add_argument(
        "--cases-root",
        default="evals/cases",
        help="Eval cases root (project-relative).",
    )
    parser.add_argument(
        "--case-id",
        action="append",
        default=[],
        help="Run only this case_id (repeatable).",
    )
    args = parser.parse_args()

    repo_root = Path.cwd()
    cases_root = repo_root / args.cases_root
    selected = set(args.case_id) if args.case_id else None

    results = run_all_evals(repo_root=repo_root, cases_root=cases_root, selected_case_ids=selected)
    artifacts = write_eval_artifacts(repo_root=repo_root, tag=args.tag, results=results)

    failed = [r for r in results if not r.ok]
    print(f"evals: total={len(results)} passed={len(results) - len(failed)} failed={len(failed)}")
    for r in failed:
        print(f"- FAIL {r.case_id}: " + "; ".join([m for m in r.messages if m != "PASS"]))
    print(f"wrote: {artifacts['analysis']}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
