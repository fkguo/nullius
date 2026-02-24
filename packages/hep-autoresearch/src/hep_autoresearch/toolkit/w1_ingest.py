from __future__ import annotations

import gzip
import os
import re
import tarfile
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ._git import try_get_git_metadata
from ._http import http_download, http_get_json, http_get_text
from ._json import write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report
from .run_card import ensure_run_card


@dataclass(frozen=True)
class IngestInputs:
    inspire_recid: str | None = None
    arxiv_id: str | None = None
    doi: str | None = None
    refkey: str | None = None
    tag: str = "M1-r1"
    download: str = "auto"  # none|auto|arxiv_source|arxiv_pdf|both
    overwrite_note: bool = False
    append_query_log: bool = True


def _safe_slug(s: str) -> str:
    s = s.strip()
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", s)
    s = re.sub(r"-{2,}", "-", s)
    return s.strip("-") or "item"


def _parse_arxiv_id(value: str) -> str:
    value = value.strip()
    value = value.removeprefix("arXiv:")
    value = value.replace("https://arxiv.org/abs/", "")
    value = value.replace("https://arxiv.org/pdf/", "").removesuffix(".pdf")
    return value


def _format_authors_short(inspire_authors: list[dict[str, Any]] | None) -> str:
    if not inspire_authors:
        return "(unknown)"
    surnames: list[str] = []
    for a in inspire_authors:
        full = (a.get("full_name") or "").strip()
        if not full:
            continue
        # INSPIRE format is usually "Surname, Given"
        surname = full.split(",", 1)[0].strip() if "," in full else full.split()[-1].strip()
        if surname:
            surnames.append(surname)
    if not surnames:
        return "(unknown)"
    if len(surnames) <= 3:
        return ", ".join(surnames)
    return f"{surnames[0]} et al."


def _format_authors_short_from_names(names: list[str]) -> str:
    if not names:
        return "(unknown)"
    surnames: list[str] = []
    for full in names:
        full = full.strip()
        if not full:
            continue
        surname = full.split()[-1].strip()
        if surname:
            surnames.append(surname)
    if not surnames:
        return "(unknown)"
    if len(surnames) <= 3:
        return ", ".join(surnames)
    return f"{surnames[0]} et al."


def _normalize_doi(value: str) -> str:
    value = value.strip()
    value = value.removeprefix("https://doi.org/")
    value = value.removeprefix("http://doi.org/")
    value = value.removeprefix("doi:")
    return value.strip()


def _fallback_refkey(*, inspire_recid: str | None, arxiv_id: str | None, doi: str | None) -> str:
    if inspire_recid and str(inspire_recid).strip():
        return f"recid-{_safe_slug(str(inspire_recid).strip())}"
    if arxiv_id and str(arxiv_id).strip():
        return f"arxiv-{_safe_slug(_parse_arxiv_id(str(arxiv_id).strip()))}"
    if doi and str(doi).strip():
        return f"doi-{_safe_slug(_normalize_doi(str(doi).strip())).lower()}"
    return "item"


def _write_failure_note_if_needed(
    *,
    note_path: Path,
    header: str,
    refkey: str,
    lines: list[str],
    overwrite: bool,
) -> bool:
    if note_path.exists() and not overwrite:
        return False
    md = [f"# {header}", "", f"RefKey: {refkey}", ""]
    md.extend(lines)
    if not md[-1].endswith("\n"):
        md.append("")
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text("\n".join(md).rstrip() + "\n", encoding="utf-8")
    return True


def _guess_year_from_metadata(md: dict[str, Any]) -> str:
    # Prefer preprint_date (YYYY-MM-DD)
    preprint_date = (md.get("preprint_date") or "").strip()
    m = re.match(r"^(\d{4})-", preprint_date)
    if m:
        return m.group(1)
    # Fall back to earliest "imprints" year if present (rare)
    for imprint in md.get("imprints") or []:
        date = (imprint.get("date") or "").strip()
        m2 = re.match(r"^(\d{4})-", date)
        if m2:
            return m2.group(1)
    return "(unknown)"


