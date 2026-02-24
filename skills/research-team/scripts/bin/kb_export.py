#!/usr/bin/env python3
"""
Deterministic (L1) Knowledge Base exporter.

This script builds a stable JSON index over the project's knowledge base layers:
  - knowledge_base/literature         -> layer="Library"
  - knowledge_base/methodology_traces -> layer="Methodology"
  - knowledge_base/priors             -> layer="Priors"

Design goals:
  - Offline / deterministic: no network, no LLM calls, stable output ordering.
  - Minimal-but-useful metadata for retrieval and change detection:
      layer, refkey, title, links, evidence_paths, mtime_ns, sha256.

Usage:
  python3 kb_export.py kb-index --project-root /path/to/project [--out /path/to/kb_index.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path


LAYER_DIRS: dict[str, str] = {
    "Library": "literature",
    "Methodology": "methodology_traces",
    "Priors": "priors",
}

DEFAULT_OUT_NAME = "kb_index.json"


@dataclass(frozen=True)
class _ParsedMeta:
    refkey: str
    title: str
    inspire_recid: str
    arxiv_id: str
    doi: str
    urls: list[str]
    evidence_paths: list[str]


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_head_bytes(path: Path, *, limit: int = 256 * 1024) -> bytes:
    with path.open("rb") as f:
        return f.read(max(0, int(limit)))


def _looks_binary(head: bytes) -> bool:
    # A conservative heuristic: if NUL appears in the first chunk, treat as binary.
    return b"\x00" in head


def _strip_title_prefix(title: str) -> str:
    # Normalize common template prefixes.
    title = re.sub(r"^\s*(KB\s+note|Methodology\s+trace)\s*:\s*", "", title, flags=re.IGNORECASE).strip()
    return title


def _first_markdown_h1(text: str) -> str:
    for ln in text.splitlines()[:80]:
        m = re.match(r"^\s*#\s+(.+?)\s*$", ln)
        if m:
            return _strip_title_prefix(m.group(1).strip())
    return ""


def _first_title_field(text: str) -> str:
    m = re.search(r"^\s*Title\s*:\s*(.+?)\s*$", text, flags=re.MULTILINE | re.IGNORECASE)
    return m.group(1).strip() if m else ""


def _first_tex_title(text: str) -> str:
    # Naive TeX title extraction (good enough for snapshots).
    m = re.search(r"\\title\s*\{\s*([^}]+?)\s*\}", text)
    return m.group(1).strip() if m else ""


def _extract_field(text: str, field: str) -> str:
    m = re.search(rf"^\s*{re.escape(field)}\s*:\s*(.+?)\s*$", text, flags=re.MULTILINE | re.IGNORECASE)
    return m.group(1).strip() if m else ""


def _extract_inspire_recid(text: str) -> str:
    m = re.search(r"^\s*INSPIRE\s+recid\s*:\s*(\d+)\s*$", text, flags=re.MULTILINE | re.IGNORECASE)
    return m.group(1).strip() if m else ""


def _extract_arxiv_id(text: str) -> str:
    raw = _extract_field(text, "arXiv")
    raw = raw.strip()
    if not raw:
        return ""
    # If it's already a URL, parse it; else keep as is.
    m = re.search(r"arxiv\.org/(abs|pdf)/(?P<id>[^?#\s]+)", raw, flags=re.IGNORECASE)
    if m:
        raw = m.group("id")
    raw = raw.strip()
    # Strip version suffix (v2) for stable identification.
    raw = re.sub(r"v\d+\s*$", "", raw)
    return raw


def _extract_doi(text: str) -> str:
    raw = _extract_field(text, "DOI")
    raw = raw.strip()
    if not raw:
        return ""
    m = re.search(r"doi\.org/(?P<doi>10\.\d{4,9}/[^?#\s]+)", raw, flags=re.IGNORECASE)
    if m:
        raw = m.group("doi")
    return raw.strip()


def _extract_arxiv_id_from_urls(urls: list[str]) -> str:
    for u in urls:
        m = re.search(r"arxiv\.org/(?:abs|pdf)/(?P<id>[^?#\s]+)", u, flags=re.IGNORECASE)
        if not m:
            continue
        arxiv_id = m.group("id").strip()
        arxiv_id = re.sub(r"\.pdf\s*$", "", arxiv_id, flags=re.IGNORECASE)
        arxiv_id = re.sub(r"v\d+\s*$", "", arxiv_id)
        if arxiv_id:
            return arxiv_id
    return ""


def _extract_doi_from_urls(urls: list[str]) -> str:
    for u in urls:
        m = re.search(r"doi\.org/(?P<doi>10\.\d{4,9}/[^?#\s]+)", u, flags=re.IGNORECASE)
        if m:
            doi = m.group("doi").strip()
            if doi:
                return doi
    return ""


def _extract_inspire_recid_from_urls(urls: list[str]) -> str:
    for u in urls:
        m = re.search(r"inspirehep\.net/literature/(?P<recid>\d+)", u, flags=re.IGNORECASE)
        if m:
            recid = m.group("recid").strip()
            if recid:
                return recid
    return ""


def _clean_url(url: str) -> str:
    url = url.strip().strip("<>").strip()
    while url and url[-1] in ").,;:]}>":
        url = url[:-1]
    return url.strip()


def _extract_urls_from_links_section(text: str) -> list[str]:
    lines = text.splitlines()
    start = -1
    for i, ln in enumerate(lines[:400]):
        if re.match(r"^\s*Links\s*:\s*$", ln, flags=re.IGNORECASE):
            start = i + 1
            break
    if start < 0:
        return []

    urls: list[str] = []
    started = False
    for ln in lines[start : start + 200]:
        if re.match(r"^\s*#{1,6}\s+", ln):
            break
        if not ln.strip():
            # Allow blank lines right after "Links:" and inside the list.
            continue
        m = re.match(r"^\s*-\s+(.+?)\s*$", ln)
        if not m:
            # Stop once we leave the list region (after at least one item).
            if started:
                break
            continue
        started = True
        body = m.group(1).strip()
        # Common "Label: value" format.
        m2 = re.match(r"^[A-Za-z][A-Za-z0-9 _-]*\s*:\s*(\S+)\s*$", body)
        if m2:
            cand = _clean_url(m2.group(1))
            if cand.startswith(("http://", "https://")):
                urls.append(cand)
                continue
        # Otherwise try to extract the first URL-like token.
        m3 = re.search(r"https?://\S+", body)
        if m3:
            urls.append(_clean_url(m3.group(0)))
    return urls


def _classify_links(*, inspire_recid: str, arxiv_id: str, doi: str, urls: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"inspire": [], "arxiv": [], "doi": [], "other": []}

    # Add derived canonical links from identifiers first (stable).
    if inspire_recid:
        out["inspire"].append(f"https://inspirehep.net/literature/{inspire_recid}")
    if arxiv_id:
        out["arxiv"].append(f"https://arxiv.org/abs/{arxiv_id}")
    if doi:
        out["doi"].append(f"https://doi.org/{doi}")

    for u in urls:
        u = _clean_url(u)
        if not u or not u.startswith(("http://", "https://")):
            continue
        ul = u.lower()
        if "inspirehep.net/" in ul:
            out["inspire"].append(u)
        elif "arxiv.org/" in ul:
            out["arxiv"].append(u)
        elif "doi.org/" in ul:
            out["doi"].append(u)
        else:
            out["other"].append(u)

    # De-dup while preserving stable order.
    for k, arr in out.items():
        seen: set[str] = set()
        dedup: list[str] = []
        for x in arr:
            if x in seen:
                continue
            seen.add(x)
            dedup.append(x)
        out[k] = dedup

    return out


def _extract_local_evidence_paths(text: str, *, project_root: Path) -> list[str]:
    """
    Extract project-relative evidence pointers to local references/snapshots.

    Heuristic: scan for tokens that look like `references/...` or `refs/...`,
    then keep only those that resolve to existing paths under project_root.
    """
    out: set[str] = set()
    # Markdown links / plain text pointers.
    for m in re.finditer(r"(?P<path>(?:references|refs)/[A-Za-z0-9_.@/+\\-]+)", text):
        raw = m.group("path")
        cand = raw.strip()
        while cand and cand[-1] in ").,;:]}>":
            cand = cand[:-1]
        cand = cand.strip()
        if cand.startswith("./"):
            cand = cand[2:]
        if not cand or not (cand.startswith("references/") or cand.startswith("refs/")):
            continue
        try:
            resolved = (project_root / cand).resolve()
        except Exception:
            continue
        if resolved == project_root or project_root not in resolved.parents:
            continue
        if resolved.exists():
            out.add(cand)
    return sorted(out)


def _arxiv_src_dir_from_id(arxiv_id: str) -> str:
    # Match `literature_fetch.py` normalization: replace "/" with "_" for old-style ids.
    return arxiv_id.replace("/", "_")


def _parse_meta(path: Path, *, project_root: Path) -> _ParsedMeta:
    head = _read_head_bytes(path)
    if _looks_binary(head):
        stem = path.stem
        return _ParsedMeta(
            refkey=stem,
            title=stem,
            inspire_recid="",
            arxiv_id="",
            doi="",
            urls=[],
            evidence_paths=[],
        )

    text = head.decode("utf-8", errors="replace")

    refkey = _extract_field(text, "RefKey") or path.stem

    title = _first_markdown_h1(text) or _first_title_field(text) or _first_tex_title(text) or path.stem
    title = title.strip() or path.stem

    inspire_recid = _extract_inspire_recid(text)
    arxiv_id = _extract_arxiv_id(text)
    doi = _extract_doi(text)

    urls = _extract_urls_from_links_section(text)
    if not inspire_recid:
        inspire_recid = _extract_inspire_recid_from_urls(urls)
    if not arxiv_id:
        arxiv_id = _extract_arxiv_id_from_urls(urls)
    if not doi:
        doi = _extract_doi_from_urls(urls)

    evidence_paths = _extract_local_evidence_paths(text, project_root=project_root)
    if arxiv_id:
        cand = f"references/arxiv_src/{_arxiv_src_dir_from_id(arxiv_id)}"
        if (project_root / cand).is_dir():
            evidence_paths.append(cand)
    evidence_paths = sorted(set(evidence_paths))

    return _ParsedMeta(
        refkey=refkey,
        title=title,
        inspire_recid=inspire_recid,
        arxiv_id=arxiv_id,
        doi=doi,
        urls=urls,
        evidence_paths=evidence_paths,
    )


def _build_kb_index(*, project_root: Path, out_path: Path) -> dict[str, object]:
    kb_root = project_root / "knowledge_base"
    if not kb_root.is_dir():
        raise ValueError(f"missing knowledge_base/: {kb_root}")

    out_path_resolved = out_path.resolve()

    entries: list[dict[str, object]] = []
    for layer, subdir in sorted(LAYER_DIRS.items(), key=lambda kv: kv[0]):
        layer_root = kb_root / subdir
        if not layer_root.is_dir():
            continue
        for p in sorted(layer_root.rglob("*")):
            if not p.is_file():
                continue
            if p.name.startswith("."):
                continue
            try:
                if p.resolve() == out_path_resolved:
                    continue
            except Exception:
                # If resolve fails, just keep going; worst case we index it.
                pass

            st = p.stat()
            rel = p.relative_to(project_root).as_posix()
            meta = _parse_meta(p, project_root=project_root)
            links = _classify_links(
                inspire_recid=meta.inspire_recid, arxiv_id=meta.arxiv_id, doi=meta.doi, urls=meta.urls
            )
            evidence_paths = [rel] + [x for x in meta.evidence_paths if x != rel]
            evidence_paths = sorted(dict.fromkeys(evidence_paths))

            entry: dict[str, object] = {
                "layer": layer,
                "refkey": meta.refkey,
                "title": meta.title,
                "path": rel,
                "links": links,
                "evidence_paths": evidence_paths,
                "mtime_ns": int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))),
                "sha256": _sha256_file(p),
            }
            entries.append(entry)

    # Stable ordering (layer -> refkey -> path).
    entries.sort(key=lambda e: (str(e.get("layer", "")), str(e.get("refkey", "")), str(e.get("path", ""))))

    return {
        "version": 1,
        "kb_root": "knowledge_base",
        "entries": entries,
    }


def _write_json(path: Path, obj: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


def _cmd_kb_index(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).expanduser().resolve()
    out_path = Path(args.out).expanduser() if args.out else (project_root / "knowledge_base" / DEFAULT_OUT_NAME)
    try:
        index = _build_kb_index(project_root=project_root, out_path=out_path)
    except Exception as exc:
        print(f"ERROR: failed to build KB index: {exc}", file=sys.stderr)
        return 2

    try:
        _write_json(out_path, index)
    except Exception as exc:
        print(f"ERROR: failed to write JSON: {out_path}: {exc}", file=sys.stderr)
        return 2

    print(f"[ok] wrote {out_path}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("kb-index", help="Export knowledge_base (3 layers) to a stable JSON index.")
    p.add_argument("--project-root", required=True, help="Path to a project containing knowledge_base/.")
    p.add_argument(
        "--out",
        default="",
        help=f"Output JSON path (default: <project-root>/knowledge_base/{DEFAULT_OUT_NAME}).",
    )
    p.set_defaults(func=_cmd_kb_index)

    args = ap.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
