#!/usr/bin/env python3
"""
fetch_prl_style_corpus.py

Fetch an exemplar paper corpus via INSPIRE → arXiv LaTeX sources.

Intended use in `research-writer`: build a local set of primary-source LaTeX
files that you can *read* to learn **general physics discussion logic**
(argument flow, diagnostics, uncertainty narration). This is not about
superficial PRL formatting.

Primary use (FK/Meissner/Hoferichter PRL query):
  python3 fetch_prl_style_corpus.py \
    --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20f%20k%20guo%20or%20a%20u%20g%20meissner%20or%20a%20m%20hoferichter%29%20and%20j%20phys.rev.lett.&ui-citation-summary=true" \
    --max-records 10 \
    --out-dir /tmp/prl_style_corpus

Notes:
- Best-effort and network-robust: failures are logged to JSONL and the script continues.
- INSPIRE may rate-limit (HTTP 429). If you see that in the trace, reduce `--max-records` and retry later.
- Output is a *local* corpus for discussion-logic learning; do NOT copy text verbatim into new manuscripts.
- Extraction is filtered to TeX/Bib/Sty-style files by default to keep the corpus small.
"""

from __future__ import annotations

import argparse
import io
import gzip
import json
import re
import sys
import tarfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ALLOWED_HOSTS = {"inspirehep.net", "arxiv.org", "export.arxiv.org"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _host_ok(url: str) -> bool:
    try:
        host = urlsplit(url).netloc.split(":", 1)[0].lower()
    except Exception:
        return False
    return host in ALLOWED_HOSTS


def _http_get(url: str, *, accept: str, timeout_s: int = 30) -> bytes:
    if not _host_ok(url):
        raise ValueError(f"refusing host not in allowlist: {url}")
    req = Request(url, headers={"Accept": accept})
    max_retries = 5
    for attempt in range(max_retries):
        try:
            with urlopen(req, timeout=timeout_s) as r:  # nosec - intended for controlled metadata fetch
                return r.read()
        except HTTPError as exc:
            if exc.code != 429 or attempt >= max_retries - 1:
                raise
            retry_after = (exc.headers.get("Retry-After") or "").strip()
            if retry_after.isdigit():
                sleep_s = int(retry_after)
            else:
                sleep_s = 5 * (2**attempt)
            sleep_s = max(1, min(int(sleep_s), 300))
            host = urlsplit(url).netloc.split(":", 1)[0]
            print(f"[rate-limit] HTTP 429 from {host}; sleeping {sleep_s}s then retry {attempt + 2}/{max_retries}", file=sys.stderr)
            time.sleep(sleep_s)
    raise RuntimeError("unreachable")


def _safe_id(s: str) -> str:
    s = (s or "").strip()
    s = s.replace("/", "_")
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s)
    return s.strip("_") or "unknown"


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")


def _parse_inspire_query(query_url: str | None, query: str | None) -> tuple[str, dict[str, str]]:
    if query and query.strip():
        return query.strip(), {}
    if not query_url:
        raise ValueError("either --query or --query-url must be provided")

    u = urlsplit(query_url)
    if not u.netloc:
        raise ValueError(f"invalid query url: {query_url!r}")
    host = u.netloc.split(":", 1)[0].lower()
    if host != "inspirehep.net":
        raise ValueError(f"refusing --query-url host != inspirehep.net: {host!r}")
    qs = parse_qs(u.query)
    q_vals = qs.get("q") or []
    if not q_vals or not q_vals[0].strip():
        raise ValueError("failed to extract q=... from --query-url")
    q = q_vals[0].strip()

    # Pass through additional INSPIRE UI filters that are accepted by the API.
    # Example: author_count=10 authors or fewer, arxiv_categories=hep-ph
    extra: dict[str, str] = {}
    for k in ("author_count", "arxiv_categories"):
        v = (qs.get(k) or [""])[0]
        if isinstance(v, str) and v.strip():
            extra[k] = v.strip()
    return q, extra


