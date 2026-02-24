#!/usr/bin/env python3
"""
Knowledge-base layers gate (domain-neutral).

Goal:
- Make "evidence + priors + validated methodology traces" explicit, persistent, and referenceable.
- Fail-fast before LLM calls when the project declares this gate as enabled.

This gate checks:
1) knowledge base directory structure exists:
   - <base_dir>/literature/
   - <base_dir>/methodology_traces/
   - <base_dir>/priors/
2) The notebook capsule contains a section:
   "### I) Knowledge base references (MANDATORY when enabled)"
   with three lists:
   - Literature:
   - Methodology traces:
   - Priors:
3) Listed paths exist on disk (resolved relative to notebook dir).
4) At least N methodology traces are listed (configurable).
5) Rendering safety (project policy): referenced KB notes must not contain
   Markdown-hostile display-math formatting (e.g. lines starting with + / - / =
   inside $$...$$ blocks), which breaks common Markdown renderers.

Exit codes:
  0  ok, or gate disabled
  1  missing/invalid (fail-fast)
  2  input error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore
from md_math_hygiene import validate_markdown_math_hygiene  # type: ignore


CAPSULE_START = "<!-- REPRO_CAPSULE_START -->"
CAPSULE_END = "<!-- REPRO_CAPSULE_END -->"


@dataclass(frozen=True)
class KBRefs:
    literature: list[str]
    methodology: list[str]
    priors: list[str]


def _extract_capsule(text: str) -> str | None:
    if CAPSULE_START not in text or CAPSULE_END not in text:
        return None
    a = text.index(CAPSULE_START) + len(CAPSULE_START)
    b = text.index(CAPSULE_END)
    return text[a:b]


def _extract_capsule_section(capsule: str, heading_regex: str) -> str:
    m = re.search(rf"^###\s+{heading_regex}.*?$", capsule, flags=re.MULTILINE)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r"^###\s+", capsule[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(capsule[start:]))
    return capsule[start:end].strip()


def _parse_list_under(label: str, text: str) -> list[str]:
    """
    Parse a simple bullet list under a line like "Literature:".
    Stops at the next "<Word>:" label.
    """
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if re.match(rf"^\s*{re.escape(label)}\s*$", ln.strip()):
            start = i + 1
            break
    if start is None:
        return []
    out: list[str] = []
    for ln in lines[start:]:
        if re.match(r"^\s*[A-Za-z].*:\s*$", ln.strip()):
            break
        m = re.match(r"^\s*-\s+(.+?)\s*$", ln)
        if not m:
            continue
        item = m.group(1).strip()

        # Accept Markdown links and extract the target path:
        #   - [text](relative/path.md)
        #   - [text](relative/path.md "optional title")
        m_link = re.match(r"^\[[^\]]+\]\((.+)\)\s*$", item)
        if m_link:
            target = m_link.group(1).strip()
            # Drop optional title (space + quoted string) if present.
            target = target.split()[0].strip()
            # Strip angle brackets around autolinks: (<path>).
            target = target.strip("<>")
            # Strip fragment to allow links like foo.md#section.
            target = target.split("#", 1)[0]
            item = target.strip()

        out.append(item)
    return out


def _resolve_paths(items: list[str], notebook_dir: Path) -> tuple[list[Path], list[str]]:
    ok: list[Path] = []
    missing: list[str] = []
    for s in items:
        p = Path(s)
        if not p.is_absolute():
            p = notebook_dir / p
        if p.exists():
            ok.append(p)
        else:
            missing.append(s)
    return ok, missing


def _extract_field(text: str, field: str) -> str:
    m = re.search(rf"^\s*{re.escape(field)}\s*:\s*(.+?)\s*$", text, flags=re.MULTILINE)
    return m.group(1).strip() if m else ""


def _validate_literature_note(path: Path, forbid_tokens: Optional[list[str]] = None) -> list[str]:
    """
    Enforce a minimal metadata header in literature notes (no backward-compat guarantees).
    This is intentionally line-based and LaTeX-parser-free.
    """
    errors: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return [f"Failed to read literature note: {path} ({exc})"]

    # Only inspect the first chunk for metadata fields (keeps this deterministic and fast).
    head = "\n".join(text.splitlines()[:200])

    refkey = _extract_field(head, "RefKey")
    if not refkey:
        errors.append(f"{path}: missing required metadata line: 'RefKey: ...'")

    authors = _extract_field(head, "Authors")
    if not authors:
        errors.append(f"{path}: missing required metadata line: 'Authors: ...'")

    pub = _extract_field(head, "Publication")
    if not pub:
        errors.append(f"{path}: missing required metadata line: 'Publication: ...'")

    # Links: require at least one http(s) OR an explicit "Link: none" sentinel.
    if re.search(r"https?://", head) is None:
        if re.search(r"\bLink\s*:\s*none\b", head, flags=re.IGNORECASE) is None and re.search(
            r"\bLinks?\s*:\s*none\b", head, flags=re.IGNORECASE
        ) is None:
            errors.append(f"{path}: missing external link(s) under 'Links:' (or write 'Link: none').")

    # INSPIRE-specific requirements.
    m_ref = re.fullmatch(r"recid-(\d+)", refkey) if refkey else None
    if m_ref:
        rid = m_ref.group(1)
        inspire_rid = _extract_field(head, "INSPIRE recid")
        if not inspire_rid or not re.fullmatch(r"\d+", inspire_rid):
            errors.append(f"{path}: recid-based note must include 'INSPIRE recid: <integer>'.")
        elif inspire_rid != rid:
            errors.append(f"{path}: INSPIRE recid mismatch (RefKey={rid} vs INSPIRE recid={inspire_rid}).")

        citekey = _extract_field(head, "Citekey")
        if not citekey:
            errors.append(f"{path}: recid-based note must include 'Citekey: <texkey>'.")

    # Optional strictness: forbid "stub" placeholders in referenced notes (token-based, case-insensitive).
    toks = [t.strip() for t in (forbid_tokens or []) if isinstance(t, str) and t.strip()]
    if toks:
        lines = text.splitlines()
        lower_lines = [ln.lower() for ln in lines]
        for tok in toks:
            tok_l = tok.lower()
            for i, ln in enumerate(lower_lines, start=1):
                if tok_l in ln:
                    errors.append(f"{path}:{i}: forbidden token found in literature note: {tok!r}")
                    break

    return errors


def _validate_markdown_math_hygiene(path: Path) -> list[str]:
    """
    Enforce a small, deterministic subset of Markdown rendering-safety rules.

    Why this lives in the KB gate:
    - KB notes are frequently referenced in Draft_Derivation.md (capsule I, References).
    - A single bad $$ block can break rendering and make evidence unreadable.

    Rules enforced (errors):
    - Disallow LaTeX \\( \\) and \\[ \\] delimiters (require $...$ / $$...$$).
    - In $$...$$ blocks, no line may start with + / - / = (even after leading whitespace).
    - Detect likely "split equation" artifacts: back-to-back $$ blocks where the second begins
      with a continuation token (\\qquad, \\quad, \\times, \\cdot).
    """
    if not path.is_file() or path.suffix.lower() not in (".md", ".markdown"):
        return []

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return [f"Failed to read KB note: {path} ({exc})"]

    return validate_markdown_math_hygiene(text, path_for_msgs=path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("knowledge_layers_gate", default=False):
        print("[skip] knowledge layers gate disabled by research_team_config")
        return 0

    kb_cfg = cfg.data.get("knowledge_layers", {})
    base_dir_name = str(kb_cfg.get("base_dir", "knowledge_base"))
    require_min_traces = int(kb_cfg.get("require_min_methodology_traces", 1))
    require_min_lit = int(kb_cfg.get("require_min_literature", 0))
    require_min_pri = int(kb_cfg.get("require_min_priors", 0))
    allow_none = bool(kb_cfg.get("allow_none", True))
    forbid_lit_tokens = kb_cfg.get("forbid_literature_tokens", [])
    if not isinstance(forbid_lit_tokens, list):
        forbid_lit_tokens = []
    forbid_lit_tokens = [str(x) for x in forbid_lit_tokens if str(x).strip()]

    notebook_dir = args.notes.parent.resolve()
    base_dir = notebook_dir / base_dir_name
    required_dirs = {
        "literature": base_dir / "literature",
        "methodology_traces": base_dir / "methodology_traces",
        "priors": base_dir / "priors",
    }

    errors: list[str] = []
    for k, p in required_dirs.items():
        if not p.is_dir():
            errors.append(f"Missing knowledge base directory: {p} (expected layer: {k})")

    text = args.notes.read_text(encoding="utf-8", errors="replace")
    capsule = _extract_capsule(text)
    if capsule is None:
        errors.append("Missing Reproducibility Capsule markers; cannot locate Knowledge base references section.")
        capsule = ""

    section = _extract_capsule_section(capsule, r"I\)\s+Knowledge\s+base\s+references")
    if not section:
        errors.append(
            "Missing capsule section '### I) Knowledge base references'. "
            "Add it inside the Reproducibility Capsule with lists for Literature / Methodology traces / Priors."
        )
        section = ""

    lit = _parse_list_under("Literature:", section) if section else []
    meth = _parse_list_under("Methodology traces:", section) if section else []
    pri = _parse_list_under("Priors:", section) if section else []

    if section:
        if not lit:
            errors.append(
                "Knowledge base references: 'Literature:' list is empty "
                "(add at least 1 item, or explicitly write '- none' when allow_none=true)."
            )
        if not pri:
            errors.append(
                "Knowledge base references: 'Priors:' list is empty "
                "(add at least 1 item, or explicitly write '- none' when allow_none=true)."
            )

    # Special-case "- none" sentinel.
    def _drop_none(xs: list[str]) -> list[str]:
        return [x for x in xs if x.lower() not in ("none", "n/a", "na", "null")]

    def _has_none(xs: list[str]) -> bool:
        return any(x.lower() in ("none", "n/a", "na", "null") for x in xs)

    if section and not allow_none:
        if _has_none(lit) or _has_none(meth) or _has_none(pri):
            errors.append("Knowledge base references: '- none' is not allowed when allow_none=false.")

    lit_r = _drop_none(lit)
    meth_r = _drop_none(meth)
    pri_r = _drop_none(pri)

    if section:
        if require_min_lit > 0 and len(lit_r) < require_min_lit:
            errors.append(
                f"Need at least {require_min_lit} literature item(s) under 'Literature:' (found {len(lit_r)})."
            )
        if require_min_pri > 0 and len(pri_r) < require_min_pri:
            errors.append(
                f"Need at least {require_min_pri} prior(s) under 'Priors:' (found {len(pri_r)})."
            )
        if require_min_traces > 0 and len(meth_r) < require_min_traces:
            errors.append(
                f"Need at least {require_min_traces} methodology trace(s) under 'Methodology traces:' (found {len(meth_r)})."
            )

    ok_lit, miss_lit = _resolve_paths(lit_r, notebook_dir)
    ok_meth, miss_meth = _resolve_paths(meth_r, notebook_dir)
    ok_pri, miss_pri = _resolve_paths(pri_r, notebook_dir)
    if miss_lit:
        errors.append("Missing literature reference files: " + ", ".join(miss_lit[:8]) + (" ..." if len(miss_lit) > 8 else ""))
    if miss_meth:
        errors.append("Missing methodology trace files: " + ", ".join(miss_meth[:8]) + (" ..." if len(miss_meth) > 8 else ""))
    if miss_pri:
        errors.append("Missing priors files: " + ", ".join(miss_pri[:8]) + (" ..." if len(miss_pri) > 8 else ""))

    # Strict validation: literature notes must carry basic metadata.
    # (No backward-compat: this is part of the research-team contract.)
    for p in ok_lit:
        errors.extend(_validate_literature_note(p, forbid_tokens=forbid_lit_tokens))

    # Rendering safety: referenced KB notes must not contain Markdown-hostile $$ formatting.
    # Validate all referenced KB notes (literature + methodology traces + priors).
    for p in [*ok_lit, *ok_meth, *ok_pri]:
        errors.extend(_validate_markdown_math_hygiene(p))

    if errors:
        print("[fail] knowledge layers gate failed")
        for e in errors:
            print(f"[error] {e}")
        return 1

    print("[ok] knowledge layers gate passed")
    print(f"- base_dir: {base_dir}")
    print(f"- literature listed: {len(lit_r)}")
    print(f"- methodology_traces listed: {len(meth_r)}")
    print(f"- priors listed: {len(pri_r)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
