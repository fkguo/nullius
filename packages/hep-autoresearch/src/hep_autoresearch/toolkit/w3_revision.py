from __future__ import annotations

import difflib
import os
import platform
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report
from .run_card import ensure_run_card


@dataclass(frozen=True)
class RevisionInputs:
    tag: str
    paper_root: str = "paper"
    tex_main: str = "main.tex"
    apply_provenance_table: bool = True
    compile_before: bool = True
    compile_after: bool = True
    latexmk_timeout_seconds: int = 300


def _latex_escape_texttt(s: str) -> str:
    """Minimal LaTeX escaping suitable for use inside \\texttt{...}."""
    out = str(s)
    out = out.replace("\\", r"\textbackslash{}")
    out = out.replace("{", r"\{").replace("}", r"\}")
    out = out.replace("_", r"\_")
    out = out.replace("%", r"\%")
    out = out.replace("&", r"\&")
    out = out.replace("#", r"\#")
    out = out.replace("$", r"\$")
    return out


def _run(cmd: list[str], *, cwd: Path, timeout_seconds: int) -> tuple[int, str]:
    try:
        p = subprocess.run(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            timeout=int(timeout_seconds),
            check=False,
        )
        return int(p.returncode), p.stdout
    except subprocess.TimeoutExpired:
        return 124, f"[timeout] {' '.join(cmd)} (timeout_seconds={timeout_seconds})\n"


def _compile_latex(*, paper_dir: Path, tex_main: str, timeout_seconds: int) -> tuple[int, str]:
    # Use -g to force a real compile even if targets look up-to-date, avoiding
    # false negatives like "pdflatex: gave an error in previous invocation".
    cmd = ["latexmk", "-pdf", "-g", "-interaction=nonstopmode", "-halt-on-error", tex_main]
    return _run(cmd, cwd=paper_dir, timeout_seconds=timeout_seconds)


def _extract_headline_provenance(notebook_text: str) -> list[dict[str, str]]:
    """
    Parse Reproducibility Capsule headline lines like:
      - H1: ... (from artifacts/runs/<TAG>/.../analysis.json:results.q1)
    Return rows: [{label: "H1", provenance: "artifacts/...:results.q1"}, ...]
    """
    lines = notebook_text.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    in_headlines = False
    rows: list[dict[str, str]] = []

    headline_re = re.compile(r"^\s*-\s*(H\d+):\s+")
    from_re = re.compile(r"\(from\s+([^)]+?)\)")

    for ln in lines:
        if ln.strip().startswith("### E) Headline numbers"):
            in_headlines = True
            continue
        if in_headlines and ln.strip().startswith("### ") and not ln.strip().startswith("### E)"):
            break
        if not in_headlines:
            continue

        m = headline_re.match(ln)
        if not m:
            continue
        label = m.group(1)
        sources = [s.strip() for s in from_re.findall(ln)]
        if not sources:
            continue
        # Keep only the first provenance pointer per headline for a compact table.
        rows.append({"label": label, "provenance": sources[0]})
    return rows


def _render_provenance_table_rows(rows: list[dict[str, str]]) -> str:
    rendered: list[str] = []
    for r in rows:
        label = _latex_escape_texttt(r.get("label", "").strip())
        prov = _latex_escape_texttt(r.get("provenance", "").strip())
        if not label or not prov:
            continue
        rendered.append(f"{label} & \\texttt{{{prov}}} \\\\")
    return "\n".join(rendered)


def _update_main_tex_provenance(main_tex: str, *, rows_tex: str) -> tuple[str, bool]:
    start = "% AUTOGEN_PROVENANCE_START"
    end = "% AUTOGEN_PROVENANCE_END"
    block = "\n".join([start, rows_tex if rows_tex.strip() else "% (no rows)", end])

    if start in main_tex and end in main_tex:
        pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.DOTALL)
        # IMPORTANT: Use a function replacement so backslashes in LaTeX (e.g. \texttt, \\)
        # are not treated as escape sequences by the regex engine.
        new_tex, n = pattern.subn(lambda _: block, main_tex, count=1)
        return new_tex, n > 0

    placeholder = "% (no provenance rows found; fill manually)"
    if placeholder in main_tex:
        return main_tex.replace(placeholder, block, 1), True

    # Conservative fallback: do not mutate if we cannot locate the intended insertion point.
    return main_tex, False


