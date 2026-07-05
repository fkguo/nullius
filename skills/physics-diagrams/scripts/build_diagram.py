#!/usr/bin/env python3
"""Build and preview standalone physics diagram sources.

This script is intentionally small and local-only. It compiles a standalone TeX
diagram to vector PDF, renders a PNG preview, and writes a JSON report that an
agent can use for the publication-quality gate.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def which(name: str) -> str | None:
    return shutil.which(name)


def run(cmd: list[str], cwd: Path | None = None) -> dict[str, Any]:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return {
        "cmd": cmd,
        "cwd": str(cwd) if cwd else None,
        "returncode": proc.returncode,
        "stdout": proc.stdout[-8000:],
        "stderr": proc.stderr[-8000:],
    }


def detect_engine(source_text: str, requested: str) -> str:
    if requested != "auto":
        return requested
    lua_markers = (
        "\\usetikzlibrary{graphdrawing",
        "\\usegdlibrary",
        "\\feynmandiagram",
        "horizontal=",
        "layered layout",
    )
    if any(marker in source_text for marker in lua_markers):
        return "lualatex"
    return "pdflatex"


def parse_pdfimages_table(stdout: str) -> int | None:
    lines = [line for line in stdout.splitlines() if line.strip()]
    if len(lines) <= 2:
        return 0
    # Poppler normally prints two header lines, then one line per image.
    return max(0, len(lines) - 2)


def run_pdf_quality_gate(
    pdf: Path,
    out_dir: Path,
    report: dict[str, Any],
    dpi: int,
    fail_on_raster: bool,
) -> None:
    if report["tools"]["pdftocairo"]:
        preview_base = out_dir / f"{pdf.stem}-preview"
        render = run(["pdftocairo", "-png", "-singlefile", "-r", str(dpi), str(pdf), str(preview_base)])
        report["steps"].append({"name": "pdftocairo", **render})
        preview = preview_base.with_suffix(".png")
        report["artifacts"]["preview_png"] = str(preview)
        report["checks"]["preview_exists"] = preview.exists()
        report["checks"]["preview_nonempty"] = preview.exists() and preview.stat().st_size > 0
    else:
        report["checks"]["preview_exists"] = False
        report["warnings"] = report.get("warnings", []) + ["pdftocairo not found; preview was not rendered"]

    if report["tools"]["pdfinfo"]:
        info = run(["pdfinfo", str(pdf)])
        report["steps"].append({"name": "pdfinfo", **info})

    if report["tools"]["pdffonts"]:
        fonts = run(["pdffonts", str(pdf)])
        report["steps"].append({"name": "pdffonts", **fonts})
        report["checks"]["font_report_available"] = fonts["returncode"] == 0

    if report["tools"]["pdfimages"]:
        images = run(["pdfimages", "-list", str(pdf)])
        report["steps"].append({"name": "pdfimages", **images})
        image_count = parse_pdfimages_table(images["stdout"]) if images["returncode"] == 0 else None
        report["checks"]["raster_image_count"] = image_count
        if fail_on_raster and image_count not in (0, None):
            report["error"] = f"Unexpected raster image objects: {image_count}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, help="Standalone .tex source to build")
    parser.add_argument("--qa-only", type=Path, default=None, help="Existing PDF to render and inspect")
    parser.add_argument("--out-dir", type=Path, default=None, help="Scratch output directory")
    parser.add_argument("--engine", choices=["auto", "pdflatex", "lualatex", "xelatex"], default="auto")
    parser.add_argument("--dpi", type=int, default=600, help="Preview PNG DPI")
    parser.add_argument("--fail-on-raster", action="store_true", help="Fail if pdfimages finds raster objects")
    args = parser.parse_args()

    if bool(args.source) == bool(args.qa_only):
        print("Provide exactly one input: a standalone .tex source or --qa-only existing.pdf.", file=sys.stderr)
        return 2

    if args.qa_only:
        pdf = args.qa_only.resolve()
        if not pdf.exists():
            print(f"PDF not found: {pdf}", file=sys.stderr)
            return 2
        if pdf.suffix.lower() != ".pdf":
            print("--qa-only expects a PDF file.", file=sys.stderr)
            return 2
        out_dir = (args.out_dir or Path(os.environ.get("PHYSICS_DIAGRAM_QA_DIR", "/tmp/physics-diagrams-qa")) / pdf.stem).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        report: dict[str, Any] = {
            "source": None,
            "input_pdf": str(pdf),
            "out_dir": str(out_dir),
            "engine": "qa-only",
            "tools": {name: which(name) for name in ["pdftocairo", "pdfinfo", "pdffonts", "pdfimages"]},
            "steps": [],
            "artifacts": {"pdf": str(pdf)},
            "checks": {
                "pdf_exists": pdf.exists(),
                "pdf_nonempty": pdf.exists() and pdf.stat().st_size > 0,
            },
            "manual_visual_review_required": True,
            "manual_visual_review_note": "Open the rendered preview and inspect labels, line/block intersections, alignment, clipping, and final-size readability before delivery.",
        }
        run_pdf_quality_gate(pdf, out_dir, report, args.dpi, args.fail_on_raster)
        report_path = out_dir / "build_report.json"
        report["artifacts"]["report"] = str(report_path)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        if report.get("error"):
            print(f"{report['error']}. Report: {report_path}", file=sys.stderr)
            return 1
        print(json.dumps({
            "pdf": report["artifacts"].get("pdf"),
            "preview_png": report["artifacts"].get("preview_png"),
            "report": str(report_path),
            "engine": "qa-only",
        }, indent=2))
        return 0

    source = args.source.resolve()
    if not source.exists():
        print(f"Source not found: {source}", file=sys.stderr)
        return 2
    if source.suffix.lower() != ".tex":
        print("build_diagram.py expects a standalone .tex file.", file=sys.stderr)
        return 2

    text = source.read_text(encoding="utf-8", errors="replace")
    engine = detect_engine(text, args.engine)
    out_dir = (args.out_dir or Path(os.environ.get("PHYSICS_DIAGRAM_BUILD_DIR", "/tmp/physics-diagrams-build")) / source.stem).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    report: dict[str, Any] = {
        "source": str(source),
        "out_dir": str(out_dir),
        "engine": engine,
        "tools": {name: which(name) for name in ["latexmk", engine, "pdftocairo", "pdfinfo", "pdffonts", "pdfimages"]},
        "steps": [],
        "artifacts": {},
        "checks": {},
        "manual_visual_review_required": True,
        "manual_visual_review_note": "Open the rendered preview and inspect labels, line/block intersections, alignment, clipping, and final-size readability before delivery.",
    }

    if not report["tools"]["latexmk"]:
        report["error"] = "latexmk not found"
        (out_dir / "build_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(report["error"], file=sys.stderr)
        return 2
    if not report["tools"][engine]:
        report["error"] = f"{engine} not found"
        (out_dir / "build_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(report["error"], file=sys.stderr)
        return 2

    latexmk_engine = {
        "pdflatex": "-pdf",
        "lualatex": "-pdflua",
        "xelatex": "-pdfxe",
    }[engine]
    latexmk_cmd = [
        "latexmk",
        latexmk_engine,
        "-interaction=nonstopmode",
        "-halt-on-error",
        f"-output-directory={out_dir}",
        str(source),
    ]
    build = run(latexmk_cmd, cwd=source.parent)
    report["steps"].append({"name": "latexmk", **build})

    pdf = out_dir / f"{source.stem}.pdf"
    report["artifacts"]["pdf"] = str(pdf)
    report["checks"]["pdf_exists"] = pdf.exists()
    report["checks"]["pdf_nonempty"] = pdf.exists() and pdf.stat().st_size > 0
    if build["returncode"] != 0 or not pdf.exists():
        report_path = out_dir / "build_report.json"
        report["artifacts"]["report"] = str(report_path)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Build failed. Report: {report_path}", file=sys.stderr)
        return 1

    run_pdf_quality_gate(pdf, out_dir, report, args.dpi, args.fail_on_raster)

    report_path = out_dir / "build_report.json"
    report["artifacts"]["report"] = str(report_path)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if report.get("error"):
        print(f"{report['error']}. Report: {report_path}", file=sys.stderr)
        return 1

    print(json.dumps({
        "pdf": report["artifacts"].get("pdf"),
        "preview_png": report["artifacts"].get("preview_png"),
        "report": str(report_path),
        "engine": engine,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
