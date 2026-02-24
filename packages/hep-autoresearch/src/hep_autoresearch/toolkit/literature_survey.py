from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from ._json import read_json


_ARXIV_RE = re.compile(r"\b(\d{4}\.\d{4,5})(?:v\d+)?\b")
_DOI_RE = re.compile(r"\b10\.\d{4,9}/\S+\b")


_LATEX_ESCAPE_MAP: dict[str, str] = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "%": r"\%",
    "_": r"\_",
    "&": r"\&",
    "$": r"\$",
    "#": r"\#",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def _escape_latex(text: str) -> str:
    s = str(text).replace("\r", " ").replace("\n", " ")
    return "".join(_LATEX_ESCAPE_MAP.get(ch, ch) for ch in s)


def _md_escape_cell(text: str) -> str:
    s = str(text).replace("\r", " ").replace("\n", " ").strip()
    s = s.replace("|", "\\|")
    s = s.replace("`", "\\`")
    s = s.replace("[", "\\[").replace("]", "\\]")
    return s


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root))
    except Exception:
        return os.fspath(p)


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _extract_first_h1(lines: list[str]) -> str | None:
    for ln in lines:
        s = ln.strip()
        if s.startswith("# "):
            v = s[2:].strip()
            return v if v else None
    return None


def _extract_prefixed_value(lines: list[str], prefix: str) -> str | None:
    for ln in lines:
        s = ln.strip()
        if s.startswith(prefix):
            v = s.split(":", 1)[1].strip() if ":" in s else ""
            return v if v else None
    return None


def _extract_arxiv_id(lines: list[str]) -> str | None:
    for ln in lines[:80]:
        s = ln.strip()
        if s.lower().startswith("arxiv:"):
            m = _ARXIV_RE.search(s)
            if m:
                return m.group(1)
    # Fallback: anywhere in top region.
    text = "\n".join(lines[:120])
    m = _ARXIV_RE.search(text)
    return m.group(1) if m else None


def _extract_doi(lines: list[str]) -> str | None:
    for ln in lines[:120]:
        s = ln.strip()
        if s.lower().startswith("doi:"):
            m = _DOI_RE.search(s)
            if m:
                return m.group(0).rstrip(".,;:)")
    m = _DOI_RE.search("\n".join(lines[:200]))
    return m.group(0).rstrip(".,;:)") if m else None


def _find_literature_note_path(repo_root: Path, refkey: str) -> Path | None:
    # Fast path: filename convention.
    p = repo_root / "knowledge_base" / "literature" / f"{refkey}.md"
    if p.exists() and p.is_file():
        return p
    # Slow path: scan for RefKey line.
    lit_dir = repo_root / "knowledge_base" / "literature"
    if not lit_dir.exists():
        return None
    for cand in sorted(lit_dir.glob("*.md")):
        if not cand.is_file():
            continue
        try:
            lines = cand.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue
        rk = _extract_prefixed_value(lines, "RefKey:")
        if rk and rk.strip() == refkey:
            return cand
    return None


def _resolve_inspire_citekey(repo_root: Path, recid: str) -> str | None:
    p = repo_root / "references" / "inspire" / f"recid-{recid}" / "extracted.json"
    if not p.exists():
        return None
    try:
        data = read_json(p)
    except Exception:
        return None
    ck = data.get("citekey") if isinstance(data, dict) else None
    return str(ck).strip() if isinstance(ck, str) and ck.strip() else None


def _read_inspire_bib(repo_root: Path, recid: str) -> str | None:
    p = repo_root / "references" / "inspire" / f"recid-{recid}" / "literature.bib"
    if not p.exists():
        return None
    try:
        return p.read_text(encoding="utf-8", errors="replace").strip() + "\n"
    except Exception:
        return None


def _bib_arxiv_preprint_entry(*, citekey: str, title: str, arxiv_id: str | None, doi: str | None, refkey: str) -> str:
    # Use @article for broad BibTeX compatibility (avoids @misc edge cases across styles).
    lines: list[str] = [f"@article{{{citekey},"]
    lines.append(f"    title = {{{_escape_latex(title)}}},")
    if arxiv_id:
        lines.append(f"    eprint = {{{arxiv_id}}},")
        lines.append('    archivePrefix = "arXiv",')
    if doi:
        lines.append(f"    doi = {{{doi}}},")
    lines.append(f"    note = {{KB RefKey: {_escape_latex(refkey)}}},")
    lines.append("}")
    return "\n".join(lines) + "\n"