def revise_one(inps: RevisionInputs, repo_root: Path, *, i_approve_paper_edits: bool) -> dict[str, Any]:
    if not inps.tag or not str(inps.tag).strip():
        raise ValueError("tag is required")

    created_at = utc_now_iso()
    paper_dir = (repo_root / inps.paper_root).resolve()
    tex_path = paper_dir / inps.tex_main
    if not paper_dir.is_dir():
        raise FileNotFoundError(f"paper_root not found: {paper_dir}")
    if not tex_path.is_file():
        raise FileNotFoundError(f"main tex not found: {tex_path}")

    out_dir = repo_root / "artifacts" / "runs" / str(inps.tag) / "revision"
    logs_dir = out_dir / "logs"
    diff_dir = out_dir / "diff"
    logs_dir.mkdir(parents=True, exist_ok=True)
    diff_dir.mkdir(parents=True, exist_ok=True)

    errors: list[str] = []

    versions: dict[str, Any] = {"python": os.sys.version.split()[0], "os": platform.platform()}
    latexmk_rc, latexmk_out = _run(["latexmk", "--version"], cwd=repo_root, timeout_seconds=30)
    if latexmk_rc == 0 and latexmk_out.strip():
        versions["latexmk"] = latexmk_out.splitlines()[0].strip()

    run_card_rel, run_card_sha = ensure_run_card(
        repo_root=repo_root,
        run_id=str(inps.tag),
        workflow_id="W3_revision",
        params={
            "tag": inps.tag,
            "paper_root": inps.paper_root,
            "tex_main": inps.tex_main,
            "apply_provenance_table": bool(inps.apply_provenance_table),
            "compile_before": bool(inps.compile_before),
            "compile_after": bool(inps.compile_after),
            "latexmk_timeout_seconds": int(inps.latexmk_timeout_seconds),
        },
        backend={"kind": "python", "argv": ["python3", "scripts/run_w3_revision.py"], "cwd": ".", "env": {}},
        notes="auto-generated run-card (v0)",
        overwrite=False,
    )

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_w3_revision.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "inputs": {
            "run_card_path": run_card_rel,
            "run_card_sha256": run_card_sha,
        },
        "params": {
            "tag": inps.tag,
            "paper_root": inps.paper_root,
            "tex_main": inps.tex_main,
            "apply_provenance_table": bool(inps.apply_provenance_table),
            "compile_before": bool(inps.compile_before),
            "compile_after": bool(inps.compile_after),
            "latexmk_timeout_seconds": int(inps.latexmk_timeout_seconds),
        },
        "versions": versions,
        "outputs": [
            os.fspath((out_dir / "manifest.json").relative_to(repo_root)),
            os.fspath((out_dir / "summary.json").relative_to(repo_root)),
            os.fspath((out_dir / "analysis.json").relative_to(repo_root)),
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "W3_revision"},
        "stats": {},
        "outputs": {},
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": inps.tag,
            "paper_root": inps.paper_root,
            "tex_main": inps.tex_main,
        },
        "results": {},
    }

    compile_exit_code_before = 0
    compile_exit_code_after = 0
    warnings_before = 0
    warnings_after = 0

    if inps.compile_before:
        t0 = time.time()
        rc, out = _compile_latex(paper_dir=paper_dir, tex_main=inps.tex_main, timeout_seconds=inps.latexmk_timeout_seconds)
        compile_exit_code_before = int(rc)
        warnings_before = int(out.count("Warning"))
        (logs_dir / "latexmk_before.txt").write_text(out, encoding="utf-8")
        summary.setdefault("stats", {})["compile_seconds_before"] = float(time.time() - t0)
        if compile_exit_code_before != 0:
            errors.append(f"latexmk before failed (exit_code={compile_exit_code_before})")

    notebook_path = repo_root / "Draft_Derivation.md"
    notebook_text = notebook_path.read_text(encoding="utf-8", errors="replace") if notebook_path.is_file() else ""
    prov_rows = _extract_headline_provenance(notebook_text)
    prov_rows_tex = _render_provenance_table_rows(prov_rows)

    diff_path = diff_dir / "main.tex.diff"
    applied = False
    provenance_rows_written = 0

    if inps.apply_provenance_table:
        if not i_approve_paper_edits:
            errors.append("paper edits require explicit approval: re-run with --i-approve-paper-edits")
        else:
            before = tex_path.read_text(encoding="utf-8", errors="replace")
            after, changed = _update_main_tex_provenance(before, rows_tex=prov_rows_tex)
            if not changed:
                errors.append("could not locate provenance table insertion point in main.tex")
            else:
                if after != before:
                    tex_path.write_text(after, encoding="utf-8")
                applied = True
                provenance_rows_written = sum(1 for ln in prov_rows_tex.splitlines() if ln.strip().endswith(r"\\"))
                diff = "\n".join(
                    difflib.unified_diff(
                        before.splitlines(),
                        after.splitlines(),
                        fromfile="paper/main.tex (before)",
                        tofile="paper/main.tex (after)",
                        lineterm="",
                    )
                )
                diff_path.write_text(diff + "\n", encoding="utf-8")
                manifest["outputs"].append(os.fspath(diff_path.relative_to(repo_root)))

    if inps.compile_after and (not errors):
        t0 = time.time()
        rc, out = _compile_latex(paper_dir=paper_dir, tex_main=inps.tex_main, timeout_seconds=inps.latexmk_timeout_seconds)
        compile_exit_code_after = int(rc)
        warnings_after = int(out.count("Warning"))
        (logs_dir / "latexmk_after.txt").write_text(out, encoding="utf-8")
        summary.setdefault("stats", {})["compile_seconds_after"] = float(time.time() - t0)
        if compile_exit_code_after != 0:
            errors.append(f"latexmk after failed (exit_code={compile_exit_code_after})")

    # Always include logs if present.
    for log_name in ["latexmk_before.txt", "latexmk_after.txt"]:
        p = logs_dir / log_name
        if p.exists():
            manifest["outputs"].append(os.fspath(p.relative_to(repo_root)))

    summary["stats"] = {
        "ok": len(errors) == 0,
        "errors": len(errors),
        "compile_exit_code_before": compile_exit_code_before,
        "compile_exit_code_after": compile_exit_code_after,
        "warnings_before": warnings_before,
        "warnings_after": warnings_after,
        "provenance_rows": provenance_rows_written,
        "applied_provenance_table": bool(applied),
    }
    summary["outputs"] = {
        "artifact_dir": os.fspath(out_dir.relative_to(repo_root)),
        "main_tex": os.fspath(tex_path.relative_to(repo_root)),
        "diff_main_tex": os.fspath(diff_path.relative_to(repo_root)) if diff_path.exists() else None,
        "logs_dir": os.fspath(logs_dir.relative_to(repo_root)),
    }

    analysis["results"] = {
        "ok": len(errors) == 0,
        "errors": errors,
        "compile_exit_code_before": compile_exit_code_before,
        "compile_exit_code_after": compile_exit_code_after,
        "warnings_before": warnings_before,
        "warnings_after": warnings_after,
        "provenance_rows": provenance_rows_written,
    }

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"
    manifest["outputs"].append(os.fspath(report_path.relative_to(repo_root)))
    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)

    artifact_paths = {
        "manifest": os.fspath(manifest_path.relative_to(repo_root)),
        "summary": os.fspath(summary_path.relative_to(repo_root)),
        "analysis": os.fspath(analysis_path.relative_to(repo_root)),
        "report": report_rel,
    }
    return {"errors": errors, "artifact_paths": artifact_paths, "artifact_dir": os.fspath(out_dir.relative_to(repo_root))}
