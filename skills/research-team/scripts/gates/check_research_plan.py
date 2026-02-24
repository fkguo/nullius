#!/usr/bin/env python3
"""
Research plan gate.

Fails if RESEARCH_PLAN.md is missing or still contains template placeholders.
Exit codes:
  0 ok
  1 template / incomplete
  2 input error
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

try:
    from team_config import load_team_config  # type: ignore
except Exception as exc:  # pragma: no cover - import-time failure
    print(f"ERROR: failed to import team_config: {exc}", file=sys.stderr)
    raise SystemExit(2)


PLACEHOLDERS = (
    "<YOUR_NAME>",
    "<YYYY-MM-DD>",
    "RESEARCH_PLAN.md (Template)",
)

EMPTY_LINE_PATTERNS = (
    r"^\s*[-*+]\s*One-sentence objective:\s*$",
    r"^\s*[-*+]\s*Why it matters:\s*$",
    r"^\s*[-*+]\s*Primary deliverables \(paper / note / code / data\):\s*$",
    r"^\s*[-*+]\s*Claim C1:\s*$",
    r"^\s*[-*+]\s*Claim C2:\s*$",
)
MIN_PLAN_CHARS = 200


def _find_plan(notes_path: Path) -> Path | None:
    if notes_path.is_dir():
        cur = notes_path.resolve()
    else:
        cur = notes_path.parent.resolve()
    seen: set[Path] = set()
    for _ in range(50):
        cur_resolved = cur.resolve()
        if cur_resolved in seen:
            break
        seen.add(cur_resolved)
        cand = cur_resolved / "RESEARCH_PLAN.md"
        if cand.is_file():
            return cand
        if cur_resolved.parent == cur_resolved:
            break
        cur = cur_resolved.parent
    return None


def _strip_fenced_code(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    in_fence = False
    fence_marker = ""
    for ln in lines:
        stripped = ln.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = "```" if stripped.startswith("```") else "~~~"
            if not in_fence:
                in_fence = True
                fence_marker = marker
                continue
            if marker == fence_marker:
                in_fence = False
                fence_marker = ""
                continue
        if not in_fence:
            out.append(ln)
    return "\n".join(out)


def _extract_section(text: str, heading: str) -> str:
    text = _strip_fenced_code(text)
    heading_pat = re.escape(heading).replace(r"\ ", r"\s+")
    pat = re.compile(
        rf"^(?P<hashes>#+)\s*{heading_pat}(?:\s*\{{[^}}]*\}})?\s*$",
        re.MULTILINE | re.IGNORECASE,
    )
    m = pat.search(text)
    if not m:
        return ""
    start = m.end()
    level = len(m.group("hashes"))
    m2 = re.compile(rf"^#{{1,{level}}}\s+", re.MULTILINE).search(text, start)
    end = m2.start() if m2 else len(text)
    return text[start:end]


def _looks_like_template(text: str, raw_len: int | None = None) -> bool:
    text_lower = text.lower()
    if any(p.lower() in text_lower for p in PLACEHOLDERS):
        return True
    lines = text.splitlines()

    def _indent_width(line: str) -> int:
        width = 0
        for ch in line:
            if ch == " ":
                width += 1
            elif ch == "\t":
                width += 4
            else:
                break
        return width

    for i, ln in enumerate(lines):
        for pat in EMPTY_LINE_PATTERNS:
            if not re.search(pat, ln, flags=re.IGNORECASE):
                continue
            indent = _indent_width(ln)
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1
            if j >= len(lines):
                return True
            nxt = lines[j]
            if re.match(r"^\s*(?:[-*+]|[0-9]+\.)\s+", nxt):
                if _indent_width(nxt) <= indent:
                    return True
                break
            if re.match(r"^##+\s+", nxt):
                return True
            if not (nxt.startswith(" ") or nxt.startswith("\t")):
                return True
            break
    # If the file is extremely short, treat as unfilled.
    check_len = raw_len if raw_len is not None else len(text.strip())
    if check_len < MIN_PLAN_CHARS:
        if not re.search(r"^##+\s+(Task\s+Board|Progress\s+Log)\s*$", text, flags=re.MULTILINE | re.IGNORECASE):
            return True
    return False


def _as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lower = value.strip().lower()
        if lower in ("0", "false", "no", "n", "off", ""):
            return False
        if lower in ("1", "true", "yes", "y", "on"):
            return True
        return False
    return bool(value)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md.")
    ap.add_argument("--detect-only", action="store_true", help="Exit 0 if template detected, 1 if filled.")
    args = ap.parse_args()

    notes_path = args.notes
    if not notes_path.exists():
        print(f"ERROR: notes not found: {notes_path}")
        return 2

    cfg = None
    if not args.detect_only:
        try:
            cfg = load_team_config(notes_path)
            if not hasattr(cfg, "feature_enabled"):
                print("ERROR: research_team_config is invalid (missing feature_enabled)")
                return 2
        except Exception as exc:
            print(f"ERROR: failed to load research_team_config: {exc}")
            return 2
        if isinstance(cfg, dict):
            feats = cfg.get("features", {}) if isinstance(cfg.get("features", {}), dict) else {}
            if not _as_bool(feats.get("research_plan_gate", False)):
                print("[skip] research plan gate disabled by research_team_config")
                return 0
        elif cfg is not None:
            if not cfg.feature_enabled("research_plan_gate", default=False):
                print("[skip] research plan gate disabled by research_team_config")
                return 0
        else:
            print("ERROR: research_team_config is invalid (empty config)")
            return 2

    plan_path = _find_plan(notes_path)
    if plan_path is None or not plan_path.is_file():
        if args.detect_only:
            print("[detect] no research plan found")
            return 0
        print("[fail] research plan gate failed")
        print("[error] Missing RESEARCH_PLAN.md")
        return 1

    try:
        text = plan_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"[error] Failed to read RESEARCH_PLAN.md: {exc}")
        return 2
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    clean_text = _strip_fenced_code(text)
    is_template = _looks_like_template(clean_text, raw_len=len(text.strip()))

    if args.detect_only:
        return 0 if is_template else 1

    if is_template:
        print("[fail] research plan gate failed")
        print(f"[error] RESEARCH_PLAN.md appears to be a template: {plan_path}")
        print("[error] Fill it or run auto-fill before team cycles.")
        return 1

    if isinstance(cfg, dict):
        cfg_data = cfg
    else:
        cfg_data = getattr(cfg, "data", {}) if cfg is not None else {}
    if not isinstance(cfg_data, dict):
        cfg_data = {}
    plan_cfg = cfg_data.get("plan_tracking")
    if not isinstance(plan_cfg, dict):
        plan_cfg = {}

    if _as_bool(plan_cfg.get("require_task_board", False)):
        task_board = _extract_section(text, "Task Board")
        if not task_board:
            print("[fail] research plan gate failed")
            print("[error] Missing '## Task Board' section in RESEARCH_PLAN.md")
            return 1
        if not re.search(r"^\s*(?:[-*+]|[0-9]+\.)\s*\[\s*(?:[xX])?\s*\]", task_board, flags=re.MULTILINE):
            print("[fail] research plan gate failed")
            print("[error] Task Board has no checkbox items")
            return 1

    if _as_bool(plan_cfg.get("require_progress_log", False)):
        progress_log = _extract_section(text, "Progress Log")
        if not progress_log:
            print("[fail] research plan gate failed")
            print("[error] Missing '## Progress Log' section in RESEARCH_PLAN.md")
            return 1

    print("[ok] research plan gate passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