def _inspire_api_url(query: str, *, size: int, page: int, sort: str, extra_params: dict[str, str] | None = None) -> str:
    q_enc = quote(query)
    parts = [
        f"sort={quote(sort)}",
        f"size={int(size)}",
        f"page={int(page)}",
        f"q={q_enc}",
    ]
    if extra_params:
        for k in sorted(extra_params.keys()):
            v = extra_params[k]
            parts.append(f"{quote(str(k))}={quote(str(v))}")
    return "https://inspirehep.net/api/literature?" + "&".join(parts)


def _extract_arxiv_id(md: dict[str, Any]) -> str:
    eprints = md.get("arxiv_eprints")
    if isinstance(eprints, list):
        for e in eprints:
            if isinstance(e, dict) and isinstance(e.get("value"), str) and e["value"].strip():
                return e["value"].strip()
    return ""


def _extract_title(md: dict[str, Any]) -> str:
    titles = md.get("titles")
    if isinstance(titles, list) and titles:
        t0 = titles[0] if isinstance(titles[0], dict) else {}
        v = t0.get("title")
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _extract_year(md: dict[str, Any]) -> str:
    for key in ("preprint_date", "legacy_creation_date", "created"):
        v = md.get(key)
        if isinstance(v, str) and len(v) >= 4 and v[:4].isdigit():
            return v[:4]
    pub = md.get("publication_info")
    if isinstance(pub, list) and pub:
        p0 = pub[0] if isinstance(pub[0], dict) else {}
        y = p0.get("year")
        if isinstance(y, int):
            return str(y)
        if isinstance(y, str) and y.strip():
            return y.strip()
    return ""


def _extract_doi(md: dict[str, Any]) -> str:
    dois = md.get("dois")
    if isinstance(dois, list):
        for d in dois:
            if isinstance(d, dict) and isinstance(d.get("value"), str) and d["value"].strip():
                return d["value"].strip()
    return ""


def _extract_authors(md: dict[str, Any]) -> list[str]:
    authors = md.get("authors")
    out: list[str] = []
    if isinstance(authors, list):
        for a in authors:
            if not isinstance(a, dict):
                continue
            name = a.get("full_name") or a.get("name") or ""
            if isinstance(name, str) and name.strip():
                out.append(name.strip())
    return out


def _safe_member_path(name: str) -> Path | None:
    """
    Safe relative path (reject absolute and .. traversal).
    """
    try:
        p = Path(name)
    except Exception:
        return None
    if p.is_absolute():
        return None
    if ".." in p.parts:
        return None
    return p


def _download_arxiv_source(arxiv_id: str) -> bytes:
    # arXiv source endpoint usually returns a tar(.gz) stream, but can also return
    # a gzip-compressed single file (e.g. a lone .tex) depending on the submission.
    url = f"https://arxiv.org/e-print/{quote(arxiv_id)}"
    return _http_get(url, accept="application/x-tar, application/octet-stream")


def _gzip_member_filename(gz_bytes: bytes) -> str | None:
    """
    Best-effort parse of the "original filename" field from a gzip header.
    Returns only the basename (no dirs) or None if not present/invalid.
    """
    if len(gz_bytes) < 10 or not gz_bytes.startswith(b"\x1f\x8b"):
        return None
    flg = gz_bytes[3]
    pos = 10
    # FEXTRA
    if flg & 0x04:
        if pos + 2 > len(gz_bytes):
            return None
        xlen = int.from_bytes(gz_bytes[pos : pos + 2], "little", signed=False)
        pos += 2 + xlen
        if pos > len(gz_bytes):
            return None
    # FNAME
    if flg & 0x08:
        end = gz_bytes.find(b"\x00", pos)
        if end == -1:
            return None
        raw = gz_bytes[pos:end]
        try:
            name = raw.decode("latin-1", errors="replace").strip()
        except Exception:
            return None
        if not name:
            return None
        name = Path(name).name
        return name or None
    return None


