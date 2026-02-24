#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fetch_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": "hep-autoresearch/0"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _extract_recid_from_url(url: str | None) -> str | None:
    if not url:
        return None
    m = re.search(r"/literature/(\d+)$", url)
    return m.group(1) if m else None


@dataclass(frozen=True)
class RefRow:
    label: str | None
    title: str | None
    year: int | None
    recid: str | None
    arxiv: str | None
    doi: str | None
    raw: str | None
    record_url: str | None


KEYWORD_RULES: list[tuple[str, list[str]]] = [
    ("agents", [" agent", " agents", "agentic", "multi-agent", "autonomous agent", "autonomous agents"]),
    ("llm", ["large language model", "llm", "gpt", "chatgpt", "language model"]),
    ("tool_use", ["tool", "tools", "toolformer", "function calling", "tool use"]),
    ("rag", ["retrieval", "rag", "retrieval-augmented", "vector", "embedding"]),
    ("workflow", ["workflow", "orchestr", "pipeline", "automation", "automate"]),
    ("eval_safety", ["evaluation", "benchmark", "safety", "alignment", "guardrail"]),
]


def _infer_tags(text: str) -> list[str]:
    t = " " + text.lower().strip() + " "
    tags: list[str] = []
    for tag, needles in KEYWORD_RULES:
        if any(n in t for n in needles):
            tags.append(tag)
    return tags


def _fmt(v: Any) -> str:
    if v is None:
        return ""
    return str(v)


def _write_markdown(out_path: Path, *, recid: str, refs: list[RefRow]) -> None:
    lines: list[str] = []
    lines.append(f"# INSPIRE references export — recid {recid}")
    lines.append("")
    lines.append(f"- Generated at (UTC): {_utc_now_iso()}")
    lines.append(f"- Source: `https://inspirehep.net/api/literature/{recid}`")
    lines.append("")
    lines.append("## All references (raw table)")
    lines.append("")
    lines.append("| # | year | recid | arXiv | DOI | title | tags |")
    lines.append("|---:|---:|---:|---|---|---|---|")
    for r in refs:
        tag_text = ", ".join(_infer_tags((r.title or "") + " " + (r.raw or "")))
        title = (r.title or "").replace("|", "\\|")
        lines.append(
            f"| {_fmt(r.label)} | {_fmt(r.year)} | {_fmt(r.recid)} | {_fmt(r.arxiv)} | {_fmt(r.doi)} | {title} | {tag_text} |"
        )
    lines.append("")

    shortlist = [r for r in refs if _infer_tags((r.title or "") + " " + (r.raw or ""))]
    lines.append("## Agent/LLM-related shortlist (heuristic)")
    lines.append("")
    lines.append(
        "Heuristic: keyword-based tags over `title` + `raw_refs` text. Expect false positives/negatives; this is a triage aid."
    )
    lines.append("")
    lines.append("| # | year | recid | arXiv | title | tags |")
    lines.append("|---:|---:|---:|---|---|---|")
    for r in shortlist:
        tag_text = ", ".join(_infer_tags((r.title or "") + " " + (r.raw or "")))
        title = (r.title or "").replace("|", "\\|")
        lines.append(f"| {_fmt(r.label)} | {_fmt(r.year)} | {_fmt(r.recid)} | {_fmt(r.arxiv)} | {title} | {tag_text} |")
    lines.append("")

    out_path.write_text("\n".join(lines).rstrip() + "\n", "utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Export INSPIRE references list for a literature recid.")
    ap.add_argument("--recid", required=True, help="INSPIRE literature recid, e.g. 3112995")
    ap.add_argument(
        "--out-dir",
        default="references/inspire",
        help="Output directory (relative to project root by default).",
    )
    args = ap.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    out_dir = (project_root / args.out_dir / f"recid-{args.recid}").resolve()
    _ensure_dir(out_dir)

    url = f"https://inspirehep.net/api/literature/{args.recid}"
    record = _fetch_json(url)

    refs: list[RefRow] = []
    for entry in record.get("metadata", {}).get("references", []) or []:
        record_url = (entry.get("record") or {}).get("$ref")
        ref = entry.get("reference") or {}
        pub = ref.get("publication_info") or {}

        title: str | None = None
        misc = ref.get("misc")
        if isinstance(misc, list) and misc:
            if isinstance(misc[0], str):
                title = misc[0]
        if not title:
            raw_refs = entry.get("raw_refs") or []
            if raw_refs and isinstance(raw_refs, list):
                val = raw_refs[0].get("value") if isinstance(raw_refs[0], dict) else None
                if isinstance(val, str):
                    title = None  # keep raw only; do not guess title from free text

        raw_text: str | None = None
        raw_refs = entry.get("raw_refs") or []
        if raw_refs and isinstance(raw_refs, list):
            val = raw_refs[0].get("value") if isinstance(raw_refs[0], dict) else None
            if isinstance(val, str):
                raw_text = val

        doi: str | None = None
        dois = ref.get("dois")
        if isinstance(dois, list) and dois:
            if isinstance(dois[0], str):
                doi = dois[0]

        refs.append(
            RefRow(
                label=ref.get("label"),
                title=title,
                year=int(pub["year"]) if isinstance(pub.get("year"), int) else None,
                recid=_extract_recid_from_url(record_url),
                arxiv=ref.get("arxiv_eprint"),
                doi=doi,
                raw=raw_text,
                record_url=record_url,
            )
        )

    payload: dict[str, Any] = {
        "generated_at": _utc_now_iso(),
        "source_url": url,
        "recid": args.recid,
        "reference_count": len(refs),
        "references": [r.__dict__ for r in refs],
    }

    (out_dir / "references.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", "utf-8")
    _write_markdown(out_dir / "references.md", recid=args.recid, refs=refs)
    print(f"Wrote: {out_dir / 'references.json'}")
    print(f"Wrote: {out_dir / 'references.md'}")


if __name__ == "__main__":
    main()
