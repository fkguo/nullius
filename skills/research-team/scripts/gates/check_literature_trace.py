#!/usr/bin/env python3
"""
Literature discovery trace gate (domain-neutral).

Purpose:
- Ensure that when a project uses `references_gate` / `knowledge_layers_gate`, there is at least
  a minimal, auditable log of discovery queries and selection decisions.
- This is intentionally lightweight: it only checks that the append-only log exists and has
  at least one non-empty row beyond the template header.

Default trace path (relative to project root):
  knowledge_base/methodology_traces/literature_queries.md

Config:
- features.literature_trace_gate: enable/disable this gate (default: False).
- Optional override:
    references.trace_log_path: "knowledge_base/methodology_traces/literature_queries.md"

Exit codes:
  0  ok, or gate disabled
  1  missing/empty trace log
  2  input/config error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


DEFAULT_TRACE = "knowledge_base/methodology_traces/literature_queries.md"
_ISO_TS = re.compile(r"^(19|20)\d{2}-\d{2}-\d{2}T")


@dataclass(frozen=True)
class Row:
    path: Path
    line: int
    text: str


def _trace_path_from_config(cfg: object) -> str:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return DEFAULT_TRACE
    refs = data.get("references", {})
    if isinstance(refs, dict):
        p = str(refs.get("trace_log_path") or "").strip()
        if p:
            return p
    return DEFAULT_TRACE


def _count_nonempty_rows(text: str, *, path: Path) -> tuple[int, list[Row]]:
    """
    Count non-empty Markdown table rows in the standard literature_queries.md table.
    A row is considered non-empty if it has a plausible ISO-like UTC timestamp in column 1.
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()
    rows: list[Row] = []
    for i, ln in enumerate(lines, start=1):
        s = ln.strip()
        if not s.startswith("|"):
            continue
        # Skip header separators like |---|---|...
        if re.match(r"^\|\s*-{3,}\s*\|", s):
            continue
        # Split cells.
        parts = [p.strip() for p in s.strip("|").split("|")]
        if len(parts) < 2:
            continue
        ts = parts[0]
        # Template empty row: all cells empty.
        if all(not c for c in parts):
            continue
        # Count as non-empty only if timestamp looks filled (keeps the template placeholder row from counting).
        if _ISO_TS.match(ts):
            rows.append(Row(path=path, line=i, text=ln))
    return len(rows), rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("literature_trace_gate", default=False):
        print("[skip] literature trace gate disabled by research_team_config")
        return 0

    # Resolve project root similarly to other gates.
    note_dir = args.notes.parent.resolve()
    project_root = note_dir
    if getattr(cfg, "path", None):
        try:
            project_root = cfg.path.parent.resolve()  # type: ignore[union-attr]
        except Exception:
            project_root = note_dir

    rel = _trace_path_from_config(cfg).replace("\\\\", "/").lstrip("./")
    trace_path = Path(rel)
    if not trace_path.is_absolute():
        trace_path = project_root / trace_path

    if not trace_path.is_file():
        print("[fail] literature trace gate failed")
        print(f"[error] Missing literature query trace log: {trace_path}")
        print("[hint] Create it (scaffold creates it automatically), or append a row via:")
        print(
            "  python3 ~/.codex/skills/research-team/scripts/bin/literature_fetch.py trace-add "
            '--source \"Manual\" --query \"...\" --decision \"...\"'
        )
        return 1

    try:
        txt = trace_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"[error] Failed to read trace log: {trace_path} ({exc})")
        return 2

    n, rows = _count_nonempty_rows(txt, path=trace_path)
    if n <= 0:
        print("[fail] literature trace gate failed")
        print(f"[error] Trace log has no non-empty rows beyond the template header: {trace_path}")
        print("[hint] Append at least one row documenting query -> shortlist -> decision.")
        return 1

    print("[ok] literature trace gate passed")
    print(f"- trace: {trace_path}")
    print(f"- non-empty rows: {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
