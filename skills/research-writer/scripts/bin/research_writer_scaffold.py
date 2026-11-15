#!/usr/bin/env python3
"""Initialize a blank RevTeX paper folder; scientific writing belongs to the agent."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def _latex_text(value: str) -> str:
    """Escape plain-text CLI metadata without interpreting it as manuscript TeX."""
    escapes = {
        "\\": r"\textbackslash{}", "{": r"\{", "}": r"\}",
        "_": r"\_", "%": r"\%", "&": r"\&", "#": r"\#",
        "$": r"\$", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
    }
    return "".join(escapes.get(char, char) for char in value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True, type=Path, help="Existing research project directory; recorded as context, never mined for prose.")
    parser.add_argument("--tag", required=True, help="Research milestone/run tag to record in metadata.")
    parser.add_argument("--out", required=True, type=Path, help="New paper directory. Existing paths are never overwritten.")
    parser.add_argument("--title", default="", help="Optional plain-text title. Edit main.tex for mathematical notation.")
    parser.add_argument("--authors", default="", help="Optional plain-text author line. Edit main.tex for structured affiliations.")
    parser.add_argument("--run-card", type=Path, help="Optional opaque JSON run-card, copied byte-for-byte.")
    args = parser.parse_args(argv)

    project_root = args.project_root.expanduser().resolve()
    out_dir = args.out.expanduser().absolute()
    if not project_root.is_dir():
        parser.error(f"project directory does not exist: {project_root}")
    if out_dir.exists() or out_dir.is_symlink():
        parser.error(f"output already exists: {out_dir}; edit that manuscript or choose a new directory")

    templates = Path(__file__).resolve().parents[2] / "assets" / "templates"
    try:
        files = {
            "main.tex": (templates / "revtex4-2_onecolumn_main.tex").read_text(encoding="utf-8"),
            "references.bib": (templates / "references.bib").read_text(encoding="utf-8"),
            "latexmkrc": (templates / "latexmkrc").read_text(encoding="utf-8"),
            "README.md": (templates / "paper_README.md").read_text(encoding="utf-8"),
        }
        run_card_bytes = args.run_card.expanduser().read_bytes() if args.run_card else None
        if run_card_bytes is not None:
            json.loads(run_card_bytes)  # Validate JSON without imposing a schema or rewriting it.
    except (OSError, ValueError) as exc:
        print(f"ERROR: cannot read scaffold inputs: {exc}", file=sys.stderr)
        return 2

    if args.title:
        files["main.tex"] = files["main.tex"].replace("TITLE (placeholder)", _latex_text(args.title))
    if args.authors:
        files["main.tex"] = files["main.tex"].replace("AUTHOR(S) (placeholder)", _latex_text(args.authors))

    generated_at = datetime.now(timezone.utc).isoformat()
    run_card = None
    if run_card_bytes is not None:
        run_card = {"path": "run_card.json", "sha256": hashlib.sha256(run_card_bytes).hexdigest()}
    run = {
        "tool": "research-writer", "entrypoint": "scaffold", "generated_at_utc": generated_at,
        "project_root": str(project_root), "tag": args.tag,
        "status": "blank_scaffold", "run_card": run_card,
    }
    export = {
        "schemaVersion": 1, "tool": "research-writer", "entrypoint": "scaffold",
        "generated_at_utc": generated_at, "status": "blank_scaffold",
        "paper": {"main_tex": "main.tex", "bib": ["references.bib"], "latexmkrc": "latexmkrc", "figures_dir": "figures"},
        "compile": {"status": "not_run"}, "run_card": run_card,
        "trace": {"run_json": "run.json"},
    }
    try:
        out_dir.mkdir(parents=True, exist_ok=False)
        (out_dir / "figures").mkdir()
        for name, content in files.items():
            (out_dir / name).write_text(content, encoding="utf-8")
        if run_card_bytes is not None:
            (out_dir / "run_card.json").write_bytes(run_card_bytes)
        for name, document in (("run.json", run), ("export_manifest.json", export)):
            (out_dir / name).write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"ERROR: scaffold incomplete at {out_dir}: {exc}", file=sys.stderr)
        return 2
    print(f"Created blank paper template: {out_dir}")
    print("Read the research sources and write main.tex or included sections before scientific review and delivery.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
