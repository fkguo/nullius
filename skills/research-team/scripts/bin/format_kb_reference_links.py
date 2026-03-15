#!/usr/bin/env python3
"""
Format/upgrade the "I) Knowledge base references" lists in research_contract.md.

Goal (human factors):
- Keep the knowledge-layers gate deterministic (it only needs paths to exist),
  but make the capsule easy to scan by turning opaque path bullets into
  human-readable Markdown links, e.g.:
    - [recid-1234567 — FirstAuthor et al. — Paper Title](knowledge_base/literature/recid-1234567.md)

Safety:
- Only edits inside the Reproducibility Capsule.
- Only rewrites bullet items under:
    Literature:, Methodology traces:, Priors:
- Leaves already-descriptive link texts untouched.

Usage:
  python3 scripts/bin/format_kb_reference_links.py --notes research_contract.md --in-place
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


CAPSULE_START = "<!-- REPRO_CAPSULE_START -->"
CAPSULE_END = "<!-- REPRO_CAPSULE_END -->"


@dataclass(frozen=True)
class LinkItem:
    indent: str
    raw: str
    text: str
    target: str


def _extract_capsule(text: str) -> tuple[int, int, str] | None:
    if CAPSULE_START not in text or CAPSULE_END not in text:
        return None
    a = text.index(CAPSULE_START) + len(CAPSULE_START)
    b = text.index(CAPSULE_END)
    return a, b, text[a:b]


def _extract_section(capsule: str) -> tuple[int, int, str] | None:
    m = re.search(r"^###\s+I\)\s+Knowledge\s+base\s+references.*?$", capsule, flags=re.MULTILINE)
    if not m:
        return None
    start = m.end()
    m2 = re.search(r"^###\s+", capsule[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(capsule[start:]))
    return start, end, capsule[start:end]


def _parse_bullet_item(line: str) -> LinkItem | None:
    m = re.match(r"^(?P<indent>\s*)-\s+(?P<body>.+?)\s*$", line)
    if not m:
        return None
    indent = m.group("indent")
    body = m.group("body").strip()

    if body.lower() in ("none", "n/a", "na", "null"):
        return None

    # Markdown link:
    m_link = re.match(r"^\[(?P<text>[^\]]+)\]\((?P<target>[^)]+)\)\s*$", body)
    if m_link:
        return LinkItem(indent=indent, raw=body, text=m_link.group("text").strip(), target=m_link.group("target").strip())

    # Plain path bullet.
    if any(ch.isspace() for ch in body):
        return None
    return LinkItem(indent=indent, raw=body, text=body, target=body)


def _split_list_blocks(section: str) -> dict[str, tuple[int, int, list[str]]]:
    """
    Return a mapping:
      label -> (start_idx, end_idx, lines)
    where indices are line indices within section.splitlines(keepends=False).
    """
    labels = ["Literature:", "Methodology traces:", "Priors:"]
    lines = section.splitlines()

    # Find label line indices.
    idx: dict[str, int] = {}
    for i, ln in enumerate(lines):
        for lab in labels:
            if re.match(rf"^\s*{re.escape(lab)}\s*$", ln.strip()):
                idx[lab] = i
    out: dict[str, tuple[int, int, list[str]]] = {}
    for lab in labels:
        if lab not in idx:
            continue
        start = idx[lab] + 1
        end = len(lines)
        for other in labels:
            if other == lab:
                continue
            j = idx.get(other)
            if j is not None and j > idx[lab]:
                end = min(end, j)
        out[lab] = (start, end, lines[start:end])
    return out


def _read_meta(path: Path) -> dict[str, str]:
    meta: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return meta

    # Title: first H1.
    for ln in text.splitlines()[:80]:
        m_h1 = re.match(r"^#\s+(.+?)\s*$", ln.strip())
        if m_h1:
            title = m_h1.group(1).strip()
            title = re.sub(r"^KB note:\s*", "", title, flags=re.IGNORECASE).strip()
            meta["title"] = title
            break

    head = "\n".join(text.splitlines()[:200])
    for key, field in (("refkey", "RefKey"), ("authors", "Authors"), ("publication", "Publication")):
        m = re.search(rf"^\s*{re.escape(field)}\s*:\s*(.+?)\s*$", head, flags=re.MULTILINE)
        if m:
            meta[key] = m.group(1).strip()
    return meta


def _is_non_descriptive_link_text(text: str, target: str) -> bool:
    t = text.strip()
    targ = target.strip().split()[0].strip("<>")
    targ_no_frag = targ.split("#", 1)[0]
    name = Path(targ_no_frag).name
    stem = Path(targ_no_frag).stem
    return t in (targ, targ_no_frag, name, stem)


def _make_label(target_path_no_frag: str, meta: dict[str, str]) -> str:
    rel = target_path_no_frag
    if rel.startswith("./"):
        rel = rel[2:]
    title = meta.get("title") or Path(target_path_no_frag).stem

    if "/literature/" in rel:
        refkey = meta.get("refkey") or Path(target_path_no_frag).stem
        authors = meta.get("authors") or "Unknown authors"
        label = f"{refkey} — {authors} — {title}"
    else:
        # For priors/traces, keep it compact (no fake "Authors: unknown").
        label = title

    return re.sub(r"\s+", " ", label).strip()


def _rewrite_block(block_lines: list[str], *, notes_dir: Path) -> list[str]:
    out: list[str] = []
    for ln in block_lines:
        item = _parse_bullet_item(ln)
        if not item:
            out.append(ln)
            continue

        # Only label KB pointers (relative to notebook).
        target = item.target.strip()
        target_path = target.split()[0].strip("<>")
        target_path_no_frag = target_path.split("#", 1)[0]

        rel = target_path_no_frag
        if rel.startswith("./"):
            rel = rel[2:]

        if not rel.startswith("knowledge_base/"):
            out.append(ln)
            continue

        # Only rewrite if the text is non-descriptive (path-like).
        if item.raw != item.target and not _is_non_descriptive_link_text(item.text, item.target):
            out.append(ln)
            continue

        abs_path = (notes_dir / target_path_no_frag).resolve()
        meta = _read_meta(abs_path) if abs_path.is_file() else {}
        label = _make_label(target_path_no_frag, meta)
        out.append(f"{item.indent}- [{label}]({item.target})")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    ap.add_argument("--in-place", action="store_true", help="Rewrite the file in place (default: print to stdout).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    raw = args.notes.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    cap = _extract_capsule(raw)
    if cap is None:
        print("ERROR: missing Reproducibility Capsule markers", file=sys.stderr)
        return 2
    cap_a, cap_b, capsule = cap

    sec = _extract_section(capsule)
    if sec is None:
        print("ERROR: missing capsule section: '### I) Knowledge base references'", file=sys.stderr)
        return 2
    sec_a, sec_b, section = sec

    blocks = _split_list_blocks(section)
    if not blocks:
        print("ERROR: could not locate Literature:/Methodology traces:/Priors: blocks", file=sys.stderr)
        return 2

    section_lines = section.splitlines()
    notes_dir = args.notes.parent.resolve()

    # Apply rewrites per block (line-index based, stable).
    for label, (start, end, block_lines) in blocks.items():
        rewritten = _rewrite_block(block_lines, notes_dir=notes_dir)
        section_lines[start:end] = rewritten

    new_section = "\n".join(section_lines).rstrip()
    new_capsule = capsule[:sec_a] + "\n" + new_section + "\n" + capsule[sec_b:]
    new_text = raw[:cap_a] + new_capsule + raw[cap_b:]

    if args.in_place:
        args.notes.write_text(new_text, encoding="utf-8")
    else:
        sys.stdout.write(new_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