def _write_single_payload(
    payload: bytes,
    *,
    out_dir: Path,
    exts: set[str],
    trace_path: Path,
    arxiv_id: str,
    hint_name: str | None,
    event: str,
) -> tuple[int, dict[str, int]]:
    """
    Write a single decompressed payload to disk as a .tex/.txt file (deterministic fallback).
    """
    name = (hint_name or "").strip()
    name = Path(name).name if name else ""
    if not name or Path(name).suffix.lower() not in exts:
        name = "source.tex" if ".tex" in exts else ("source.txt" if ".txt" in exts else "")
    if not name:
        _append_jsonl(trace_path, {"ts": _utc_now(), "event": f"{event}_skipped_no_allowed_ext", "arxiv_id": arxiv_id})
        return 0, {"seen_files": 1, "extracted_files": 0, "unsafe_rejected": 0, "skipped_ext": 1, "empty_or_unreadable": 0}

    dst = out_dir / name
    _ensure_dir(dst.parent)
    dst.write_bytes(payload)
    _append_jsonl(trace_path, {"ts": _utc_now(), "event": event, "arxiv_id": arxiv_id, "filename": name, "bytes": len(payload)})
    return 1, {"seen_files": 1, "extracted_files": 1, "unsafe_rejected": 0, "skipped_ext": 0, "empty_or_unreadable": 0}


@dataclass(frozen=True)
class Record:
    recid: str
    title: str
    year: str
    arxiv_id: str
    doi: str
    authors: list[str]


def _iter_inspire_records(
    query: str,
    *,
    size: int,
    max_records: int,
    sort: str,
    extra_params: dict[str, str],
    trace_path: Path,
) -> list[Record]:
    out: list[Record] = []
    page = 1
    logged_start = False
    seen_arxiv: set[str] = set()
    while len(out) < max_records:
        url = _inspire_api_url(query, size=size, page=page, sort=sort, extra_params=extra_params)
        try:
            raw = _http_get(url, accept="application/json")
            obj = json.loads(raw.decode("utf-8", errors="replace"))
            total_hits = obj.get("hits", {}).get("total", None)
            if not logged_start:
                _append_jsonl(
                    trace_path,
                    {
                        "ts": _utc_now(),
                        "event": "inspire_query_start",
                        "url": url,
                        "total_hits": total_hits,
                        "page_size": size,
                        "sort": sort,
                        "extra_params": extra_params,
                    },
                )
                logged_start = True
        except Exception as exc:
            _append_jsonl(trace_path, {"ts": _utc_now(), "event": "inspire_query_error", "url": url, "error": str(exc)})
            break

        hits = obj.get("hits", {}).get("hits", [])
        if not isinstance(hits, list) or not hits:
            break
        _append_jsonl(trace_path, {"ts": _utc_now(), "event": "inspire_page_ok", "page": page, "hits_returned": len(hits), "url": url})

        for h in hits:
            if len(out) >= max_records:
                break
            if not isinstance(h, dict):
                continue
            recid = str(h.get("id") or "").strip()
            md = h.get("metadata") if isinstance(h.get("metadata"), dict) else {}
            arxiv_id = _extract_arxiv_id(md)
            if not arxiv_id:
                _append_jsonl(
                    trace_path,
                    {"ts": _utc_now(), "event": "skip_no_arxiv", "recid": recid, "title": _extract_title(md)},
                )
                continue
            if arxiv_id in seen_arxiv:
                _append_jsonl(trace_path, {"ts": _utc_now(), "event": "skip_duplicate_arxiv", "arxiv_id": arxiv_id, "recid": recid})
                continue
            seen_arxiv.add(arxiv_id)
            out.append(
                Record(
                    recid=recid,
                    title=_extract_title(md),
                    year=_extract_year(md),
                    arxiv_id=arxiv_id,
                    doi=_extract_doi(md),
                    authors=_extract_authors(md),
                )
            )

        page += 1
    return out


