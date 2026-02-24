#!/usr/bin/env python3
"""
Check whether two team-member reports (Member A + Member B) have converged.

Exit codes:
  0  Converged (both pass derivation+computation and verdict is ready)
  1  Not converged (any mismatch/fail/needs revision/unknown)

This is intentionally heuristic but deterministic, based on the enforced
output contract in the system prompts:
- "Comparison: match/mismatch"
- Reproduction Summary table rows: pass/fail
- Verdict: ready for next milestone / needs revision
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import get_language_tokens, load_team_config  # type: ignore

@dataclass(frozen=True)
class ReportStatus:
    path: Path
    derivation: str  # pass/fail/unknown
    computation: str  # pass/fail/unknown
    verdict: str  # ready/needs_revision/unknown
    sweep_semantics: str  # pass/fail/unknown


def _normalize_pass_fail(token: str, pass_tokens: tuple[str, ...], fail_tokens: tuple[str, ...]) -> str:
    t = token.strip().lower()
    if t in pass_tokens:
        return "pass"
    if t in fail_tokens:
        return "fail"
    return "unknown"


def _extract_section(text: str, heading: str) -> str:
    # Find a section starting at "## {heading}" and ending before the next "## ".
    pat = re.compile(rf"^##\s+{re.escape(heading)}\s*$", re.MULTILINE | re.IGNORECASE)
    m = pat.search(text)
    if not m:
        return ""
    start = m.end()
    m2 = re.compile(r"^##\s+", re.MULTILINE).search(text, start)
    end = m2.start() if m2 else len(text)
    return text[start:end]


def _parse_pass_fail_from_table(text: str, row_name: str, pass_tokens: tuple[str, ...], fail_tokens: tuple[str, ...]) -> str:
    # Be tolerant to light Markdown formatting around pass/fail (e.g. **pass**, `fail`).
    m = re.search(
        rf"\|\s*{re.escape(row_name)}\s*\|\s*[*`_~\s]*(pass|fail|通过|失败|合格|不合格)[*`_~\s]*\s*\|",
        text,
        flags=re.IGNORECASE,
    )
    if not m:
        return "unknown"
    return _normalize_pass_fail(m.group(1), pass_tokens, fail_tokens)


def _parse_comparison(section_text: str) -> str:
    # Look for "Comparison: ..." inside a section. If missing, unknown.
    m = re.search(r"^\s*Comparison:\s*([^\n]+)$", section_text, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return "unknown"
    value = m.group(1).strip().lower()
    has_match = "match" in value
    has_mismatch = "mismatch" in value
    if has_match and has_mismatch:
        return "unknown"
    if has_mismatch:
        return "fail"
    if has_match:
        return "pass"
    return "unknown"


def _parse_verdict(text: str, ready_tokens: tuple[str, ...], needs_tokens: tuple[str, ...]) -> str:
    # Parse verdict from the "## Verdict" section to avoid false positives from
    # boilerplate text (e.g. "Verdict rule ... choose needs revision").
    verdict_sec = _extract_section(text, "Verdict")
    haystack = verdict_sec if verdict_sec else text
    lower = haystack.lower()

    has_needs = ("needs revision" in lower) or ("not ready" in lower) or any(tok in haystack for tok in needs_tokens)
    has_ready = ("ready for next milestone" in lower) or any(tok in haystack for tok in ready_tokens)

    if has_needs and has_ready:
        return "unknown"
    if has_needs:
        return "needs_revision"
    if has_ready:
        return "ready"
    return "unknown"

def _parse_sweep_semantics(text: str, pass_tokens: tuple[str, ...], fail_tokens: tuple[str, ...]) -> str:
    """
    Require reviewers to include a '## Sweep Semantics / Parameter Dependence' section.
    Parse 'Consistency verdict: pass/fail' if present; otherwise return unknown.
    """
    sec = _extract_section(text, "Sweep Semantics / Parameter Dependence")
    if not sec:
        return "unknown"
    # Be tolerant to light Markdown formatting and symbols around the "Consistency verdict" line:
    #   Consistency verdict: pass
    #   **Consistency verdict:** ✓ **Pass** — notes
    #   - Consistency verdict: `fail`
    #
    # Important: if the line contains BOTH pass-like and fail-like tokens (e.g. "pass / fail"),
    # treat it as unknown (placeholder/ambiguous) to avoid false convergence.
    m = re.search(r"^\s*.*Consistency verdict\s*:\s*(.+?)\s*$", sec, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return "unknown"
    tail = m.group(1)
    tail_l = tail.lower()

    has_pass = False
    has_fail = False
    # ASCII tokens with word-boundary-ish matching.
    if re.search(r"(?<![a-z])pass(?![a-z])", tail_l):
        has_pass = True
    if re.search(r"(?<![a-z])fail(?![a-z])", tail_l):
        has_fail = True
    # Chinese tokens (substring; handle "不合格" before "合格").
    if "不合格" in tail:
        has_fail = True
    elif "合格" in tail:
        has_pass = True
    if "失败" in tail:
        has_fail = True
    if "通过" in tail:
        has_pass = True

    if has_pass and has_fail:
        return "unknown"
    if has_pass:
        return "pass"
    if has_fail:
        return "fail"
    return "unknown"


def _parse_report(path: Path) -> ReportStatus:
    text = path.read_text(encoding="utf-8", errors="replace")

    cfg = load_team_config(path)
    pass_tokens, fail_tokens, ready_tokens, needs_tokens = get_language_tokens(cfg)

    deriv_from_table = _parse_pass_fail_from_table(text, "Derivation replication", pass_tokens, fail_tokens)
    comp_from_table = _parse_pass_fail_from_table(text, "Computation replication", pass_tokens, fail_tokens)

    deriv_section = _extract_section(text, "Derivation Replication")
    comp_section = _extract_section(text, "Computation Replication")

    deriv_from_comp = _parse_comparison(deriv_section)
    comp_from_comp = _parse_comparison(comp_section)

    derivation = deriv_from_table if deriv_from_table != "unknown" else deriv_from_comp
    computation = comp_from_table if comp_from_table != "unknown" else comp_from_comp
    verdict = _parse_verdict(text, ready_tokens, needs_tokens)
    sweep_semantics = _parse_sweep_semantics(text, pass_tokens, fail_tokens)

    return ReportStatus(path=path, derivation=derivation, computation=computation, verdict=verdict, sweep_semantics=sweep_semantics)


def _is_converged(status: ReportStatus) -> bool:
    return (
        status.derivation == "pass"
        and status.computation == "pass"
        and status.verdict == "ready"
        and status.sweep_semantics == "pass"
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--member-a", type=Path, required=True, help="Member A report path (md/txt).")
    p.add_argument("--member-b", type=Path, required=True, help="Member B report path (md/txt).")
    args = p.parse_args()

    if not args.member_a.is_file():
        raise SystemExit(f"ERROR: not found: {args.member_a}")
    if not args.member_b.is_file():
        raise SystemExit(f"ERROR: not found: {args.member_b}")

    member_a = _parse_report(args.member_a)
    member_b = _parse_report(args.member_b)

    print("Team convergence check")
    print(
        f"- Member A: derivation={member_a.derivation}, computation={member_a.computation}, "
        f"verdict={member_a.verdict}, sweep={member_a.sweep_semantics} ({member_a.path})"
    )
    print(
        f"- Member B: derivation={member_b.derivation}, computation={member_b.computation}, "
        f"verdict={member_b.verdict}, sweep={member_b.sweep_semantics} ({member_b.path})"
    )

    ok = _is_converged(member_a) and _is_converged(member_b)
    if ok:
        print("[ok] Converged: both reviewers pass and verdict is ready.")
        return 0

    print("[fail] Not converged: apply fixes and re-run team cycle (e.g. tag M2-r1).")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
