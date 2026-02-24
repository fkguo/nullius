#!/usr/bin/env python3
"""
Milestone Definition-of-Done (DoD) gate for RESEARCH_PLAN.md.

Purpose: prevent "acceptance criteria" from being purely ceremonial.
This is a lightweight structural check that ensures the current milestone
has at least some concrete deliverables and acceptance tests recorded.

Scope / philosophy:
- Deterministic and fast; no heuristics that require LLM judgement.
- Works only when the tag looks like a milestone tag (e.g. M2-r1 -> milestone M2).
- Intended as a *guardrail*; deep quality is enforced by the team cross-check prompts.

Controlled by `features.milestone_dod_gate` in research_team_config.json.

Exit codes:
  0  ok, or gate disabled / not applicable
  1  fail-fast (missing/malformed milestone DoD)
  2  input error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

try:
    from team_config import load_team_config  # type: ignore
except Exception as exc:  # pragma: no cover - import-time failure
    print(f"ERROR: failed to import team_config: {exc}", file=sys.stderr)
    raise SystemExit(2)


@dataclass(frozen=True)
class Issue:
    message: str


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
    if in_fence:
        # Malformed Markdown (unclosed fence). Be conservative: do not strip, to avoid hiding content.
        print("[warn] unclosed code fence detected in RESEARCH_PLAN.md; skipping fence stripping", file=sys.stderr)
        return text
    return "\n".join(out)


def _find_plan(notes_path: Path) -> Path | None:
    cur = (notes_path.parent if notes_path.is_file() else notes_path).resolve()
    for _ in range(50):
        cand = cur / "RESEARCH_PLAN.md"
        if cand.is_file():
            return cand
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def _extract_heading_block(text: str, *, heading_re: str) -> str:
    """
    Extract a markdown section starting at a heading matching `heading_re`
    and ending right before the next heading of the same or higher level.
    """
    m = re.search(heading_re, text, flags=re.MULTILINE)
    if not m:
        return ""
    hashes = m.group("hashes") if "hashes" in m.groupdict() else "###"
    level = len(hashes)
    start = m.end()
    # End at the next heading with <= level hashes.
    m2 = re.search(rf"^#{{1,{level}}}\s", text[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(text[start:]))
    return text[start:end].strip()


def _subbullets_after(label_line_re: str, block: str) -> list[str]:
    """
    Find a label line (e.g. '- Deliverables:') and collect indented sub-bullets
    of the form '  - ...' until the next label/heading.
    """
    lines = block.splitlines()
    for i, ln in enumerate(lines):
        if not re.match(label_line_re, ln.strip(), flags=re.IGNORECASE):
            continue
        out: list[str] = []

        def _indent_width(line: str) -> int:
            width = 0
            for ch in line:
                if ch == " ":
                    width += 1
                elif ch == "\t":
                    width = (width // 4 + 1) * 4
                else:
                    break
            return width

        label_indent = _indent_width(ln)

        current: str | None = None
        current_indent = 0
        base_item_indent: int | None = None
        # Accept standard Markdown list markers and simple ordered lists.
        bullet_re = re.compile(r"^(?P<indent>\s*)(?:[-*+]|(?:\d+\.))\s+(?P<body>.+?)\s*$")
        # Next label line like "- Acceptance:" (allow any marker), and bare labels like "Acceptance:".
        next_label_re = re.compile(r"^\s*(?:[-*+]|(?:\d+\.))\s+[A-Za-z].*:\s*$")
        bare_label_re = re.compile(r"^[A-Za-z].*:\s*$")

        for j in range(i + 1, len(lines)):
            ln2 = lines[j]
            if re.match(r"^#{2,6}\s+", ln2):
                break
            if next_label_re.match(ln2) and _indent_width(ln2) <= label_indent:
                break
            if _indent_width(ln2) <= label_indent and bare_label_re.match(ln2.strip()):
                break
            if not ln2.strip():
                # Blank lines are allowed inside list items (multi-paragraph bullets) as long as
                # the next non-empty line is still indented as a continuation.
                if current is not None:
                    k = j + 1
                    while k < len(lines) and not lines[k].strip():
                        k += 1
                    if k < len(lines) and _indent_width(lines[k]) > current_indent:
                        continue
                    out.append(current.strip())
                    current = None
                continue

            m = bullet_re.match(ln2)
            if m:
                indent = _indent_width(m.group("indent"))
                if indent <= label_indent:
                    # We left the nested list under the label.
                    break
                body = m.group("body").strip()
                if base_item_indent is None:
                    base_item_indent = indent
                # Only count first-level bullets under the label. Deeper nested bullets are treated
                # as continuations (details), not as separate criteria.
                if indent > base_item_indent:
                    if current is not None:
                        current = current.rstrip() + " " + body
                    else:
                        current = body
                    continue
                if indent < base_item_indent:
                    base_item_indent = indent
                if current is not None:
                    out.append(current.strip())
                current = body
                current_indent = indent
                continue

            # Continuation line: append to current bullet if indented further.
            if current is not None and ln2.strip():
                if _indent_width(ln2) > current_indent:
                    current = current.rstrip() + " " + ln2.strip()
                    continue

        if current is not None:
            out.append(current.strip())
        return out
    return []


def _is_placeholder(s: str) -> bool:
    low = s.strip().lower()
    if not low:
        return True
    if "(fill" in low:
        return True
    # Match template placeholders like "<PROJECT_NAME>" or "<path/to/file>" but avoid inequalities like "< 0.05".
    for m in re.finditer(r"<([^>\n]{1,120})>", s):
        inner = m.group(1)
        if not any(ch.isalpha() for ch in inner):
            continue
        alnum = sum(1 for ch in inner if ch.isalnum())
        if alnum >= 2 or any(tok in inner for tok in ("/", "_", "-", "|")):
            return True
    if re.search(r"\b(?:tbd|todo|wip)\b", low):
        return True
    return False


def _is_concrete_acceptance(s: str) -> bool:
    """
    Heuristic: "concrete" if it references an artifact/command/threshold.
    """
    if _is_placeholder(s):
        return False
    if re.search(r"`[^`]+`", s):
        return True
    if any(tok in s for tok in (">=", "<=", "==", "!=")):
        return True
    # Allow plain < or > only when paired with a numeric threshold (avoid accidental HTML-ish uses).
    number_re = re.compile(r"\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b")
    if ("<" in s or ">" in s) and re.search(r"(?:<|>)\s*\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", s):
        return True
    if re.search(
        r"\.(jsonl?|csv|tsv|h5|hdf5|parquet|nc|npz|npy|pdf|png|svg|md|txt|ya?ml|toml|py|jl|sh|tex|bib|log|ipynb)\b",
        s,
        flags=re.IGNORECASE,
    ):
        return True
    if re.search(r"https?://", s, flags=re.IGNORECASE):
        return True
    if re.search(r"\b(python3?|python|bash|julia|pytest|pnpm|npm|cargo)\b", s, flags=re.IGNORECASE):
        return True
    # Path-like strings. Avoid false positives like "and/or" by requiring either:
    # - a known project prefix, or
    # - a file-like last segment (contains "."), or
    # - multiple path segments (>=2 slashes).
    prefixes = (
        "artifacts/",
        "knowledge_base/",
        "knowledge_graph/",
        "team/",
        "prompts/",
        "scripts/",
        "figures/",
        "results/",
        "data/",
    )
    stop_path_tokens = {
        # Common prose tokens that use slashes but are not paths.
        "and",
        "or",
        "either",
        "both",
        "his",
        "her",
        "their",
        "he",
        "she",
        "him",
        "them",
    }
    for m in re.finditer(r"\b[\w.-]+/[\w./-]+\b", s):
        p = m.group(0)
        lowp = p.lower()
        if lowp.startswith(prefixes):
            return True
        # Skip date-like patterns (e.g. 2024/12/31) that are not artifact paths.
        segs = [seg for seg in lowp.split("/") if seg]
        if segs and all(seg.isdigit() for seg in segs):
            continue
        if p.count("/") >= 2:
            if segs and all(seg.isalpha() and seg in stop_path_tokens for seg in segs):
                continue
            return True
        last = p.rsplit("/", 1)[-1]
        if "." in last:
            return True
    if "run_team_cycle" in s or "preflight" in s:
        return True
    # Numbers can still be concrete if paired with verification context.
    if number_re.search(s) and re.search(r"\b(within|tolerance|sigma|percent|%)\b", s, flags=re.IGNORECASE):
        return True
    return False


def _has_md_link_to(prefix: str, s: str) -> bool:
    """
    Return True if `s` contains a Markdown link whose target starts with `prefix`.
    """
    for m in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", s):
        target = m.group(1).strip()
        if target.startswith(prefix) or target.startswith(f"./{prefix}"):
            return True
    return False


def _iter_md_link_targets(s: str) -> list[str]:
    out: list[str] = []
    for m in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", s):
        out.append(m.group(1).strip())
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (used to locate plan/config).")
    ap.add_argument("--tag", type=str, required=True, help="Round tag (e.g. M2-r1).")
    ap.add_argument("--max-issues", type=int, default=30, help="Max issues to print.")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    try:
        cfg = load_team_config(args.notes if args.notes.is_file() else Path.cwd())
    except Exception as exc:
        print(f"ERROR: failed to load research_team_config: {exc}")
        return 2
    if not cfg.feature_enabled("milestone_dod_gate", default=False):
        print("[skip] milestone DoD gate disabled by research_team_config")
        return 0

    # Allow common sub-milestone tags like "M5b-r1" in addition to "M5-r1".
    # We treat the base milestone as "M<digits><optional-letter>" so that
    # RESEARCH_PLAN sections like "### M5b — ..." participate in the DoD gate.
    m = re.match(r"^(M\d+[A-Za-z]?)\b", args.tag.strip())
    if not m:
        print("[skip] milestone DoD gate not applicable (tag is not a milestone tag like M2-r1)")
        return 0
    milestone = m.group(1)

    plan = _find_plan(args.notes)
    if plan is None:
        print("[fail] milestone DoD gate failed")
        print("[error] RESEARCH_PLAN.md not found (cannot validate milestone deliverables/acceptance)")
        return 1
    text = plan.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    text = _strip_fenced_code(text)

    # Match headings like: "### M2 — ..." or "## M2 ..." (any level >=2).
    block = _extract_heading_block(
        text,
        heading_re=rf"^(?P<hashes>##+)\s+.*\b{re.escape(milestone)}\b.*$",
    )
    if not block:
        print("[fail] milestone DoD gate failed")
        print(f"[error] Could not find milestone section for {milestone} in {plan}")
        print(f"[fix] Add a heading like '### {milestone} — ...' with Deliverables and Acceptance sub-bullets.")
        return 1

    issues: list[Issue] = []
    has_deliv_label = bool(re.search(r"^\s*(?:[-*+]|(?:\d+\.))?\s*Deliverables\s*:\s*$", block, flags=re.IGNORECASE | re.MULTILINE))
    has_acc_label = bool(re.search(r"^\s*(?:[-*+]|(?:\d+\.))?\s*Acceptance\s*:\s*$", block, flags=re.IGNORECASE | re.MULTILINE))
    if not has_deliv_label:
        issues.append(Issue("Milestone section is missing a 'Deliverables:' label."))
    if not has_acc_label:
        issues.append(Issue("Milestone section is missing an 'Acceptance:' label."))

    deliverables = _subbullets_after(r"^(?:[-*+]|(?:\d+\.))?\s*Deliverables\s*:\s*$", block)
    acceptance = _subbullets_after(r"^(?:[-*+]|(?:\d+\.))?\s*Acceptance\s*:\s*$", block)

    deliverables_clean = [d for d in deliverables if not _is_placeholder(d)]
    acceptance_clean = [a for a in acceptance if not _is_placeholder(a)]
    acceptance_concrete = [a for a in acceptance_clean if _is_concrete_acceptance(a)]

    if not deliverables_clean:
        issues.append(Issue("Deliverables list is empty or placeholders only (add at least one concrete deliverable path)."))
    if not acceptance_clean:
        issues.append(Issue("Acceptance list is empty or placeholders only (add at least one acceptance test)."))
    elif not acceptance_concrete:
        issues.append(
            Issue(
                "Acceptance list has no concrete acceptance test (add at least one item that references a file/command/threshold)."
            )
        )

    profile = str(cfg.data.get("profile", "")).strip().lower()
    if profile == "toolkit_extraction":
        toolkit_label_res = (
            r"^(?:[-*+]|(?:\d+\.))?\s*Toolkit delta\s*:\s*$",
            r"^(?:[-*+]|(?:\d+\.))?\s*工具包(?:变更|增量)\s*:\s*$",
        )
        has_toolkit_label = any(re.search(pat, block, flags=re.IGNORECASE | re.MULTILINE) for pat in toolkit_label_res)
        toolkit_items: list[str] = []
        for pat in toolkit_label_res:
            toolkit_items = _subbullets_after(pat, block)
            if toolkit_items:
                break

        if not has_toolkit_label:
            issues.append(
                Issue("Milestone section is missing a 'Toolkit delta:' label (required when profile=toolkit_extraction).")
            )
        else:
            toolkit_clean = [x for x in toolkit_items if not _is_placeholder(x)]
            if len(toolkit_clean) < 3:
                issues.append(
                    Issue(
                        "Toolkit delta list is empty or placeholders-only (add >=3 concrete bullets: API spec, code snippet index, KB evidence links)."
                    )
                )
            else:
                has_api_spec = any(re.search(r"\bapi\b", x, flags=re.IGNORECASE) and _is_concrete_acceptance(x) for x in toolkit_clean)
                if not has_api_spec:
                    issues.append(
                        Issue(
                            "Toolkit delta is missing an API spec pointer (include a concrete path/link, e.g. '[TOOLKIT_API.md](TOOLKIT_API.md)' or similar)."
                        )
                    )

                has_code_index = any(
                    re.search(r"\b(code|snippet|module|library|src|toolkit)\b", x, flags=re.IGNORECASE)
                    and (
                        re.search(r"`[^`]+`", x)
                        or re.search(r"\.(py|jl|c|cc|cpp|h|hpp|rs|go|ts|js)\b", x, flags=re.IGNORECASE)
                        or "src/" in x
                        or "toolkit/" in x
                    )
                    for x in toolkit_clean
                )
                if not has_code_index:
                    issues.append(
                        Issue(
                            "Toolkit delta is missing a code snippet index (include at least one concrete code pointer/path, ideally to src/ or toolkit/)."
                        )
                    )

                has_kb_linkage = any(
                    _has_md_link_to("knowledge_base/", x)
                    for x in toolkit_clean
                )
                if not has_kb_linkage:
                    issues.append(
                        Issue(
                            "Toolkit delta is missing KB evidence linkage (include at least one clickable Markdown link to knowledge_base/, ideally knowledge_base/methodology_traces/...)."
                        )
                    )

                # Clickability + existence check for any knowledge_base markdown links (strict in toolkit profile).
                root = plan.parent.resolve()
                for item in toolkit_clean:
                    if re.search(r"`\[[^\]]+\]\((?:\./)?knowledge_base/[^)]+\)`", item):
                        issues.append(
                            Issue(
                                "Toolkit delta contains a knowledge_base Markdown link wrapped in backticks (not clickable). Remove backticks."
                            )
                        )
                    for target in _iter_md_link_targets(item):
                        if target.startswith("http://") or target.startswith("https://"):
                            continue
                        if target.startswith("./"):
                            target = target[2:]
                        if not target.startswith("knowledge_base/"):
                            continue
                        target_path = target.split("#", 1)[0].split("?", 1)[0]
                        if not (root / target_path).is_file():
                            issues.append(Issue(f"Toolkit delta links missing KB file: {target_path}"))

    print(f"- Plan: `{plan}`")
    print(f"- Milestone: {milestone}")
    print(f"- Deliverables: {len(deliverables_clean)}")
    print(f"- Acceptance: {len(acceptance_clean)} (concrete={len(acceptance_concrete)})")
    gate = "PASS" if not issues else "FAIL"
    print(f"- Gate: {gate}")

    if issues:
        for it in issues[: args.max_issues]:
            print(f"ERROR: {it.message}")
        print("")
        print("Fix: update the milestone section in RESEARCH_PLAN.md to include concrete deliverables and acceptance tests.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
