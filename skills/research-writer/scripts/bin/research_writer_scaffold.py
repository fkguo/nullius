#!/usr/bin/env python3
"""
research_writer_scaffold.py

Minimal scaffold CLI for the `research-writer` skill.

Milestone note:
- M1: creates a paper folder from templates (compilable skeleton).
- M2: enriches the skeleton by reading `Draft_Derivation.md` + `artifacts/` and adding provenance wiring.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")

def _write_json(path: Path, obj: Any) -> None:
    _write_text(path, json.dumps(obj, indent=2, sort_keys=True) + "\n")

def _latex_escape_texttt(s: str) -> str:
    """
    Minimal LaTeX escaping suitable for use inside \\texttt{...}.
    """
    out = str(s)
    out = out.replace("\\", r"\textbackslash{}")
    out = out.replace("{", r"\{").replace("}", r"\}")
    out = out.replace("_", r"\_")
    out = out.replace("%", r"\%")
    out = out.replace("&", r"\&")
    out = out.replace("#", r"\#")
    out = out.replace("$", r"\$")
    return out


def _rel_to_project(path: Path, project_root: Path) -> Path:
    try:
        return path.resolve().relative_to(project_root.resolve())
    except Exception:
        return path


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        print(f"[warn] failed to parse JSON: {path} ({exc})", file=sys.stderr)
        return None


def _find_artifact_run_dir(project_root: Path, tag: str) -> Path | None:
    for cand in (
        project_root / "artifacts" / "runs" / tag,
        project_root / "artifacts" / tag,
    ):
        if cand.is_dir():
            return cand
    return None

def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_json_summary(obj: Any) -> dict[str, Any]:
    """
    Best-effort summary for a run-card-like JSON object.

    This intentionally avoids schema assumptions and degrades gracefully.
    """
    if not isinstance(obj, dict):
        return {"type": type(obj).__name__}

    approval = obj.get("approval") if isinstance(obj.get("approval"), dict) else {}
    return {
        "run_id": obj.get("run_id") or obj.get("runId") or obj.get("id"),
        "workflow_id": obj.get("workflow_id") or obj.get("workflowId"),
        "backend": obj.get("backend"),
        "approval_trace_id": (
            obj.get("approval_trace_id")
            or obj.get("approvalTraceId")
            or approval.get("trace_id")
            or approval.get("traceId")
            or approval.get("id")
        ),
    }


def _stage_run_card(run_card_path: Path, *, out_dir: Path) -> dict[str, Any]:
    raw = run_card_path.read_bytes()
    digest = _sha256_bytes(raw)

    dest = out_dir / "run_card.json"
    if dest.exists():
        try:
            if dest.read_bytes() != raw:
                dest = out_dir / f"run_card.{digest[:12]}.json"
        except Exception:
            dest = out_dir / f"run_card.{digest[:12]}.json"
    if not dest.exists():
        dest.write_bytes(raw)

    parsed: Any = None
    parse_error: str | None = None
    try:
        parsed = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as exc:
        parse_error = str(exc)

    return {
        "input_path": str(run_card_path),
        "path": str(dest.relative_to(out_dir)),
        "sha256": digest,
        "parse_error": parse_error,
        "summary": _safe_json_summary(parsed),
    }


def _pick_first_json(dir_path: Path, names: list[str]) -> Path | None:
    for name in names:
        p = dir_path / name
        if p.is_file():
            return p
    return None


def _find_artifacts(project_root: Path, tag: str) -> tuple[Path | None, Path | None]:
    """
    Return (manifest_json_path, analysis_json_path), best-effort.
    """
    run_dir = _find_artifact_run_dir(project_root, tag)
    if run_dir is not None:
        manifest = _pick_first_json(run_dir, ["manifest.json", f"{tag}_manifest.json"])
        analysis = _pick_first_json(run_dir, ["analysis.json", f"{tag}_analysis.json"])
        if manifest or analysis:
            return manifest, analysis

        # Fallback: any *manifest*.json / *analysis*.json in run dir.
        cands = sorted([p for p in run_dir.glob("*.json") if p.is_file()], key=lambda p: p.name)
        manifest2 = next((p for p in cands if "manifest" in p.name.lower()), None)
        analysis2 = next((p for p in cands if "analysis" in p.name.lower()), None)
        return manifest2, analysis2

    # Demo layout: artifacts/<tag>_{manifest,analysis}.json
    art_dir = project_root / "artifacts"
    manifest = art_dir / f"{tag}_manifest.json"
    analysis = art_dir / f"{tag}_analysis.json"
    return (manifest if manifest.is_file() else None, analysis if analysis.is_file() else None)


def _extract_manifest_outputs(manifest: dict[str, Any] | None) -> list[str]:
    if not isinstance(manifest, dict):
        return []
    out = manifest.get("outputs")
    paths: list[str] = []
    if isinstance(out, list):
        for item in out:
            if isinstance(item, str):
                paths.append(item)
            elif isinstance(item, dict) and isinstance(item.get("path"), str):
                paths.append(item["path"])
    elif isinstance(out, dict):
        for _, v in out.items():
            if isinstance(v, str):
                paths.append(v)
            elif isinstance(v, dict) and isinstance(v.get("path"), str):
                paths.append(v["path"])
    return [p for p in paths if str(p).strip()]


def _extract_analysis_results(analysis: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(analysis, dict):
        return {}
    res = analysis.get("results")
    return res if isinstance(res, dict) else {}


def _symlink_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        return
    try:
        rel = os.path.relpath(str(src), str(dst.parent))
        dst.symlink_to(rel)
    except Exception:
        shutil.copy2(src, dst)


def _choose_figure(outputs: list[Path]) -> Path | None:
    exts = {".pdf", ".png", ".jpg", ".jpeg", ".eps"}
    for p in outputs:
        if p.suffix.lower() in exts and p.is_file():
            return p
    return None


def _read_draft_outline(project_root: Path) -> list[str]:
    notes = project_root / "Draft_Derivation.md"
    if not notes.is_file():
        return []
    text = notes.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    headings: list[str] = []
    for ln in text.splitlines():
        if not ln.startswith("#"):
            continue
        stripped = ln.lstrip("#").strip()
        if not stripped:
            continue
        headings.append(stripped)
        if len(headings) >= 40:
            break
    return headings


def _first_display_math_block(project_root: Path) -> str:
    """
    Return the first $$...$$ display-math block (content only), or "".
    """
    notes = project_root / "Draft_Derivation.md"
    if not notes.is_file():
        return ""
    text = notes.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()
    in_block = False
    buf: list[str] = []
    for ln in lines:
        if ln.strip() == "$$":
            if not in_block:
                in_block = True
                buf = []
                continue
            # close
            return "\n".join(buf).strip()
        if in_block:
            buf.append(ln.rstrip("\n"))
    return ""


def _find_existing_bib(project_root: Path) -> Path | None:
    for rel in (
        "references.bib",
        "refs.bib",
        "paper/references.bib",
        "paper/refs.bib",
    ):
        p = project_root / rel
        if p.is_file():
            return p
    return None


def _http_get_text(url: str, *, headers: dict[str, str] | None = None, timeout_s: int = 20) -> str:
    req = Request(url, headers=headers or {})
    with urlopen(req, timeout=timeout_s) as r:  # nosec - intended for controlled metadata fetch
        return r.read().decode("utf-8", errors="replace")


def _fetch_inspire_bibtex(texkey: str) -> str | None:
    q = quote(f"texkey:{texkey}")
    url = f"https://inspirehep.net/api/literature?q={q}"
    obj = json.loads(_http_get_text(url, headers={"Accept": "application/json"}))
    hits = obj.get("hits", {}).get("hits", [])
    if not isinstance(hits, list) or not hits:
        return None
    first = hits[0] if isinstance(hits[0], dict) else {}
    bib_url = (first.get("links", {}) or {}).get("bibtex")
    if not isinstance(bib_url, str) or not bib_url.strip():
        return None
    return _http_get_text(bib_url.strip(), headers={"Accept": "application/x-bibtex"})


def _fetch_doi_bibtex(doi: str) -> str | None:
    doi = doi.strip()
    if not doi:
        return None
    url = "https://doi.org/" + quote(doi, safe="/")
    return _http_get_text(url, headers={"Accept": "application/x-bibtex"})


def _bib_from_kb_literature(project_root: Path, *, fetch_bibtex: bool, trace: list[dict[str, Any]]) -> str:
    lit_dir = project_root / "knowledge_base" / "literature"
    if not lit_dir.is_dir():
        return ""

    entries: list[str] = []
    for p in sorted(lit_dir.glob("*.md"), key=lambda x: x.name):
        txt = p.read_text(encoding="utf-8", errors="replace")
        refkey = ""
        title = ""
        authors = ""
        year = ""
        doi = ""
        inspire_texkey = ""
        for raw in txt.splitlines():
            ln = raw.strip()
            if ln.lower().startswith("refkey:"):
                refkey = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith(("citekey:", "texkey:")):
                inspire_texkey = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("title:"):
                title = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("authors:"):
                authors = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("year:"):
                year = ln.split(":", 1)[1].strip()
            elif "doi.org/" in ln.lower():
                m = re.search(r"doi\.org/([^\\s)]+)", ln, flags=re.IGNORECASE)
                if m:
                    doi = m.group(1).strip().rstrip(".")
            elif ln.lower().startswith("doi:"):
                v = ln.split(":", 1)[1].strip()
                doi = v.replace("https://doi.org/", "").replace("http://doi.org/", "").strip()

        if not refkey:
            continue

        bibtex = None
        if fetch_bibtex:
            if inspire_texkey:
                try:
                    bibtex = _fetch_inspire_bibtex(inspire_texkey)
                    trace.append(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "method": "inspire_texkey",
                            "texkey": inspire_texkey,
                            "status": "ok" if bibtex else "not_found",
                            "source_file": str(_rel_to_project(p, project_root)),
                        }
                    )
                except Exception as exc:
                    trace.append(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "method": "inspire_texkey",
                            "texkey": inspire_texkey,
                            "status": "error",
                            "error": str(exc),
                            "source_file": str(_rel_to_project(p, project_root)),
                        }
                    )
                    bibtex = None
            elif doi:
                try:
                    bibtex = _fetch_doi_bibtex(doi)
                    trace.append(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "method": "doi",
                            "doi": doi,
                            "status": "ok" if bibtex else "not_found",
                            "source_file": str(_rel_to_project(p, project_root)),
                        }
                    )
                except Exception as exc:
                    trace.append(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "method": "doi",
                            "doi": doi,
                            "status": "error",
                            "error": str(exc),
                            "source_file": str(_rel_to_project(p, project_root)),
                        }
                    )
                    bibtex = None

        if isinstance(bibtex, str) and bibtex.strip():
            entries.append(bibtex.strip() + "\n")
            continue

        fields: list[str] = []
        if authors:
            fields.append(f"  author = {{{authors}}}")
        if title:
            fields.append(f"  title = {{{title}}}")
        if year:
            fields.append(f"  year = {{{year}}}")
        if doi:
            fields.append(f"  doi = {{{doi}}}")
            fields.append(f"  url = {{{'https://doi.org/' + doi}}}")
        # RevTeX safety field (even if later re-fixed).
        fields.append('  journal = ""')
        body = ",\n".join(fields)
        entries.append(f"@article{{{refkey},\n{body}\n}}\n")

    return "\n".join(entries).strip() + ("\n" if entries else "")


def _run_bibtex_fix(fixer: Path, bib_path: Path) -> None:
    try:
        subprocess.check_call([sys.executable, str(fixer), "--bib", str(bib_path), "--in-place"])
    except Exception as exc:
        print(f"[warn] bibtex hygiene fixer failed (continuing): {exc}", file=sys.stderr)


def _render_main_tex(template: str, *, title: str, authors: str, project_root: Path, tag: str) -> str:
    out = template
    out = out.replace("TITLE (placeholder)", title.strip() or "TITLE (placeholder)")
    out = out.replace("AUTHOR(S) (placeholder)", authors.strip() or "AUTHOR(S) (placeholder)")
    out = out.replace("<tag>", tag.strip() or "<tag>")
    banner = f"% Generated by research-writer from project_root={project_root} tag={tag}\n"
    return banner + out.lstrip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project-root", required=True, help="Path to a research-team project root.")
    ap.add_argument("--tag", required=True, help="Milestone/run tag (e.g., M1-r1).")
    ap.add_argument("--out", required=True, help="Output paper directory (e.g., paper/).")
    ap.add_argument("--title", default="", help="Optional paper title override.")
    ap.add_argument("--authors", default="", help="Optional authors override (RevTeX format).")
    ap.add_argument("--run-card", type=Path, default=None, help="Optional run-card JSON to copy into paper/ for traceability.")
    ap.add_argument("--fetch-bibtex", action="store_true", help="Best-effort online BibTeX fetch (INSPIRE/DOI).")
    ap.add_argument("--verbose", action="store_true", help="Print debug details (artifact/bib discovery).")
    ap.add_argument("--force", action="store_true", help="Overwrite output directory if it exists.")
    args = ap.parse_args()

    project_root = Path(args.project_root).expanduser().resolve()
    if not project_root.is_dir():
        print(f"ERROR: --project-root is not a directory: {project_root}", file=sys.stderr)
        return 2

    tag = args.tag.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", tag):
        print(f"ERROR: unsafe --tag value: {args.tag!r} (allowed: [A-Za-z0-9][A-Za-z0-9._-]*)", file=sys.stderr)
        return 2

    if not (project_root / "Draft_Derivation.md").is_file():
        print("[warn] Draft_Derivation.md not found under project root (scaffold will be a template-only skeleton).", file=sys.stderr)

    out_dir = Path(args.out).expanduser().resolve()
    if out_dir.exists():
        if not args.force:
            print(f"ERROR: output already exists: {out_dir} (use --force to overwrite)", file=sys.stderr)
            return 2
        shutil.rmtree(out_dir)

    out_dir.mkdir(parents=True, exist_ok=True)

    run_card_info: dict[str, Any] | None = None
    if args.run_card is not None:
        run_card_path = args.run_card.expanduser().resolve()
        if not run_card_path.is_file():
            print(f"ERROR: --run-card not found: {run_card_path}", file=sys.stderr)
            return 2
        try:
            run_card_info = _stage_run_card(run_card_path, out_dir=out_dir)
        except Exception as exc:
            print(f"[warn] failed to stage run-card (continuing): {exc}", file=sys.stderr)
            run_card_info = {"input_path": str(run_card_path), "error": str(exc)}

    root = _skill_root()
    tpl_dir = root / "assets" / "templates"
    main_tpl = tpl_dir / "revtex4-2_onecolumn_main.tex"
    bib_tpl = tpl_dir / "references.bib"
    readme_tpl = tpl_dir / "paper_README.md"
    latexmkrc_tpl = tpl_dir / "latexmkrc"
    bib_fixer = root / "scripts" / "bin" / "fix_bibtex_revtex4_2.py"

    for p in (main_tpl, bib_tpl, readme_tpl, latexmkrc_tpl):
        if not p.is_file():
            print(f"ERROR: missing template: {p}", file=sys.stderr)
            return 2
    if not bib_fixer.is_file():
        print(f"ERROR: missing bibtex fixer: {bib_fixer}", file=sys.stderr)
        return 2

    title = args.title.strip() or f"{project_root.name}: draft"
    authors = args.authors.strip() or "AUTHOR(S) (placeholder)"

    draft_outline = _read_draft_outline(project_root)
    first_math = _first_display_math_block(project_root)
    manifest_path, analysis_path = _find_artifacts(project_root, tag)
    manifest = _load_json(manifest_path) if manifest_path is not None else None
    analysis = _load_json(analysis_path) if analysis_path is not None else None

    manifest_rel = _rel_to_project(manifest_path, project_root) if manifest_path is not None else None
    analysis_rel = _rel_to_project(analysis_path, project_root) if analysis_path is not None else None
    if args.verbose:
        print(f"[debug] manifest: {manifest_rel.as_posix() if manifest_rel is not None else '(not found)'}", file=sys.stderr)
        print(f"[debug] analysis:  {analysis_rel.as_posix() if analysis_rel is not None else '(not found)'}", file=sys.stderr)

    # Figures (best-effort: pick first image-like output from manifest outputs).
    output_paths: list[Path] = []
    for raw in _extract_manifest_outputs(manifest):
        p = Path(raw)
        if not p.is_absolute():
            p = (project_root / p).resolve()
        if p.is_file():
            output_paths.append(p)
    fig_src = _choose_figure(output_paths)
    fig_dst_rel = None
    if fig_src is not None:
        fig_dst = out_dir / "figures" / fig_src.name
        _symlink_or_copy(fig_src, fig_dst)
        fig_dst_rel = Path("figures") / fig_src.name
        if args.verbose:
            print(f"[debug] figure:   {fig_dst_rel.as_posix()} -> {fig_src}", file=sys.stderr)

    # Results + provenance.
    results = _extract_analysis_results(analysis)
    results_keys = sorted([str(k) for k in results.keys()], key=lambda x: x)

    provenance_rows: list[str] = []
    results_lines: list[str] = []

    if analysis_rel is not None and results_keys:
        results_lines.append("We summarize the headline numbers and provide provenance pointers (Appendix).")
        results_lines.append("\\begin{itemize}")
        for k in results_keys:
            v = results.get(k)
            prov = f"{analysis_rel.as_posix()}:results.{k}"
            results_lines.append(
                f"  \\item \\texttt{{{_latex_escape_texttt(k)}}} = {v} \\, (\\nolinkurl{{{prov}}})"
            )
            provenance_rows.append(
                f"\\texttt{{{_latex_escape_texttt(k)}}} & \\nolinkurl{{{prov}}} \\\\"
            )
        results_lines.append("\\end{itemize}")
    else:
        src_hint = "artifacts/<tag>_analysis.json" if analysis_rel is None else f"{analysis_rel.as_posix()}"
        results_lines.append(
            rf"\textbf{{[TODO: results | source: \texttt{{{_latex_escape_texttt(src_hint)}}}]}}"
        )

    if fig_dst_rel is not None:
        fig_caption = "Demo figure (auto-linked from artifacts)."
        results_lines.append(r"\begin{figure}[tb]")
        results_lines.append(r"  \centering")
        results_lines.append(rf"  \includegraphics[width=0.5\linewidth]{{{fig_dst_rel.as_posix()}}}")
        if manifest_rel is not None:
            results_lines.append(
                rf"  \caption{{{fig_caption} Source: \nolinkurl{{{manifest_rel.as_posix()}}}.}}"
            )
        else:
            results_lines.append(rf"  \caption{{{fig_caption}}}")
        results_lines.append(r"\end{figure}")

    prov_block = "\n".join(provenance_rows) if provenance_rows else "% (no provenance rows found; fill manually)"
    results_block = "\n".join(results_lines)

    # Main TeX from template with deterministic insertion points.
    main_tex = _render_main_tex(_read_text(main_tpl), title=title, authors=authors, project_root=project_root, tag=tag)
    if draft_outline:
        outline_lines = ["% Draft_Derivation.md outline (for drafting; not compiled):"]
        outline_lines.extend([f"% - {h}" for h in draft_outline])
        main_tex = "\n".join(outline_lines) + "\n" + main_tex
    if first_math.strip() and "\\begin{" not in first_math:
        excerpt = []
        excerpt.append("% Excerpted from Draft_Derivation.md (first $$...$$ block; verify in context):")
        excerpt.append("\\begin{equation}")
        excerpt.append(first_math.strip())
        excerpt.append("\\end{equation}")
        main_tex = main_tex.replace("% __DERIVATION_EXCERPT__", "\n".join(excerpt))
    else:
        main_tex = main_tex.replace("% __DERIVATION_EXCERPT__", "% (no safe display-math excerpt found)")
    main_tex = main_tex.replace("% __RESULTS_SECTION_BODY__", results_block)
    main_tex = main_tex.replace("% __PROVENANCE_ROWS__", prov_block)
    _write_text(out_dir / "main.tex", main_tex)

    # BibTeX: prefer project-local file; else KB-derived minimal entries; else template.
    bib_out = out_dir / "references.bib"
    bib_src = _find_existing_bib(project_root)
    if bib_src is not None:
        shutil.copy2(bib_src, bib_out)
    else:
        trace: list[dict[str, Any]] = []
        kb_bib = _bib_from_kb_literature(project_root, fetch_bibtex=bool(args.fetch_bibtex), trace=trace)
        if kb_bib.strip():
            _write_text(bib_out, kb_bib)
        else:
            _write_text(bib_out, _read_text(bib_tpl))
        if trace:
            trace_path = out_dir / "bibtex_trace.jsonl"
            trace_path.write_text("\n".join(json.dumps(x, sort_keys=True) for x in trace) + "\n", encoding="utf-8")
    _run_bibtex_fix(bib_fixer, bib_out)

    _write_text(out_dir / "latexmkrc", _read_text(latexmkrc_tpl))
    (out_dir / "figures").mkdir(parents=True, exist_ok=True)
    readme = _read_text(readme_tpl).rstrip() + "\n"
    readme += "\n## Generation\n\n"
    readme += f"- project root: `{project_root}`\n"
    readme += f"- tag: `{tag}`\n"
    readme += f"- generated_at: `{datetime.now(timezone.utc).isoformat()}`\n"
    if manifest_rel is not None:
        readme += f"- manifest: `{manifest_rel.as_posix()}`\n"
    if analysis_rel is not None:
        readme += f"- analysis: `{analysis_rel.as_posix()}`\n"
    if run_card_info is not None:
        readme += f"- run-card: `{run_card_info.get('path', '(unavailable)')}`\n"
        summary = run_card_info.get("summary") if isinstance(run_card_info.get("summary"), dict) else {}
        run_id = summary.get("run_id") if isinstance(summary, dict) else None
        if isinstance(run_id, str) and run_id.strip():
            readme += f"- run_id: `{run_id.strip()}`\n"
    _write_text(out_dir / "README.md", readme)

    run_json = {
        "schemaVersion": 1,
        "tool": "research-writer",
        "entrypoint": "scaffold",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "project_root": str(project_root),
        "tag": tag,
        "out_dir": str(out_dir),
        "artifacts": {
            "manifest": manifest_rel.as_posix() if manifest_rel is not None else None,
            "analysis": analysis_rel.as_posix() if analysis_rel is not None else None,
        },
        "run_card": run_card_info,
    }
    _write_json(out_dir / "run.json", run_json)

    # Minimal export manifest to help upper layers import this paper into their artifacts.
    export_manifest = {
        "schemaVersion": 1,
        "tool": "research-writer",
        "entrypoint": "scaffold",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "paper": {
            "main_tex": "main.tex",
            "bib": ["references.bib"],
            "latexmkrc": "latexmkrc",
            "figures_dir": "figures",
        },
        "compile": {"status": "not_run"},
        "run_card": run_card_info,
        "trace": {"run_json": "run.json", "bibtex_trace_jsonl": "bibtex_trace.jsonl" if (out_dir / "bibtex_trace.jsonl").is_file() else None},
    }
    _write_json(out_dir / "export_manifest.json", export_manifest)

    print("[ok] research-writer scaffold complete")
    print(f"- project root: {project_root}")
    print(f"- tag: {args.tag}")
    print(f"- out: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