def _extract_filtered_tar(
    tar_bytes: bytes,
    *,
    out_dir: Path,
    exts: set[str],
    trace_path: Path,
    arxiv_id: str,
) -> tuple[int, dict[str, int]]:
    count = 0
    unsafe_rejected = 0
    skipped_ext = 0
    empty_or_unreadable = 0
    seen_files = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:*") as tf:
            for m in tf.getmembers():
                if not m.isfile():
                    continue
                seen_files += 1
                mp = _safe_member_path(m.name)
                if mp is None:
                    unsafe_rejected += 1
                    continue
                suffix = mp.suffix.lower()
                if suffix not in exts:
                    skipped_ext += 1
                    continue
                try:
                    ef = tf.extractfile(m)
                    data = ef.read() if ef is not None else None
                except Exception:
                    data = None
                if not data:
                    empty_or_unreadable += 1
                    continue
                dst = out_dir / mp
                _ensure_dir(dst.parent)
                dst.write_bytes(data)
                count += 1
    except Exception as exc:
        _append_jsonl(trace_path, {"ts": _utc_now(), "event": "tar_open_error", "arxiv_id": arxiv_id, "error": str(exc)})
        # Fallback: arXiv sometimes serves a gzip-compressed *single file* (not a tarball).
        if tar_bytes.startswith(b"\x1f\x8b"):
            try:
                with gzip.GzipFile(fileobj=io.BytesIO(tar_bytes)) as gz:
                    payload = gz.read()
            except Exception as exc2:
                _append_jsonl(trace_path, {"ts": _utc_now(), "event": "gzip_fallback_error", "arxiv_id": arxiv_id, "error": str(exc2)})
                payload = b""
            if payload:
                hint = _gzip_member_filename(tar_bytes)
                return _write_single_payload(
                    payload,
                    out_dir=out_dir,
                    exts=exts,
                    trace_path=trace_path,
                    arxiv_id=arxiv_id,
                    hint_name=hint,
                    event="gzip_single_file_extracted",
                )

        # Fallback: some sources may be plain (non-archive) TeX.
        try:
            txt = tar_bytes.decode("utf-8", errors="ignore")
        except Exception:
            txt = ""
        if "\\documentclass" in txt or "\\begin{document}" in txt:
            return _write_single_payload(
                tar_bytes,
                out_dir=out_dir,
                exts=exts,
                trace_path=trace_path,
                arxiv_id=arxiv_id,
                hint_name="source.tex",
                event="plain_tex_extracted",
            )

        return 0, {
            "seen_files": seen_files,
            "extracted_files": 0,
            "unsafe_rejected": unsafe_rejected,
            "skipped_ext": skipped_ext,
            "empty_or_unreadable": empty_or_unreadable,
        }

    return count, {
        "seen_files": seen_files,
        "extracted_files": count,
        "unsafe_rejected": unsafe_rejected,
        "skipped_ext": skipped_ext,
        "empty_or_unreadable": empty_or_unreadable,
    }


def _has_extracted_files(rec_dir: Path, *, exts: set[str]) -> bool:
    if not rec_dir.is_dir():
        return False
    for p in rec_dir.rglob("*"):
        if not p.is_file():
            continue
        try:
            suf = p.suffix.lower()
        except Exception:
            continue
        if suf in exts:
            return True
    return False


