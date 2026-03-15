#!/usr/bin/env python3
"""
Global Markdown link hygiene gate (domain-neutral).

Goal:
- Ensure cross-document pointers remain clickable in Markdown.

This gate checks (outside fenced code blocks):
- Disallow wrapping Markdown links in inline code spans (e.g. `[...] ( ... )`), which breaks clickability.
- Disallow wrapping Markdown file pointers (e.g. `knowledge_base/.../note.md`, `research_contract.md`) in inline code spans;
  require Markdown links instead (e.g. [note.md](note.md)).

Config:
- features.markdown_link_hygiene_gate: enable/disable this gate (default: True).
- markdown_link_hygiene.targets: list of paths/globs relative to project root (default targets are in team_config.py).
- markdown_link_hygiene.exclude_globs: optional exclusion globs relative to project root.

Default scan targets (per user policy):
- research_contract.md
- research_preflight.md
- research_plan.md
- project_charter.md
- knowledge_base/**/*.md

Exit codes:
  0  ok, or gate disabled
  1  hygiene violations detected
  2  input/config error
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import DEFAULT_CONFIG, load_team_config  # type: ignore
from md_utils import iter_inline_code_spans, iter_md_files_by_targets  # type: ignore


def _default_targets() -> list[str]:
    mlh = DEFAULT_CONFIG.get("markdown_link_hygiene", {})
    if isinstance(mlh, dict) and isinstance(mlh.get("targets"), list):
        return [str(x) for x in mlh.get("targets", []) if str(x).strip()]
    return [
        "research_contract.md",
        "research_preflight.md",
        "research_plan.md",
        "project_charter.md",
        "knowledge_base/**/*.md",
    ]

_MD_LINK_RE = re.compile(r"\[[^\]]+\]\([^)]+\)")


def _looks_like_md_path(token: str) -> bool:
    s = token.strip()
    if not s:
        return False
    if any(ch.isspace() for ch in s):
        return False
    # Avoid rewriting placeholders/globs/snippets.
    if any(ch in s for ch in ("*", "<", ">", "{", "}", "|")):
        return False
    # Avoid code-pointer conventions like path:Symbol.
    if ":" in s:
        return False

    base = s.split("#", 1)[0]
    if base.lower().endswith((".md", ".markdown")):
        return True
    # Some repos use directory pointers for KB layers; keep these clickable too.
    if base.startswith(("knowledge_base/", "./knowledge_base/")) and base.endswith("/"):
        return True
    return False


def _validate_link_hygiene(path: Path) -> list[str]:
    if not path.is_file() or path.suffix.lower() not in (".md", ".markdown"):
        return []

    try:
        text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except Exception as exc:
        return [f"Failed to read: {path} ({exc})"]

    errors: list[str] = []
    in_fence = False
    fence_ch = ""
    fence_len = 0
    for lineno, raw_ln in enumerate(text.splitlines(), start=1):
        ln = raw_ln
        stripped = ln.lstrip()
        if stripped.startswith(("```", "~~~")):
            ch = stripped[0]
            run_len = 0
            while run_len < len(stripped) and stripped[run_len] == ch:
                run_len += 1
            if not in_fence:
                in_fence = True
                fence_ch = ch
                fence_len = run_len
                continue
            if ch == fence_ch and run_len >= fence_len:
                in_fence = False
                fence_ch = ""
                fence_len = 0
                continue
        if in_fence:
            continue

        for _, __, content, _ in iter_inline_code_spans(ln):
            if _MD_LINK_RE.search(content):
                errors.append(f"{path}:{lineno}: Markdown link wrapped in inline code; remove backticks so it is clickable")
                continue
            if "[@recid-" in content or "#ref-" in content or content.strip().startswith("[@"):
                errors.append(f"{path}:{lineno}: citation/link anchor wrapped in inline code; remove backticks so it is clickable")
                continue
            if _looks_like_md_path(content):
                errors.append(f"{path}:{lineno}: Markdown file/path pointer wrapped in inline code; use a Markdown link")

    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("markdown_link_hygiene_gate", default=True):
        print("[skip] markdown link hygiene gate disabled by research_team_config")
        return 0

    root = (cfg.path.parent if cfg.path is not None else args.notes.parent).resolve()
    mlh = cfg.data.get("markdown_link_hygiene", {}) if isinstance(cfg.data.get("markdown_link_hygiene", {}), dict) else {}
    targets_raw = mlh.get("targets", _default_targets())
    targets = [str(x) for x in (targets_raw if isinstance(targets_raw, list) else _default_targets()) if str(x).strip()]
    excl_raw = mlh.get("exclude_globs", [])
    exclude_globs = [str(x) for x in (excl_raw if isinstance(excl_raw, list) else []) if str(x).strip()]

    files, missing = iter_md_files_by_targets(root, targets, exclude_globs)
    if missing:
        print("[warn] markdown link hygiene gate: some targets not found (skipped): " + ", ".join(missing[:8]) + (" ..." if len(missing) > 8 else ""))
    if not files:
        print(f"[ok] markdown link hygiene gate: no Markdown files matched targets under {root}")
        return 0

    errors: list[str] = []
    for p in files:
        errors.extend(_validate_link_hygiene(p))

    if errors:
        print("[fail] markdown link hygiene gate failed")
        for e in errors[:200]:
            print(f"[error] {e}")
        if len(errors) > 200:
            print(f"[error] ... ({len(errors) - 200} more)")
        return 1

    print("[ok] markdown link hygiene gate passed")
    print(f"- root: {root}")
    print(f"- files scanned: {len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