def build_literature_survey(
    *,
    repo_root: Path,
    refkeys: list[str],
    topic: str | None = None,
) -> tuple[dict[str, Any], dict[str, str], str, str]:
    """Return (survey_payload, refkey_to_citekey, bib_text, tex_text)."""
    selected = [str(rk).strip() for rk in refkeys if str(rk).strip()]
    selected = sorted(dict.fromkeys(selected))  # stable unique

    entries: list[dict[str, Any]] = []
    refkey_to_citekey: dict[str, str] = {}
    citekey_to_refkeys: dict[str, list[str]] = {}

    missing_kb: list[str] = []
    missing_inspire: list[str] = []
    missing_bib: list[str] = []
    warnings: list[str] = []

    bib_by_citekey: dict[str, str] = {}

    for refkey in selected:
        p = _find_literature_note_path(repo_root, refkey)
        if p is None:
            missing_kb.append(refkey)
            continue
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            lines = []

        title = _extract_first_h1(lines) or refkey
        rk_line = _extract_prefixed_value(lines, "RefKey:") or refkey
        inspire_recid = _extract_prefixed_value(lines, "INSPIRE recid:")
        citekey_note = _extract_prefixed_value(lines, "Citekey:")
        arxiv_id = _extract_arxiv_id(lines)
        doi = _extract_doi(lines)

        citekey = None
        citekey_source = "refkey_fallback"
        bib_text = None
        if inspire_recid:
            citekey = _resolve_inspire_citekey(repo_root, inspire_recid)
            if citekey:
                citekey_source = "inspire_snapshot"
            elif citekey_note:
                citekey = citekey_note
                citekey_source = "kb_note"
                warnings.append(f"{refkey}: INSPIRE recid present but missing citekey in snapshot; using KB note citekey")
            else:
                citekey = refkey
                citekey_source = "refkey_fallback"
                missing_inspire.append(refkey)

            bib_text = _read_inspire_bib(repo_root, inspire_recid)
            if bib_text is None:
                missing_bib.append(str(citekey))
        else:
            if citekey_note:
                citekey = citekey_note
                citekey_source = "kb_note"
            else:
                citekey = refkey
                citekey_source = "refkey_fallback"

        citekey = str(citekey)
        refkey_to_citekey[refkey] = citekey
        citekey_to_refkeys.setdefault(citekey, []).append(refkey)

        if bib_text is None:
            bib_text = _bib_arxiv_preprint_entry(citekey=citekey, title=title, arxiv_id=arxiv_id, doi=doi, refkey=refkey)
        prev = bib_by_citekey.get(citekey)
        if prev is None:
            bib_by_citekey[citekey] = bib_text
        elif prev != bib_text:
            warnings.append(f"{refkey}: citekey collision with differing bib entry: {citekey}")

        entries.append(
            {
                "refkey": refkey,
                "kb_path": _safe_rel(repo_root, p),
                "title": title,
                "citekey": citekey,
                "citekey_source": citekey_source,
                "inspire_recid": inspire_recid,
                "arxiv_id": arxiv_id,
                "doi": doi,
                "kb_refkey_declared": rk_line,
            }
        )

    entries.sort(key=lambda e: str(e.get("refkey") or ""))
    for ck in citekey_to_refkeys:
        citekey_to_refkeys[ck] = sorted(citekey_to_refkeys[ck])

    survey: dict[str, Any] = {
        "schema_version": 1,
        "topic": topic.strip() if isinstance(topic, str) and topic.strip() else None,
        "selected_refkeys": selected,
        "entries": entries,
        "refkey_to_citekey": refkey_to_citekey,
        "citekey_to_refkeys": citekey_to_refkeys,
        "issues": {
            "missing_kb_notes": sorted(missing_kb),
            "missing_inspire_citekeys": sorted(missing_inspire),
            "missing_bib_entries": sorted(dict.fromkeys(missing_bib)),
            "warnings": warnings,
        },
        "stats": {
            "total_entries": int(len(entries)),
            "unique_citekeys": int(len(bib_by_citekey.keys())),
        },
    }

    bib_lines: list[str] = []
    for ck in sorted(bib_by_citekey.keys()):
        bib_lines.append(bib_by_citekey[ck].rstrip() + "\n")
    bib_out = "\n".join(bib_lines).rstrip() + "\n"

    tex_lines: list[str] = [
        "% Auto-generated (deterministic): KB → literature survey export",
        "% Include this file and the accompanying literature_survey.bib in your paper project.",
        "",
        "\\section*{Literature survey}",
        "",
        "\\begin{itemize}",
    ]
    for e in entries:
        refkey = str(e.get("refkey"))
        title = str(e.get("title"))
        citekey = str(e.get("citekey"))
        tex_lines.append(
            f"  \\item \\textbf{{{_escape_latex(title)}}} (RefKey: {_escape_latex(refkey)})~\\cite{{{citekey}}}."
        )
    tex_lines.extend(["\\end{itemize}", ""])
    tex_out = "\n".join(tex_lines).rstrip() + "\n"

    return survey, refkey_to_citekey, bib_out, tex_out


