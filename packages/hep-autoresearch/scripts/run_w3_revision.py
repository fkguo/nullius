#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.w3_revision import RevisionInputs, revise_one  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="W3 revision runner v0 (compile gate + provenance table update).")
    parser.add_argument("--tag", required=True, help="Run tag (artifacts/runs/<tag>/revision/...).")
    parser.add_argument("--paper-root", default="paper", help="LaTeX project root (default: paper).")
    parser.add_argument("--tex-main", default="main.tex", help="Main LaTeX file inside paper-root.")
    parser.add_argument(
        "--no-apply-provenance-table",
        action="store_true",
        help="Do not modify paper; only compile + write artifacts (dry-run).",
    )
    parser.add_argument("--no-compile-before", action="store_true", help="Skip compile before edits.")
    parser.add_argument("--no-compile-after", action="store_true", help="Skip compile after edits.")
    parser.add_argument("--latexmk-timeout-seconds", type=int, default=300, help="Timeout per latexmk invocation.")
    parser.add_argument(
        "--i-approve-paper-edits",
        action="store_true",
        help="Required to apply any edits under paper-root (A4).",
    )
    args = parser.parse_args()

    repo_root = Path.cwd()
    res = revise_one(
        RevisionInputs(
            tag=args.tag,
            paper_root=str(args.paper_root),
            tex_main=str(args.tex_main),
            apply_provenance_table=not bool(args.no_apply_provenance_table),
            compile_before=not bool(args.no_compile_before),
            compile_after=not bool(args.no_compile_after),
            latexmk_timeout_seconds=int(args.latexmk_timeout_seconds),
        ),
        repo_root=repo_root,
        i_approve_paper_edits=bool(args.i_approve_paper_edits),
    )

    artifact_paths = res.get("artifact_paths") or {}
    print("[ok] wrote artifacts:")
    for k in ["manifest", "summary", "analysis"]:
        v = artifact_paths.get(k)
        if v:
            print(f"- {k}: {v}")

    errors = res.get("errors") or []
    if errors:
        print("[warn] errors:")
        for e in errors:
            print(f"- {e}")
        # Exit 3 indicates: waiting for approval (compatible with Orchestrator semantics).
        if any("approval" in str(e).lower() for e in errors):
            return 3
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
