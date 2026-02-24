#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "hep-autoresearch/0"})
    with urllib.request.urlopen(req) as r:
        return r.read().decode("utf-8", errors="replace")


def _text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    return " ".join(el.text.split())


def _parse_atom(xml_text: str) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_text)
    entries: list[dict[str, Any]] = []
    for entry in root.findall("atom:entry", NS):
        entry_id = _text(entry.find("atom:id", NS))
        title = _text(entry.find("atom:title", NS))
        summary = _text(entry.find("atom:summary", NS))
        published = _text(entry.find("atom:published", NS))
        updated = _text(entry.find("atom:updated", NS))
        authors = [
            _text(a.find("atom:name", NS))
            for a in entry.findall("atom:author", NS)
        ]
        authors = [a for a in authors if a]
        links = [l.attrib.get("href") for l in entry.findall("atom:link", NS)]
        links = [l for l in links if l]

        primary_category = entry.find("arxiv:primary_category", NS)
        primary_cat = primary_category.attrib.get("term") if primary_category is not None else None
        categories = [c.attrib.get("term") for c in entry.findall("atom:category", NS)]
        categories = [c for c in categories if c]

        # arXiv ID: often last path segment of entry_id URL
        arxiv_id = None
        if entry_id and "/abs/" in entry_id:
            arxiv_id = entry_id.split("/abs/", 1)[1]

        entries.append(
            {
                "arxiv_id": arxiv_id,
                "entry_id": entry_id,
                "title": title,
                "authors": authors,
                "published": published,
                "updated": updated,
                "summary": summary,
                "primary_category": primary_cat,
                "categories": categories,
                "links": links,
            }
        )
    return entries


def main() -> None:
    ap = argparse.ArgumentParser(description="Fetch arXiv metadata via Atom API (export.arxiv.org).")
    ap.add_argument(
        "--ids",
        required=True,
        help="Comma-separated arXiv IDs, e.g. 2210.03629,2302.04761",
    )
    ap.add_argument(
        "--out",
        default="references/arxiv/arxiv_metadata.json",
        help="Output JSON path (relative to project root by default).",
    )
    args = ap.parse_args()

    ids = [x.strip() for x in args.ids.split(",") if x.strip()]
    if not ids:
        raise SystemExit("No arXiv IDs provided.")

    # arXiv API supports id_list with comma-separated IDs
    query = {"id_list": ",".join(ids)}
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(query)

    xml_text = _fetch(url)
    entries = _parse_atom(xml_text)

    payload = {
        "generated_at": _utc_now_iso(),
        "source_url": url,
        "requested_ids": ids,
        "found": len(entries),
        "entries": entries,
    }

    project_root = Path(__file__).resolve().parent.parent
    out_path = (project_root / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"Wrote: {out_path}")


if __name__ == "__main__":
    main()