def _records_from_inspire_obj(obj: dict[str, Any], *, max_records: int, trace_path: Path) -> list[Record]:
    hits = obj.get("hits", {}).get("hits", [])
    total = obj.get("hits", {}).get("total", None)
    if not isinstance(hits, list):
        hits = []
    _append_jsonl(
        trace_path,
        {"ts": _utc_now(), "event": "inspire_fixture_loaded", "total_hits": total, "hits_returned": len(hits)},
    )
    out: list[Record] = []
    seen_arxiv: set[str] = set()
    for h in hits:
        if len(out) >= max_records:
            break
        if not isinstance(h, dict):
            continue
        recid = str(h.get("id") or "").strip()
        md = h.get("metadata") if isinstance(h.get("metadata"), dict) else {}
        arxiv_id = _extract_arxiv_id(md)
        if not arxiv_id:
            continue
        if arxiv_id in seen_arxiv:
            continue
        seen_arxiv.add(arxiv_id)
        out.append(
            Record(
                recid=recid,
                title=_extract_title(md),
                year=_extract_year(md),
                arxiv_id=arxiv_id,
                doi=_extract_doi(md),
                authors=_extract_authors(md),
            )
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--query-url", default="", help="INSPIRE UI query URL (we extract q=... from it).")
    ap.add_argument("--query", default="", help="INSPIRE query string (alternative to --query-url).")
    ap.add_argument("--inspire-json", type=Path, default=None, help="Offline mode: path to an INSPIRE API JSON response fixture.")
    ap.add_argument("--arxiv-tar", type=Path, default=None, help="Offline mode: path to a local arXiv source tar/tar.gz fixture.")
    ap.add_argument("--sort", default="mostrecent", help="INSPIRE sort (default: mostrecent).")
    ap.add_argument("--page-size", type=int, default=50, help="INSPIRE page size (default: 50).")
    ap.add_argument("--max-records", type=int, default=10, help="Max INSPIRE records to process (default: 10).")
    ap.add_argument("--out-dir", type=Path, required=True, help="Output directory for the local corpus.")
    ap.add_argument(
        "--exts",
        default=".tex,.bib,.sty,.cls,.bst,.bbl,.txt",
        help="Comma-separated extensions to extract from arXiv sources (default: .tex,.bib,.sty,.cls,.bst,.bbl,.txt).",
    )
    ap.add_argument("--keep-tarballs", action="store_true", help="Also keep downloaded tarballs under out-dir/tarballs/.")
    ap.add_argument("--resume", action="store_true", help="Skip arXiv download/extract when filtered source files already exist.")
    ap.add_argument("--dry-run", action="store_true", help="Only list records and write metadata; do not download/extract.")
    args = ap.parse_args()

    query = ""
    extra_params: dict[str, str] = {}
    if args.inspire_json is None:
        try:
            query, extra_params = _parse_inspire_query(args.query_url.strip() or None, args.query.strip() or None)
        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 2
    else:
        query = args.query.strip() or "fixture"

    out_dir = args.out_dir.expanduser().resolve()
    _ensure_dir(out_dir)
    trace_path = out_dir / "trace.jsonl"
    meta_path = out_dir / "meta.json"

    exts = {("." + e.strip().lstrip(".")).lower() for e in str(args.exts).split(",") if e.strip()}
    _write_json(
        meta_path,
        {
            "created_at": _utc_now(),
            "query": query,
            "extra_params": extra_params,
            "sort": args.sort,
            "page_size": args.page_size,
            "max_records": args.max_records,
            "extract_exts": sorted(exts),
            "inspire_json": str(args.inspire_json) if args.inspire_json is not None else "",
            "arxiv_tar": str(args.arxiv_tar) if args.arxiv_tar is not None else "",
        },
    )

    if args.inspire_json is not None:
        if not args.inspire_json.is_file():
            print(f"ERROR: --inspire-json not found: {args.inspire_json}", file=sys.stderr)
            return 2
        obj = json.loads(args.inspire_json.read_text(encoding="utf-8", errors="replace"))
        records = _records_from_inspire_obj(obj, max_records=max(0, args.max_records), trace_path=trace_path)
    else:
        records = _iter_inspire_records(
            query,
            size=args.page_size,
            max_records=max(0, args.max_records),
            sort=args.sort,
            extra_params=extra_params,
            trace_path=trace_path,
        )
    print(f"[ok] inspire records: {len(records)}")
    # Persist the INSPIRE order so downstream pack generation can respect `sort=mostrecent`
    # even when arXiv IDs mix old-style `hep-ph/YYMMNNN` and new-style `YYMM.NNNNN`.
    try:
        order_path = out_dir / "records_order.json"
        order_obj = {
            "created_at": _utc_now(),
            "query": query,
            "extra_params": extra_params,
            "sort": args.sort,
            "order": [
                {
                    "rank": i,
                    "safe_id": _safe_id(r.arxiv_id),
                    "arxiv_id": r.arxiv_id,
                    "year": r.year,
                    "recid": r.recid,
                    "title": r.title,
                }
                for i, r in enumerate(records, start=1)
            ],
        }
        _write_json(order_path, order_obj)
    except Exception as exc:
        _append_jsonl(trace_path, {"ts": _utc_now(), "event": "order_write_error", "error": str(exc)})

    papers_dir = out_dir / "papers"
    tar_dir = out_dir / "tarballs"
    if args.keep_tarballs:
        _ensure_dir(tar_dir)

    tar_fixture = None
    if args.arxiv_tar is not None:
        if not args.arxiv_tar.is_file():
            print(f"ERROR: --arxiv-tar not found: {args.arxiv_tar}", file=sys.stderr)
            return 2
        tar_fixture = args.arxiv_tar.read_bytes()

    max_tar_bytes = 100 * 1024 * 1024  # 100 MB safety cap (style corpus should be small)

    for i, rec in enumerate(records, start=1):
        safe = _safe_id(rec.arxiv_id)
        rec_dir = papers_dir / safe
        _ensure_dir(rec_dir)
        _write_json(
            rec_dir / "record.json",
            {
                "fetched_at": _utc_now(),
                "inspire_order": i,
                "recid": rec.recid,
                "title": rec.title,
                "year": rec.year,
                "authors": rec.authors,
                "doi": rec.doi,
                "arxiv_id": rec.arxiv_id,
                "inspire_api": f"https://inspirehep.net/api/literature/{rec.recid}",
                "arxiv_abs": f"https://arxiv.org/abs/{rec.arxiv_id}",
            },
        )

        print(f"[{i}/{len(records)}] {rec.arxiv_id} {rec.year} {rec.title[:80]}")
        if args.dry_run:
            continue

        if args.resume and _has_extracted_files(rec_dir, exts=exts):
            _append_jsonl(
                trace_path,
                {"ts": _utc_now(), "event": "resume_skip_existing", "arxiv_id": rec.arxiv_id, "recid": rec.recid},
            )
            continue

        try:
            if tar_fixture is not None:
                tar_bytes = tar_fixture
                _append_jsonl(trace_path, {"ts": _utc_now(), "event": "arxiv_download_fixture", "arxiv_id": rec.arxiv_id, "bytes": len(tar_bytes)})
            else:
                tar_bytes = _download_arxiv_source(rec.arxiv_id)
                _append_jsonl(trace_path, {"ts": _utc_now(), "event": "arxiv_download_ok", "arxiv_id": rec.arxiv_id, "bytes": len(tar_bytes)})
        except HTTPError as exc:
            _append_jsonl(
                trace_path,
                {"ts": _utc_now(), "event": "arxiv_download_http_error", "arxiv_id": rec.arxiv_id, "status": exc.code, "error": str(exc)},
            )
            continue
        except Exception as exc:
            _append_jsonl(trace_path, {"ts": _utc_now(), "event": "arxiv_download_error", "arxiv_id": rec.arxiv_id, "error": str(exc)})
            continue

        if len(tar_bytes) > max_tar_bytes:
            _append_jsonl(trace_path, {"ts": _utc_now(), "event": "tarball_too_large", "arxiv_id": rec.arxiv_id, "bytes": len(tar_bytes)})
            continue

        if args.keep_tarballs:
            (tar_dir / f"{safe}.tar").write_bytes(tar_bytes)

        extracted, stats = _extract_filtered_tar(
            tar_bytes, out_dir=rec_dir, exts=exts, trace_path=trace_path, arxiv_id=rec.arxiv_id
        )
        _append_jsonl(
            trace_path,
            {"ts": _utc_now(), "event": "arxiv_extract_done", "arxiv_id": rec.arxiv_id, **stats},
        )
        if extracted > 0:
            _write_json(
                rec_dir / "extracted.ok.json",
                {
                    "created_at": _utc_now(),
                    "arxiv_id": rec.arxiv_id,
                    "extract_exts": sorted(exts),
                    **stats,
                },
            )

    print(f"[ok] wrote corpus: {out_dir}")
    print(f"[ok] trace: {trace_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
