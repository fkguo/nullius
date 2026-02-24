#!/usr/bin/env python3
"""
Notebook integrity gate for Draft_Derivation.md (deterministic, fail-fast).

This gate focuses on *structure* and *rendering-safety* issues that commonly
break downstream automation (packet extraction) or Markdown rendering:

- Marker uniqueness:
  - exactly one REPRO_CAPSULE block
  - exactly one AUDIT_SLICES block
  - exactly one REVIEW_EXCERPT block
- Filled marker blocks:
  - REVIEW_EXCERPT must not be empty / template placeholder
  - AUDIT_SLICES must be present; for computational milestones with headline numbers,
    it must contain some non-template content (audit proxies / checks).
- Markdown math hygiene (project policy):
  - Disallow \\( \\) and \\[ \\] math environments (require $...$ / $$...$$)
  - In $$...$$ blocks, do not start a line with + / - / = (Markdown list/heading hazards)

This gate is controlled by `features.notebook_integrity_gate` in research_team_config.json.

Exit codes:
  0  ok, or gate disabled
  1  fail-fast (integrity errors)
  2  input error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


CAPSULE_START = "<!-- REPRO_CAPSULE_START -->"
CAPSULE_END = "<!-- REPRO_CAPSULE_END -->"
AUDIT_START = "<!-- AUDIT_SLICES_START -->"
AUDIT_END = "<!-- AUDIT_SLICES_END -->"
EXCERPT_START = "<!-- REVIEW_EXCERPT_START -->"
EXCERPT_END = "<!-- REVIEW_EXCERPT_END -->"


@dataclass(frozen=True)
class Issue:
    level: str  # ERROR|WARN
    line: int
    message: str


def _line_no(text: str, offset: int) -> int:
    return text[: max(0, offset)].count("\n") + 1


def _find_all(text: str, needle: str) -> list[int]:
    out: list[int] = []
    start = 0
    while True:
        i = text.find(needle, start)
        if i < 0:
            break
        out.append(i)
        start = i + len(needle)
    return out


def _extract_block(text: str, start_marker: str, end_marker: str) -> tuple[str | None, int, int]:
    if start_marker not in text or end_marker not in text:
        return None, -1, -1
    a = text.index(start_marker) + len(start_marker)
    b = text.index(end_marker)
    if b < a:
        return None, a, b
    return text[a:b].strip(), a, b


def _parse_milestone_kind(capsule: str) -> str:
    for ln in capsule.splitlines():
        m = re.match(r"^\s*(?:-\s*)?Milestone kind\s*:\s*(.+?)\s*$", ln, flags=re.IGNORECASE)
        if not m:
            continue
        v = m.group(1).strip().lower()
        if v in ("theory", "theory-only", "analytic", "derivation"):
            return "theory"
        if v in ("dataset", "data_prep", "data-prep", "dataprep", "data", "generate-data"):
            return "dataset"
        if v in ("computational", "compute", "computation", "numeric", "numerics", "simulation", "dns"):
            return "computational"
        return v
    return "computational"


def _parse_min_headline_numbers(capsule: str) -> int | None:
    m = re.search(r"^\s*(?:-\s*)?Min headline numbers\s*:\s*(\d+)\s*(?:#.*)?$", capsule, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _is_placeholder_review_excerpt(excerpt: str) -> bool:
    if not excerpt.strip():
        return True
    low = excerpt.strip().lower()
    if "paste the minimal excerpt" in low:
        return True
    return False


_AUDIT_PLACEHOLDER_LINES = {
    "- key algorithm steps to cross-check:",
    "- proxy headline numbers (audit quantities; fast to verify by hand/estimate):",
    "- boundary or consistency checks (limits/symmetry/conservation):",
    "- trivial operations not rechecked (standard library, io, plotting):",
    "- audit slice artifacts (logs/tables):",
}


def _has_non_placeholder_audit_content(audit: str) -> bool:
    # Consider the block "filled" if it contains any non-empty line that is not
    # one of the template placeholder bullets.
    for ln in audit.splitlines():
        s = ln.strip()
        if not s:
            continue
        if s.lower() in _AUDIT_PLACEHOLDER_LINES:
            continue
        return True
    return False


def _check_marker_uniqueness(text: str, issues: list[Issue]) -> None:
    markers = [
        ("REPRO_CAPSULE_START", CAPSULE_START),
        ("REPRO_CAPSULE_END", CAPSULE_END),
        ("AUDIT_SLICES_START", AUDIT_START),
        ("AUDIT_SLICES_END", AUDIT_END),
        ("REVIEW_EXCERPT_START", EXCERPT_START),
        ("REVIEW_EXCERPT_END", EXCERPT_END),
    ]
    for name, m in markers:
        offs = _find_all(text, m)
        if len(offs) != 1:
            if len(offs) == 0:
                issues.append(Issue("ERROR", 1, f"missing marker: {name} ({m})"))
            else:
                ln = _line_no(text, offs[1])
                issues.append(Issue("ERROR", ln, f"duplicate marker: {name} appears {len(offs)} times; keep exactly one block"))

    # Soft-detect legacy/variant markers that confuse humans and can lead to duplicate blocks.
    for pat in (r"<!--\s*REVIEW_EXCERPT_(?:START|END)_[^>]+-->", r"<!--\s*AUDIT_SLICES_(?:START|END)_[^>]+-->"):
        for m in re.finditer(pat, text):
            issues.append(Issue("WARN", _line_no(text, m.start()), f"legacy marker present (prefer deleting): {m.group(0)}"))


def _check_math_hygiene(text: str, issues: list[Issue]) -> None:
    # Scan line-by-line so we can ignore fenced/inline code spans (which may contain examples like `\(\)`).
    in_fence = False
    in_display = False
    cont_pat = re.compile(r"^\\(?:qquad|quad|times|cdot)\b")
    prev_nonblank_kind = ""  # "dollar" | "other" | ""
    prev_nonblank_line = 0
    expecting_continuation_check = False
    adjacent_prev_fence_line = 0
    err_count = 0
    for idx, raw_ln in enumerate(text.splitlines(), start=1):
        ln = raw_ln
        if ln.strip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        # Remove inline code spans to avoid flagging documentation examples.
        ln = re.sub(r"`[^`]*`", "", ln)

        # Disallow LaTeX \( \) and \[ \] environments (project policy).
        # Allow TeX linebreak spacing like \\[2pt] by only flagging single-backslash \[ and \].
        delim_pat = r"\\\(|\\\)|(?<!\\)\\\[|(?<!\\)\\\]"
        if re.search(delim_pat, ln):
            # Report each delimiter occurrence on this line.
            for m in re.finditer(delim_pat, ln):
                issues.append(
                    Issue(
                        "ERROR",
                        idx,
                        f"disallowed LaTeX math delimiter found: '{m.group(0)}' (use $...$ or $$...$$)",
                    )
                )
                err_count += 1
                if err_count >= 50:
                    return

        # Warn on inline/one-line $$ usage; this gate only validates fenced $$ blocks.
        if "$$" in ln and not re.match(r"^\s*\$\$\s*$", ln):
            issues.append(Issue("WARN", idx, "found '$$' not on its own line; prefer fenced $$ blocks for stable rendering"))

        # Toggle state when encountering a standalone $$ fence.
        if re.match(r"^\s*\$\$\s*$", ln):
            if not in_display:
                # Opening fence.
                expecting_continuation_check = prev_nonblank_kind == "dollar"
                adjacent_prev_fence_line = prev_nonblank_line if expecting_continuation_check else 0
                in_display = True
            else:
                # Closing fence.
                in_display = False
                expecting_continuation_check = False
                adjacent_prev_fence_line = 0

            prev_nonblank_kind = "dollar"
            prev_nonblank_line = idx
            continue

        if not in_display:
            if ln.strip():
                prev_nonblank_kind = "other"
                prev_nonblank_line = idx
            continue

        stripped = ln.lstrip()
        if not stripped:
            continue

        if expecting_continuation_check:
            expecting_continuation_check = False
            m_cont = cont_pat.match(stripped)
            if m_cont:
                tok = m_cont.group(0)
                issues.append(
                    Issue(
                        "ERROR",
                        idx,
                        f"suspected split display equation: '$$' block starts right after a previous '$$' fence (prev fence at line {adjacent_prev_fence_line}) "
                        f"and begins with continuation token '{tok}'. Merge into a single $$...$$ block.",
                    )
                )
                err_count += 1
                if err_count >= 50:
                    return

        if stripped[0] in ("+", "-", "="):
            issues.append(Issue("ERROR", idx, "line inside $$...$$ starts with '+', '-', or '=' (move operator to previous line or rewrite)"))
            err_count += 1
            if err_count >= 50:
                return


_MD_LINK_RE = re.compile(r"\[[^\]]+\]\([^)]+\)")
_KB_MD_PATH_RE = re.compile(r"^knowledge_base/[^\s`]+\.md$")


def _check_link_hygiene(text: str, issues: list[Issue]) -> None:
    """
    Rendering-safety rule: do not wrap links/KB-note paths in inline code spans.

    Inline code turns `[...] ( ... )` into literal text, so the link is not clickable.
    """
    in_fence = False
    err_count = 0
    for idx, raw_ln in enumerate(text.splitlines(), start=1):
        ln = raw_ln
        if ln.strip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        for m in re.finditer(r"`([^`\n]+)`", ln):
            content = m.group(1)
            if _MD_LINK_RE.search(content):
                issues.append(Issue("ERROR", idx, "Markdown link is wrapped in inline code; remove backticks so it is clickable"))
                err_count += 1
            elif _KB_MD_PATH_RE.match(content) and "*" not in content:
                issues.append(Issue("ERROR", idx, "knowledge_base/*.md path is wrapped in inline code; use a Markdown link so it is clickable"))
                err_count += 1
            if err_count >= 50:
                return


def _check_heading_numbering(text: str, issues: list[Issue]) -> None:
    # Warn (not fail) if numeric top-level headings skip numbers.
    nums: list[tuple[int, int]] = []  # (heading_number, line_no)
    for i, ln in enumerate(text.splitlines(), start=1):
        m = re.match(r"^##\s+(\d+)\.\s+", ln)
        if m:
            nums.append((int(m.group(1)), i))
    if len(nums) < 3:
        return
    nums_sorted = sorted(nums, key=lambda x: x[0])
    seen = [n for n, _ in nums_sorted]
    missing = []
    for k in range(min(seen), max(seen) + 1):
        if k not in set(seen):
            missing.append(k)
    if missing:
        issues.append(
            Issue(
                "WARN",
                nums_sorted[0][1],
                f"top-level heading numbers are non-contiguous: missing {missing[:10]}{' ...' if len(missing)>10 else ''} (may be intentional gaps or misnumbering)",
            )
        )

    # Warn if many top-level 'Conclusions' headings exist (encourage milestone log section).
    conc = []
    for i, ln in enumerate(text.splitlines(), start=1):
        if re.match(r"^##\s+(?:\d+\.\s*)?(?:Conclusions?|结论)\b", ln):
            conc.append(i)
    if len(conc) > 1:
        issues.append(Issue("WARN", conc[1], f"multiple top-level Conclusions headings detected ({len(conc)}); prefer a single 'Milestone Log' section with subheadings"))


_DERIVATION_HINT_RE = re.compile(
    r"\bStep\s*\d+\b|\bDerivation\b|\bProof\b|\bTherefore\b|\bHence\b|\bimplies\b|推导|证明|因此|由此|所以|证毕",
    flags=re.IGNORECASE,
)


def _check_capsule_contract_only(text: str, capsule_raw: str, capsule_offset: int, issues: list[Issue]) -> None:
    """
    Soft warning: discourage step-by-step derivations inside the capsule.

    The capsule is intended to be a reproducibility contract (what/where/how).
    Derivations belong in the stable body sections, with the capsule pointing to them.
    """
    m = _DERIVATION_HINT_RE.search(capsule_raw)
    if not m:
        return
    issues.append(
        Issue(
            "WARN",
            _line_no(text, capsule_offset + m.start()),
            "capsule contains derivation-like language; move derivations to stable body sections and leave pointers",
        )
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md.")
    ap.add_argument("--max-issues", type=int, default=80, help="Max issues to print.")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("notebook_integrity_gate", default=False):
        print("[skip] notebook integrity gate disabled by research_team_config")
        return 0

    text = args.notes.read_text(encoding="utf-8", errors="replace")
    issues: list[Issue] = []

    _check_marker_uniqueness(text, issues)

    capsule, cap_a, cap_b = _extract_block(text, CAPSULE_START, CAPSULE_END)
    if capsule is None:
        # Marker check already reported; skip downstream capsule-dependent checks.
        capsule = ""
    else:
        # Soft warning: capsule should stay contract-only (derivations in body).
        if cap_a >= 0 and cap_b >= 0 and cap_b >= cap_a:
            _check_capsule_contract_only(text, text[cap_a:cap_b], cap_a, issues)
    milestone_kind = _parse_milestone_kind(capsule)
    min_headlines = _parse_min_headline_numbers(capsule)
    default_min_headlines = 3
    cap_cfg = cfg.data.get("capsule", {}) if isinstance(cfg.data.get("capsule", {}), dict) else {}
    try:
        default_min_headlines = int(cap_cfg.get("min_headline_numbers", default_min_headlines))
    except Exception:
        default_min_headlines = 3
    effective_min_headlines = min_headlines if min_headlines is not None else default_min_headlines

    excerpt, ex_a, _ = _extract_block(text, EXCERPT_START, EXCERPT_END)
    if excerpt is not None and _is_placeholder_review_excerpt(excerpt):
        issues.append(Issue("ERROR", _line_no(text, ex_a), "REVIEW_EXCERPT block is empty or still template placeholder"))

    audit, au_a, _ = _extract_block(text, AUDIT_START, AUDIT_END)
    if audit is not None:
        require_audit = (milestone_kind == "computational") and (effective_min_headlines > 0)
        if require_audit and not _has_non_placeholder_audit_content(audit):
            issues.append(Issue("ERROR", _line_no(text, au_a), "AUDIT_SLICES block is still template-only; add audit proxies/checks for computational milestone"))

    _check_math_hygiene(text, issues)
    _check_link_hygiene(text, issues)
    _check_heading_numbering(text, issues)

    errors = [x for x in issues if x.level == "ERROR"]
    warns = [x for x in issues if x.level == "WARN"]

    print(f"- Notes: `{args.notes}`")
    print(f"- Issues: errors={len(errors)}, warnings={len(warns)}")
    print(f"- Gate: {'FAIL' if errors else 'PASS'}")

    shown = 0
    for it in issues:
        if shown >= args.max_issues:
            break
        print(f"{it.level}: line {it.line}: {it.message}")
        shown += 1
    if len(issues) > shown:
        print(f"... ({len(issues) - shown} more)")

    if errors:
        print("")
        print("Fix: update Draft_Derivation.md to remove duplicates, fill excerpt/audit slices, and follow math formatting rules.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
