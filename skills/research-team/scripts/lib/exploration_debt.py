from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


OPEN_RE = re.compile(r"^\s*-\s*\[\s*\]\s+")
CLOSED_RE = re.compile(r"^\s*-\s*\[\s*[xX]\s*\]\s+")

TAG_LINE_RE = re.compile(r"^\s*-\s*Tag\s*:\s*(?P<tag>.+?)\s*$")
NOTES_LINE_RE = re.compile(r"^\s*-\s*Notes\s*:\s*(?P<notes>.+?)\s*$")

ITEM_RE = re.compile(
    r"^\s*-\s*\[\s*\]\s+"
    r"(?P<utc>\S+)\s+gate=(?P<gate>[^ ]+)\s+exit_code=(?P<exit_code>\d+)\s+::\s+"
    r"(?P<summary>.*)\s*$"
)


@dataclass(frozen=True)
class OpenDebtItem:
    path: Path
    line: int
    text: str
    tag: str | None
    notes: str | None
    gate: str | None
    exit_code: int | None
    utc: str | None
    summary: str | None


def _extract_header_kv(text: str) -> tuple[str | None, str | None]:
    tag: str | None = None
    notes: str | None = None
    for ln in text.splitlines()[:80]:
        if tag is None:
            m = TAG_LINE_RE.match(ln)
            if m:
                tag = m.group("tag").strip()
                continue
        if notes is None:
            m = NOTES_LINE_RE.match(ln)
            if m:
                notes = m.group("notes").strip()
                continue
        if tag is not None and notes is not None:
            break
    return tag, notes


def iter_debt_files(team_dir: Path) -> list[Path]:
    runs_dir = team_dir / "runs"
    if not runs_dir.is_dir():
        return []
    return sorted([p for p in runs_dir.rglob("*_exploration_debt.md") if p.is_file()])


def scan_open_items(path: Path) -> list[OpenDebtItem]:
    text = path.read_text(encoding="utf-8", errors="replace")
    header_tag, header_notes = _extract_header_kv(text)

    inferred_tag: str | None = None
    try:
        inferred_tag = path.parent.name.strip() or None
    except Exception:
        inferred_tag = None

    tag = header_tag or inferred_tag
    out: list[OpenDebtItem] = []
    for i, ln in enumerate(text.splitlines(), start=1):
        if CLOSED_RE.match(ln):
            continue
        if not OPEN_RE.match(ln):
            continue

        gate = None
        exit_code = None
        utc = None
        summary = None

        m = ITEM_RE.match(ln)
        if m:
            utc = m.group("utc").strip() or None
            gate = m.group("gate").strip() or None
            try:
                exit_code = int(m.group("exit_code"))
            except Exception:
                exit_code = None
            summary = m.group("summary").strip() or None

        out.append(
            OpenDebtItem(
                path=path,
                line=i,
                text=ln.strip(),
                tag=tag,
                notes=header_notes,
                gate=gate,
                exit_code=exit_code,
                utc=utc,
                summary=summary,
            )
        )
    return out


def scan_open_debt(team_dir: Path) -> list[OpenDebtItem]:
    items: list[OpenDebtItem] = []
    for p in iter_debt_files(team_dir):
        items.extend(scan_open_items(p))
    return items