def _format_publication(md: dict[str, Any]) -> str:
    arx = (md.get("arxiv_eprints") or [])[:1]
    if arx:
        arxiv_id = arx[0].get("value")
        cats = arx[0].get("categories") or []
        cat = cats[0] if cats else None
        if arxiv_id and cat:
            return f"arXiv:{arxiv_id} [{cat}]"
        if arxiv_id:
            return f"arXiv:{arxiv_id}"
    pubinfo = (md.get("publication_info") or [])[:1]
    if pubinfo:
        pi = pubinfo[0]
        journal = pi.get("journal_title")
        volume = pi.get("journal_volume")
        year = pi.get("year")
        pages = pi.get("page_start")
        parts = [p for p in [journal, volume, pages, str(year) if year else None] if p]
        if parts:
            return " ".join(parts)
    return "(unknown)"


def _ensure_append_only_row(path: Path, row: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        raise FileNotFoundError(f"append-only log missing: {path}")
    existing = path.read_text(encoding="utf-8")
    if not existing.endswith("\n"):
        existing += "\n"
    path.write_text(existing + row, encoding="utf-8")


def _append_literature_query_log(
    *,
    repo_root: Path,
    source: str,
    query: str,
    shortlist_link: str,
    decision: str,
    local_kb_note_rel: str,
) -> None:
    log_path = repo_root / "knowledge_base/methodology_traces/literature_queries.md"
    timestamp = utc_now_iso().replace("+00:00", "Z")
    row = (
        f"| {timestamp} | {source} | {query} | direct id input | {shortlist_link} | {decision} | "
        f"[{Path(local_kb_note_rel).stem}](../literature/{Path(local_kb_note_rel).name}) |\n"
    )
    _ensure_append_only_row(log_path, row)


def _write_note_if_needed(
    *,
    note_path: Path,
    title: str,
    refkey: str,
    year: str,
    inspire_recid: str | None,
    citekey: str | None,
    authors_short: str,
    publication: str,
    links: list[tuple[str, str]],
    overwrite: bool,
) -> bool:
    if note_path.exists() and not overwrite:
        return False
    links_md = "\n".join([f"- {label}: {url}" for label, url in links]) or "- (none)"
    header = f"{title} — {authors_short} ({year})" if year and year != "(unknown)" else f"{title} — {authors_short}"
    md = [
        f"# {header}",
        "",
        f"RefKey: {refkey}",
    ]
    if inspire_recid:
        md.append(f"INSPIRE recid: {inspire_recid}")
    if citekey:
        md.append(f"Citekey: {citekey}")
    md.extend(
        [
            f"Authors: {authors_short}",
            f"Publication: {publication}",
            "Links:",
            links_md,
            "",
            "## Key points (to fill)",
            "",
            "- (fill)",
            "",
            "## Skepticism / checks to do",
            "",
            "- (fill) What is the main claim? What would falsify it?",
            "- (fill) Identify 1–2 equations/figures to spot-check later.",
            "",
            "Verification status: metadata-only (auto-generated; full text not yet deep-read)",
            "What was checked:",
            "- metadata only (title/authors/links)",
            "",
        ]
    )
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text("\n".join(md), encoding="utf-8")
    return True


def _extract_title(md: dict[str, Any]) -> str:
    titles = md.get("titles") or []
    if titles:
        title = (titles[0].get("title") or "").strip()
        if title:
            return title
    return "(untitled)"


def _extract_citekey(md: dict[str, Any]) -> str | None:
    texkeys = md.get("texkeys") or []
    return texkeys[0].strip() if texkeys else None


def _extract_arxiv(md: dict[str, Any]) -> tuple[str | None, str | None]:
    arx = md.get("arxiv_eprints") or []
    if not arx:
        return None, None
    arxiv_id = arx[0].get("value")
    cat = None
    cats = arx[0].get("categories") or []
    if cats:
        cat = cats[0]
    return (arxiv_id.strip() if arxiv_id else None, cat)


def _inspire_resolve_unique_recid(query: str) -> str | None:
    url = "https://inspirehep.net/api/literature?" + urllib.parse.urlencode({"q": query, "size": "2"})
    data = http_get_json(url)
    hits = ((data.get("hits") or {}).get("hits") or []) if isinstance(data, dict) else []
    total = (data.get("hits") or {}).get("total") if isinstance(data, dict) else None

    try:
        total_int = int(total) if total is not None else None
    except Exception:
        total_int = None

    if total_int != 1 or not hits:
        return None
    hit0 = hits[0]
    recid = hit0.get("id") or (hit0.get("metadata") or {}).get("control_number")
    return str(recid) if recid else None


_ARXIV_NS = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def _xml_text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    return " ".join(el.text.split())


def _fetch_arxiv_atom_entry(arxiv_id: str) -> dict[str, Any]:
    arxiv_id = _parse_arxiv_id(arxiv_id)
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode({"id_list": arxiv_id})
    xml_text = http_get_text(url)
    root = ET.fromstring(xml_text)
    entry = root.find("atom:entry", _ARXIV_NS)
    if entry is None:
        raise RuntimeError(f"arXiv Atom API returned no entry for id_list={arxiv_id}")

    entry_id = _xml_text(entry.find("atom:id", _ARXIV_NS))
    title = _xml_text(entry.find("atom:title", _ARXIV_NS))
    summary = _xml_text(entry.find("atom:summary", _ARXIV_NS))
    published = _xml_text(entry.find("atom:published", _ARXIV_NS))
    updated = _xml_text(entry.find("atom:updated", _ARXIV_NS))
    authors = [_xml_text(a.find("atom:name", _ARXIV_NS)) for a in entry.findall("atom:author", _ARXIV_NS)]
    authors = [a for a in authors if a]
    links = [l.attrib.get("href") for l in entry.findall("atom:link", _ARXIV_NS)]
    links = [l for l in links if l]
    primary_category = entry.find("arxiv:primary_category", _ARXIV_NS)
    primary_cat = primary_category.attrib.get("term") if primary_category is not None else None

    return {
        "arxiv_id": arxiv_id,
        "entry_id": entry_id,
        "title": title,
        "authors": authors,
        "published": published,
        "updated": updated,
        "summary": summary,
        "primary_category": primary_cat,
        "links": links,
        "source_url": url,
    }


def _year_from_iso_date(s: str | None) -> str:
    if not s:
        return "(unknown)"
    m = re.match(r"^(\d{4})-", s.strip())
    return m.group(1) if m else "(unknown)"


def _write_arxiv_note_if_needed(
    *,
    note_path: Path,
    title: str,
    refkey: str,
    year: str,
    arxiv_id: str,
    primary_category: str | None,
    authors: list[str],
    links: list[tuple[str, str]],
    overwrite: bool,
) -> bool:
    if note_path.exists() and not overwrite:
        return False
    links_md = "\n".join([f"- {label}: {url}" for label, url in links]) or "- (none)"
    authors_short = _format_authors_short_from_names(authors)
    header = f"{title} — {authors_short} ({year})" if year and year != "(unknown)" else f"{title} — {authors_short}"
    arxiv_line = f"arXiv: {arxiv_id}" + (f" [{primary_category}]" if primary_category else "")
    md = [
        f"# {header}",
        "",
        f"RefKey: {refkey}",
        arxiv_line,
        "Links:",
        links_md,
        "",
        "## Key points (to fill)",
        "",
        "- (fill)",
        "",
        "## Skepticism / checks to do",
        "",
        "- (fill) What is the main claim? What would falsify it?",
        "- (fill) Identify 1–2 equations/figures to spot-check later.",
        "",
        "Verification status: metadata-only (auto-generated; full text not yet deep-read)",
        "What was checked:",
        "- metadata only (title/authors/links)",
        "",
    ]
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text("\n".join(md), encoding="utf-8")
    return True


def _write_doi_note_if_needed(
    *,
    note_path: Path,
    title: str,
    refkey: str,
    year: str,
    doi: str,
    authors: list[str],
    links: list[tuple[str, str]],
    overwrite: bool,
) -> bool:
    if note_path.exists() and not overwrite:
        return False
    links_md = "\n".join([f"- {label}: {url}" for label, url in links]) or "- (none)"
    authors_short = _format_authors_short_from_names(authors)
    header = f"{title} — {authors_short} ({year})" if year and year != "(unknown)" else f"{title} — {authors_short}"
    md = [
        f"# {header}",
        "",
        f"RefKey: {refkey}",
        f"DOI: {doi}",
        "Links:",
        links_md,
        "",
        "## Key points (to fill)",
        "",
        "- (fill)",
        "",
        "## Skepticism / checks to do",
        "",
        "- (fill) What is the main claim? What would falsify it?",
        "- (fill) Identify 1–2 equations/figures to spot-check later.",
        "",
        "Verification status: metadata-only (auto-generated; full text not yet deep-read)",
        "What was checked:",
        "- metadata only (title/authors/links)",
        "",
    ]
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text("\n".join(md), encoding="utf-8")
    return True


def _download_arxiv_assets(
    *,
    repo_root: Path,
    arxiv_id: str,
    mode: str,
) -> dict[str, str]:
    arxiv_id = _parse_arxiv_id(arxiv_id)
    out_dir = repo_root / "references" / "arxiv" / arxiv_id
    outputs: dict[str, str] = {}

    def _try_source() -> None:
        src_path = out_dir / "source.tar"
        http_download(f"https://arxiv.org/e-print/{arxiv_id}", src_path)
        outputs["arxiv_source_archive"] = os.fspath(src_path.relative_to(repo_root))
        # Try to extract (best effort)
        extract_dir = out_dir / "source"
        extract_dir.mkdir(parents=True, exist_ok=True)
        try:
            with tarfile.open(src_path) as tf:
                tf.extractall(extract_dir)
            outputs["arxiv_source_dir"] = os.fspath(extract_dir.relative_to(repo_root))
        except tarfile.TarError:
            # Some arXiv sources are not tar (e.g. gzipped single-file TeX). Keep archive,
            # but also try a best-effort gzip fallback to make the source usable.
            try:
                raw = src_path.read_bytes()
                if len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B:
                    tex_bytes = gzip.decompress(raw)
                    tex_path = extract_dir / f"{_safe_slug(arxiv_id)}.tex"
                    if not tex_path.exists():
                        tex_path.write_bytes(tex_bytes)
                    outputs["arxiv_source_dir"] = os.fspath(extract_dir.relative_to(repo_root))
                    outputs["arxiv_source_single_tex"] = os.fspath(tex_path.relative_to(repo_root))
            except Exception:
                pass

    def _try_pdf() -> None:
        pdf_path = out_dir / f"{arxiv_id}.pdf"
        http_download(f"https://arxiv.org/pdf/{arxiv_id}.pdf", pdf_path)
        outputs["arxiv_pdf"] = os.fspath(pdf_path.relative_to(repo_root))

    if mode in {"auto", "arxiv_source", "both"}:
        try:
            _try_source()
        except Exception:
            if mode in {"arxiv_source"}:
                raise
            # auto falls back to PDF
    if mode in {"auto", "arxiv_pdf", "both"} and "arxiv_pdf" not in outputs:
        try:
            _try_pdf()
        except Exception:
            if mode in {"arxiv_pdf"}:
                raise
    return outputs


def ingest_one(inps: IngestInputs, repo_root: Path) -> dict[str, Any]:
    if not (inps.inspire_recid or inps.arxiv_id or inps.doi):
        raise ValueError("must provide one of inspire_recid/arxiv_id/doi")

    created_at = utc_now_iso()
    outputs: dict[str, Any] = {"files": [], "notes_created": False, "snapshots": {}}
    errors: list[str] = []
    refkey = str(inps.refkey).strip() if inps.refkey and str(inps.refkey).strip() else None

    # 1) Resolve stable anchor (prefer INSPIRE recid when resolvable)
    resolved_inspire_recid: str | None = None
    resolved_query: str | None = None
    resolved_note: str | None = None

    arxiv_id_clean = _parse_arxiv_id(inps.arxiv_id) if inps.arxiv_id else None
    doi_clean = _normalize_doi(inps.doi) if inps.doi else None

    if inps.inspire_recid:
        resolved_inspire_recid = inps.inspire_recid.strip()
        resolved_query = f"recid:{resolved_inspire_recid}"
        resolved_note = "direct INSPIRE recid input"
    elif arxiv_id_clean:
        resolved_query = f"eprint:{arxiv_id_clean}"
        try:
            resolved_inspire_recid = _inspire_resolve_unique_recid(resolved_query)
        except Exception as e:
            errors.append(f"INSPIRE resolve failed for {resolved_query}: {e}")
            resolved_inspire_recid = None
        resolved_note = (
            "resolved via INSPIRE by eprint" if resolved_inspire_recid else "no INSPIRE match; using arXiv metadata"
        )
    elif doi_clean:
        resolved_query = f"doi:{doi_clean}"
        try:
            resolved_inspire_recid = _inspire_resolve_unique_recid(resolved_query)
        except Exception as e:
            errors.append(f"INSPIRE resolve failed for {resolved_query}: {e}")
            resolved_inspire_recid = None
        resolved_note = (
            "resolved via INSPIRE by doi" if resolved_inspire_recid else "no INSPIRE match; using Crossref metadata"
        )

    if refkey is None:
        refkey = _fallback_refkey(inspire_recid=resolved_inspire_recid or inps.inspire_recid, arxiv_id=arxiv_id_clean, doi=doi_clean)

    if resolved_inspire_recid:
        recid = resolved_inspire_recid
        inspire_url = f"https://inspirehep.net/literature/{recid}"
        api_url = f"https://inspirehep.net/api/literature/{recid}"
        bibtex_url = f"https://inspirehep.net/api/literature/{recid}?format=bibtex"

        raw: dict[str, Any] | None = None
        md: dict[str, Any] = {}
        try:
            raw = http_get_json(api_url)
            md = raw.get("metadata") or {}
        except Exception as e:
            errors.append(f"INSPIRE API download failed: {e}")

        title = _extract_title(md) if md else "(unknown title)"
        citekey = _extract_citekey(md) if md else None
        authors_short = _format_authors_short(md.get("authors")) if md else "(unknown)"
        publication = _format_publication(md) if md else "(unknown)"
        arxiv_id, arxiv_cat = _extract_arxiv(md) if md else (None, None)
        year = _guess_year_from_metadata(md) if md else "(unknown)"

        if not inps.refkey and md:
            refkey = f"recid-{recid}-{_safe_slug(title).lower()}"
        elif not inps.refkey and not md:
            refkey = f"recid-{_safe_slug(recid).lower()}"

        # 2) Write reference snapshots (best effort; in replay mode this is deterministic)
        snap_dir = repo_root / "references" / "inspire" / f"recid-{recid}"
        snap_dir.mkdir(parents=True, exist_ok=True)
        if raw is not None:
            raw_path = snap_dir / "literature.json"
            write_json(raw_path, raw)
            outputs["files"].append(os.fspath(raw_path.relative_to(repo_root)))

        try:
            bibtex = http_get_text(bibtex_url)
            bib_path = snap_dir / "literature.bib"
            bib_path.write_text(bibtex, encoding="utf-8")
            outputs["files"].append(os.fspath(bib_path.relative_to(repo_root)))
        except Exception as e:
            errors.append(f"bibtex download failed: {e}")

        extracted_path = snap_dir / "extracted.json"
        if md:
            extracted = {
                "refkey": refkey,
                "inspire_recid": recid,
                "citekey": citekey,
                "title": title,
                "authors_short": authors_short,
                "year": year,
                "publication": publication,
                "links": {
                    "inspire": inspire_url,
                    "inspire_api": api_url,
                    "arxiv": f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else None,
                },
                "arxiv": {"id": arxiv_id, "primary_class": arxiv_cat},
            }
            write_json(extracted_path, extracted)
            outputs["files"].append(os.fspath(extracted_path.relative_to(repo_root)))
            outputs["snapshots"]["inspire"] = os.fspath(snap_dir.relative_to(repo_root))
        else:
            # IMPORTANT: do not overwrite an existing snapshot with placeholder values when
            # metadata fetch fails (e.g. HEPAR_HTTP_MODE=fail_all). Keep the last good snapshot.
            if extracted_path.exists():
                outputs["snapshots"]["inspire"] = os.fspath(snap_dir.relative_to(repo_root))

        # 3) Download arXiv assets (best effort)
        if inps.download != "none" and arxiv_id:
            try:
                dl = _download_arxiv_assets(repo_root=repo_root, arxiv_id=arxiv_id, mode=inps.download)
                outputs["files"].extend(list(dl.values()))
                outputs["snapshots"]["arxiv"] = f"references/arxiv/{_parse_arxiv_id(arxiv_id)}"
            except Exception as e:
                errors.append(f"arXiv download failed: {e}")

        # 4) Write/update KB note (metadata-only default)
        note_path = repo_root / "knowledge_base" / "literature" / f"{refkey}.md"
        links: list[tuple[str, str]] = [("INSPIRE", inspire_url)]
        if arxiv_id:
            links.append(("arXiv", f"https://arxiv.org/abs/{arxiv_id}"))
        if md:
            created = _write_note_if_needed(
                note_path=note_path,
                title=title,
                refkey=refkey,
                year=year,
                inspire_recid=recid,
                citekey=citekey,
                authors_short=authors_short,
                publication=publication,
                links=links,
                overwrite=inps.overwrite_note,
            )
        else:
            created = _write_failure_note_if_needed(
                note_path=note_path,
                header=f"INSPIRE recid-{recid} — (ingest failed)",
                refkey=refkey,
                lines=[
                    f"INSPIRE recid: {recid}",
                    "Links:",
                    f"- INSPIRE: {inspire_url}",
                    "",
                    "## Ingest status",
                    "",
                    "- FAILED to fetch metadata (see errors in artifacts).",
                    "",
                    "Verification status: ingest-failed",
                    "What was checked:",
                    "- network access failed (no metadata)",
                    "",
                ],
                overwrite=inps.overwrite_note,
            )
        outputs["notes_created"] = created
        outputs["files"].append(os.fspath(note_path.relative_to(repo_root)))

        # 5) Append query log (append-only)
        if inps.append_query_log:
            try:
                decision = f"ingested (auto); {resolved_note or ''}".strip()
                if not md:
                    decision = f"failed (auto); {resolved_note or ''}".strip()
                _append_literature_query_log(
                    repo_root=repo_root,
                    source="INSPIRE",
                    query=resolved_query or f"recid:{recid}",
                    shortlist_link=inspire_url,
                    decision=decision,
                    local_kb_note_rel=os.fspath(note_path.relative_to(repo_root)),
                )
            except Exception as e:
                errors.append(f"query log append failed: {e}")

    elif arxiv_id_clean:
        # arXiv-only fallback (metadata via Atom API)
        entry: dict[str, Any] | None = None
        try:
            entry = _fetch_arxiv_atom_entry(arxiv_id_clean)
        except Exception as e:
            errors.append(f"arXiv Atom metadata failed: {e}")
        title = ((entry or {}).get("title") or "(unknown title)").strip()
        authors = (entry or {}).get("authors") or []
        year = _year_from_iso_date((entry or {}).get("published"))
        primary_cat = (entry or {}).get("primary_category")

        if not inps.refkey and entry is not None:
            refkey = f"arxiv-{arxiv_id_clean}-{_safe_slug(title).lower()}"
        elif not inps.refkey:
            refkey = f"arxiv-{arxiv_id_clean}"

        snap_dir = repo_root / "references" / "arxiv" / arxiv_id_clean
        snap_dir.mkdir(parents=True, exist_ok=True)
        if entry is not None:
            meta_path = snap_dir / "metadata.json"
            write_json(meta_path, entry)
            outputs["files"].append(os.fspath(meta_path.relative_to(repo_root)))
            outputs["snapshots"]["arxiv"] = os.fspath(snap_dir.relative_to(repo_root))

        if inps.download != "none":
            try:
                dl = _download_arxiv_assets(repo_root=repo_root, arxiv_id=arxiv_id_clean, mode=inps.download)
                outputs["files"].extend(list(dl.values()))
            except Exception as e:
                errors.append(f"arXiv download failed: {e}")

        note_path = repo_root / "knowledge_base" / "literature" / f"{refkey}.md"
        if entry is not None:
            created = _write_arxiv_note_if_needed(
                note_path=note_path,
                title=title,
                refkey=refkey,
                year=year,
                arxiv_id=arxiv_id_clean,
                primary_category=primary_cat,
                authors=authors,
                links=[("arXiv", f"https://arxiv.org/abs/{arxiv_id_clean}")],
                overwrite=inps.overwrite_note,
            )
        else:
            created = _write_failure_note_if_needed(
                note_path=note_path,
                header=f"arXiv:{arxiv_id_clean} — (ingest failed)",
                refkey=refkey,
                lines=[
                    f"arXiv: {arxiv_id_clean}",
                    "Links:",
                    f"- arXiv: https://arxiv.org/abs/{arxiv_id_clean}",
                    "",
                    "## Ingest status",
                    "",
                    "- FAILED to fetch metadata (see errors in artifacts).",
                    "",
                    "Verification status: ingest-failed",
                    "What was checked:",
                    "- network access failed (no metadata)",
                    "",
                ],
                overwrite=inps.overwrite_note,
            )
        outputs["notes_created"] = created
        outputs["files"].append(os.fspath(note_path.relative_to(repo_root)))

        if inps.append_query_log:
            try:
                decision = "ingested (auto); arXiv Atom metadata"
                if entry is None:
                    decision = "failed (auto); arXiv Atom metadata"
                _append_literature_query_log(
                    repo_root=repo_root,
                    source="arXiv",
                    query=f"id:{arxiv_id_clean}",
                    shortlist_link=f"https://arxiv.org/abs/{arxiv_id_clean}",
                    decision=decision,
                    local_kb_note_rel=os.fspath(note_path.relative_to(repo_root)),
                )
            except Exception as e:
                errors.append(f"query log append failed: {e}")

    elif doi_clean:
        # DOI-only fallback (metadata via Crossref)
        url = "https://api.crossref.org/works/" + urllib.parse.quote(doi_clean)
        raw: dict[str, Any] | None = None
        try:
            raw = http_get_json(url)
        except Exception as e:
            errors.append(f"Crossref metadata failed: {e}")
        message = raw.get("message") if isinstance(raw, dict) else None
        if not isinstance(message, dict):
            errors.append("Crossref response missing 'message'")
            message = {}
        title_list = message.get("title") or []
        title = title_list[0] if title_list else "(unknown title)"
        authors = []
        for a in message.get("author") or []:
            family = (a.get("family") or "").strip()
            given = (a.get("given") or "").strip()
            full = " ".join([p for p in [given, family] if p])
            if full:
                authors.append(full)
        year = "(unknown)"
        for key in ["published-print", "published-online", "created", "issued"]:
            parts = ((message.get(key) or {}).get("date-parts") or [])
            if parts and isinstance(parts[0], list) and parts[0]:
                year = str(parts[0][0])
                break

        if not inps.refkey and raw is not None:
            refkey = f"doi-{_safe_slug(doi_clean).lower()}"
        elif not inps.refkey:
            refkey = _fallback_refkey(inspire_recid=None, arxiv_id=None, doi=doi_clean)
        snap_dir = repo_root / "references" / "doi" / _safe_slug(doi_clean)
        snap_dir.mkdir(parents=True, exist_ok=True)
        if raw is not None:
            meta_path = snap_dir / "crossref.json"
            write_json(meta_path, raw)
            outputs["files"].append(os.fspath(meta_path.relative_to(repo_root)))
            outputs["snapshots"]["doi"] = os.fspath(snap_dir.relative_to(repo_root))

        note_path = repo_root / "knowledge_base" / "literature" / f"{refkey}.md"
        if raw is not None:
            created = _write_doi_note_if_needed(
                note_path=note_path,
                title=str(title).strip(),
                refkey=refkey,
                year=year,
                doi=doi_clean,
                authors=authors,
                links=[("DOI", f"https://doi.org/{doi_clean}")],
                overwrite=inps.overwrite_note,
            )
        else:
            created = _write_failure_note_if_needed(
                note_path=note_path,
                header=f"DOI:{doi_clean} — (ingest failed)",
                refkey=refkey,
                lines=[
                    f"DOI: {doi_clean}",
                    "Links:",
                    f"- DOI: https://doi.org/{doi_clean}",
                    "",
                    "## Ingest status",
                    "",
                    "- FAILED to fetch metadata (see errors in artifacts).",
                    "",
                    "Verification status: ingest-failed",
                    "What was checked:",
                    "- network access failed (no metadata)",
                    "",
                ],
                overwrite=inps.overwrite_note,
            )
        outputs["notes_created"] = created
        outputs["files"].append(os.fspath(note_path.relative_to(repo_root)))

        if inps.append_query_log:
            try:
                decision = "ingested (auto); Crossref metadata"
                if raw is None:
                    decision = "failed (auto); Crossref metadata"
                _append_literature_query_log(
                    repo_root=repo_root,
                    source="Crossref",
                    query=f"doi:{doi_clean}",
                    shortlist_link=f"https://doi.org/{doi_clean}",
                    decision=decision,
                    local_kb_note_rel=os.fspath(note_path.relative_to(repo_root)),
                )
            except Exception as e:
                errors.append(f"query log append failed: {e}")

    # 6) Write artifacts bundle
    out_dir = repo_root / "artifacts" / "runs" / inps.tag / "ingest" / _safe_slug(refkey)
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"

    git_meta = try_get_git_metadata(repo_root)
    run_card_rel, run_card_sha = ensure_run_card(
        repo_root=repo_root,
        run_id=str(inps.tag),
        workflow_id="W1_ingest",
        params={
            "tag": inps.tag,
            "inspire_recid": inps.inspire_recid,
            "arxiv_id": inps.arxiv_id,
            "doi": inps.doi,
            "refkey": refkey,
            "download": inps.download,
            "overwrite_note": bool(inps.overwrite_note),
        },
        backend={"kind": "python", "argv": ["python3", "scripts/run_w1_ingest.py"], "cwd": ".", "env": {}},
        notes="auto-generated run-card (v0)",
        overwrite=False,
    )
    manifest = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_w1_ingest.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "inputs": {"run_card_path": run_card_rel, "run_card_sha256": run_card_sha},
        "params": {
            "tag": inps.tag,
            "inspire_recid": inps.inspire_recid,
            "arxiv_id": inps.arxiv_id,
            "doi": inps.doi,
            "resolved_inspire_recid": resolved_inspire_recid,
            "resolved_query": resolved_query,
            "resolved_note": resolved_note,
            "refkey": refkey,
            "download": inps.download,
            "overwrite_note": inps.overwrite_note,
        },
        "versions": {"python": os.sys.version.split()[0]},
        "outputs": [os.fspath(p.relative_to(repo_root)) for p in [manifest_path, summary_path, analysis_path, report_path]],
    }
    if git_meta:
        manifest["git"] = git_meta

    summary = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "W1_ingest"},
        "stats": {"errors": len(errors)},
        "outputs": outputs,
    }
    analysis = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "inspire_recid": inps.inspire_recid,
            "arxiv_id": inps.arxiv_id,
            "doi": inps.doi,
            "refkey": inps.refkey,
        },
        "results": {"ok": len(errors) == 0, "errors": errors},
    }

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
    return {
        "refkey": refkey,
        "outputs": outputs,
        "errors": errors,
        "artifact_paths": artifact_paths,
        "artifact_dir": os.fspath(out_dir.relative_to(repo_root)),
    }


def ingest_many(inputs: Iterable[IngestInputs], repo_root: Path) -> list[dict[str, Any]]:
    return [ingest_one(inps, repo_root=repo_root) for inps in inputs]
