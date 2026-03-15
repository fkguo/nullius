#!/usr/bin/env python3
"""
fix_markdown_link_hygiene.py

Deterministic autofix helper for common "non-clickable link" Markdown hazards.

What it fixes (outside fenced code blocks):
1) Inline code spans wrapping a Markdown link, e.g. `[...] ( ... )`:
   - unwraps by removing the backticks, leaving a normal Markdown link.
2) Inline code spans that are standalone Markdown file/path pointers, e.g. `knowledge_base/foo.md` or `research_contract.md`:
   - rewrites into a Markdown link: [knowledge_base/foo.md](knowledge_base/foo.md)

Conservative guards:
- Does NOT touch inline code spans containing whitespace (likely commands/snippets).
- Does NOT touch placeholders/globs containing `*`, `<`, `>`, `{`, `}`, `|`.
- Does NOT touch code-pointer forms containing ':' or '#'.

Exit codes:
  0  no changes needed (or all changes applied with --in-place)
  1  changes needed (when NOT using --in-place)
  2  input error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from md_utils import iter_inline_code_spans, iter_md_files_under  # type: ignore


_CODE_FENCE_PREFIXES = ("```", "~~~")
_MD_LINK_RE = re.compile(r"\[[^\]]+\]\([^)]+\)")


@dataclass(frozen=True)
class Change:
    line: int
    kind: str
    detail: str


def _looks_like_md_path(token: str) -> bool:
    s = token.strip()
    if not s:
        return False
    if any(ch.isspace() for ch in s):
        return False
    if any(ch in s for ch in ("*", "<", ">", "{", "}", "|")):
        return False
    if ":" in s:
        return False
    base = s.split("#", 1)[0]
    if base.lower().endswith((".md", ".markdown")):
        return True
    if base.startswith(("knowledge_base/", "./knowledge_base/")) and base.endswith("/"):
        return True
    return False


def _maybe_fix_inline_code(content: str) -> tuple[str | None, str | None]:
    """
    Return (replacement, change_kind) if we should rewrite this inline code span; otherwise (None, None).
    """
    if _MD_LINK_RE.search(content):
        return content, "unwrap_link"
    if "[@recid-" in content or "#ref-" in content or content.strip().startswith("[@"):
        return content, "unwrap_citation"
    if _looks_like_md_path(content):
        return f"[{content}]({content})", "code_path_to_link"
    return None, None


def _rewrite_line(line: str) -> tuple[str, list[Change]]:
    spans = iter_inline_code_spans(line)
    if not spans:
        return line, []

    out: list[str] = []
    changes: list[Change] = []
    last = 0
    for start, end, content, delim in spans:
        out.append(line[last:start])
        repl, kind = _maybe_fix_inline_code(content)
        if repl is None:
            out.append(line[start:end])
        else:
            out.append(repl)
            changes.append(Change(0, kind or "rewrite", f"rewrite {delim}{content}{delim}"))
        last = end
    out.append(line[last:])
    return "".join(out), changes


def _normalize(text: str) -> tuple[str, list[Change]]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    had_trailing_nl = text.endswith("\n")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]

    out: list[str] = []
    changes: list[Change] = []
    in_code = False
    fence_ch = ""
    fence_len = 0

    for i, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        fence = raw.lstrip()
        if fence.startswith(_CODE_FENCE_PREFIXES):
            ch = fence[0]
            run_len = 0
            while run_len < len(fence) and fence[run_len] == ch:
                run_len += 1
            if not in_code:
                in_code = True
                fence_ch = ch
                fence_len = run_len
                out.append(raw)
                continue
            if ch == fence_ch and run_len >= fence_len:
                in_code = False
                fence_ch = ""
                fence_len = 0
                out.append(raw)
                continue
        if in_code:
            out.append(raw)
            continue

        new_line, ch = _rewrite_line(raw)
        if ch:
            for c in ch:
                changes.append(Change(i, c.kind, c.detail))
        out.append(new_line)

    new_text = "\n".join(out)
    if had_trailing_nl:
        new_text += "\n"
    return new_text, changes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path("."), help="File or directory to scan (default: .).")
    ap.add_argument(
        "--in-place",
        action="store_true",
        help="Rewrite files in place. Without this flag, runs in check mode and exits non-zero if changes are needed.",
    )
    args = ap.parse_args()

    root = args.root
    if not root.exists():
        print(f"ERROR: path not found: {root}", file=sys.stderr)
        return 2

    files = iter_md_files_under(root)
    if not files:
        if root.is_file():
            print(f"[skip] not a Markdown file: {root}")
            return 0
        print(f"[skip] no Markdown files under: {root}")
        return 0

    changed_files = 0
    total_changes = 0
    needs_changes = False

    for p in files:
        try:
            orig = p.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            print(f"ERROR: failed to read {p}: {exc}", file=sys.stderr)
            return 2

        new, changes = _normalize(orig)
        if not changes:
            continue

        needs_changes = True
        changed_files += 1
        total_changes += len(changes)

        if not args.in_place:
            print(f"[needs-fix] {p}")
            for c in changes[:50]:
                print(f"  - L{c.line}: {c.kind}: {c.detail}")
            if len(changes) > 50:
                print(f"  - ... ({len(changes) - 50} more)")
            continue

        try:
            p.write_text(new, encoding="utf-8")
        except Exception as exc:
            print(f"ERROR: failed to write {p}: {exc}", file=sys.stderr)
            return 2

        print(f"[fixed] {p} ({len(changes)} change(s))")

    if not needs_changes:
        print("[ok] no Markdown link hygiene fixes needed")
        return 0

    if args.in_place:
        print(f"[ok] fixed {changed_files} file(s), {total_changes} change(s) total")
        return 0

    print(f"[fail] fixes needed: {changed_files} file(s), {total_changes} change(s) total")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
