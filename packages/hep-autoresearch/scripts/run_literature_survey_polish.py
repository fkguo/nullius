#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.literature_survey_polish import (  # noqa: E402
    LiteratureSurveyPolishInputs,
    literature_survey_polish_one,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Literature survey polish (research-writer consume; A4-gated in Orchestrator).")
    parser.add_argument("--tag", required=True, help="Run tag (artifacts/runs/<tag>/literature_survey_polish/...).")
    parser.add_argument("--no-compile", action="store_true", help="Do not attempt latexmk compile (still runs hygiene).")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=900,
        help="Timeout for research-writer consume invocation (default: 900).",
    )
    args = parser.parse_args()

    repo_root = Path.cwd()
    tag = str(args.tag).strip()
    if not tag:
        raise SystemExit("tag is required")

    res = literature_survey_polish_one(
        LiteratureSurveyPolishInputs(tag=tag, compile_pdf=not bool(args.no_compile), timeout_seconds=int(args.timeout_seconds)),
        repo_root=repo_root,
    )

    print("[ok] wrote literature survey polish artifacts:")
    for k, v in sorted((res.get("artifact_paths") or {}).items()):
        print(f"- {k}: {v}")
    errors = res.get("errors") or []
    if errors:
        print("[warn] errors:")
        for e in errors:
            print(f"- {e}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