def write_literature_survey(
    *,
    repo_root: Path,
    out_dir: Path,
    refkeys: list[str],
    topic: str | None,
) -> dict[str, str]:
    """Write SSOT + derived views. Returns relative paths."""
    out_dir.mkdir(parents=True, exist_ok=True)

    survey, refkey_to_citekey, bib_text, tex_text = build_literature_survey(
        repo_root=repo_root, refkeys=refkeys, topic=topic
    )

    survey_path = out_dir / "survey.json"
    refkey_map_path = out_dir / "refkey_to_citekey.json"
    citekey_map_path = out_dir / "citekey_to_refkeys.json"
    bib_path = out_dir / "literature_survey.bib"
    tex_path = out_dir / "survey.tex"
    report_path = out_dir / "report.md"

    _write_json_atomic(survey_path, survey)
    _write_json_atomic(refkey_map_path, refkey_to_citekey)
    _write_json_atomic(citekey_map_path, survey.get("citekey_to_refkeys") or {})
    _write_text_atomic(bib_path, bib_text)
    _write_text_atomic(tex_path, tex_text)

    # Deterministic human view derived from survey.json.
    issues = survey.get("issues") if isinstance(survey.get("issues"), dict) else {}
    missing_kb = issues.get("missing_kb_notes") if isinstance(issues.get("missing_kb_notes"), list) else []
    missing_inspire = (
        issues.get("missing_inspire_citekeys") if isinstance(issues.get("missing_inspire_citekeys"), list) else []
    )
    missing_bib = issues.get("missing_bib_entries") if isinstance(issues.get("missing_bib_entries"), list) else []
    warnings = issues.get("warnings") if isinstance(issues.get("warnings"), list) else []

    lines: list[str] = []
    lines.append("# Literature survey export (deterministic)")
    lines.append("")
    lines.append(f"- topic: {survey.get('topic') or '(none)'}")
    lines.append(f"- total_entries: {survey.get('stats', {}).get('total_entries')}")
    lines.append(f"- unique_citekeys: {survey.get('stats', {}).get('unique_citekeys')}")
    lines.append("")
    lines.append("## Outputs")
    lines.append("")
    lines.append(f"- SSOT: `{_safe_rel(repo_root, survey_path)}`")
    lines.append(f"- BibTeX: `{_safe_rel(repo_root, bib_path)}`")
    lines.append(f"- LaTeX snippet: `{_safe_rel(repo_root, tex_path)}`")
    lines.append("")

    if missing_kb or missing_inspire or missing_bib or warnings:
        lines.append("## Issues")
        lines.append("")
        if missing_kb:
            lines.append("- missing_kb_notes:")
            for x in missing_kb:
                lines.append(f"  - `{x}`")
        if missing_inspire:
            lines.append("- missing_inspire_citekeys:")
            for x in missing_inspire:
                lines.append(f"  - `{x}`")
        if missing_bib:
            lines.append("- missing_bib_entries:")
            for x in missing_bib:
                lines.append(f"  - `{x}`")
        if warnings:
            lines.append("- warnings:")
            for x in warnings[:50]:
                lines.append(f"  - `{x}`")
        lines.append("")

    lines.append("## Index")
    lines.append("")
    lines.append("| RefKey | Title | Citekey |")
    lines.append("|---|---|---|")
    for e in survey.get("entries") if isinstance(survey.get("entries"), list) else []:
        if not isinstance(e, dict):
            continue
        rk = str(e.get("refkey") or "")
        title = str(e.get("title") or "")
        ck = str(e.get("citekey") or "")
        kb_path = str(e.get("kb_path") or "")
        # Use a stable link label (RefKey) to avoid Markdown injection via titles.
        safe_title_cell = _md_escape_cell(title)
        title_md = safe_title_cell
        if kb_path:
            try:
                rel = os.path.relpath(repo_root / kb_path, start=report_path.parent).replace(os.sep, "/")
                title_md = f"{safe_title_cell} ([{rk}]({rel}))"
            except Exception:
                title_md = f"{safe_title_cell} ([{rk}]({kb_path}))"
        lines.append(f"| `{rk}` | {title_md} | `{ck}` |")
    lines.append("")

    _write_text_atomic(report_path, "\n".join(lines).rstrip() + "\n")

    return {
        "survey_json": _safe_rel(repo_root, survey_path),
        "refkey_to_citekey": _safe_rel(repo_root, refkey_map_path),
        "citekey_to_refkeys": _safe_rel(repo_root, citekey_map_path),
        "bib": _safe_rel(repo_root, bib_path),
        "tex": _safe_rel(repo_root, tex_path),
        "report": _safe_rel(repo_root, report_path),
    }
