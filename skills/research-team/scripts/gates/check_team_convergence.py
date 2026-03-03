#!/usr/bin/env python3
"""
Check whether two team-member reports (Member A + Member B) have converged.

Exit codes:
  0  Converged (both pass derivation+computation and verdict is ready)
  1  Not converged (any mismatch/fail/needs revision/unknown)
  3  Leader early stop (>=2 CHALLENGED step verdicts from verifier) [leader mode only]

This is intentionally heuristic but deterministic, based on the enforced
output contract in the system prompts:
- "Comparison: match/mismatch"
- Reproduction Summary table rows: pass/fail
- Verdict: ready for next milestone / needs revision
- Step verdict: CONFIRMED/CHALLENGED/UNVERIFIABLE [leader/asymmetric modes]
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import get_language_tokens, load_team_config  # type: ignore

# Controlled vocabulary for nontriviality reasons
NONTRIVIALITY_REASONS = frozenset({
    "INDEPENDENT_PATH",
    "STABILITY_CONVERGENCE",
    "ERROR_BUDGET",
    "INVARIANT_LIMIT",
    "SCHEME_CONVENTION",
    "STATISTICAL_STABILITY",
    "ALT_TOOLCHAIN",
})


@dataclass(frozen=True)
class ReportStatus:
    path: Path
    derivation: str  # pass/fail/unknown
    computation: str  # pass/fail/unknown
    verdict: str  # ready/needs_revision/unknown
    sweep_semantics: str  # pass/fail/unknown
    # --- RT-01 additions ---
    step_verdicts: List[Tuple[str, str]] = field(default_factory=list)
    has_independent_derivation: bool = False
    nontriviality_validated: bool = False  # True if NONTRIVIAL + all required fields present


def _normalize_pass_fail(token: str, pass_tokens: tuple[str, ...], fail_tokens: tuple[str, ...]) -> str:
    t = token.strip().lower()
    if t in pass_tokens:
        return "pass"
    if t in fail_tokens:
        return "fail"
    return "unknown"


def _extract_section(text: str, heading: str) -> str:
    """Extract content between ## {heading} and the next ## heading.

    Tolerates 0-3 leading spaces per CommonMark ATX heading spec.
    """
    pat = re.compile(rf"^\s{{0,3}}##\s+{re.escape(heading)}\s*$", re.MULTILINE | re.IGNORECASE)
    m = pat.search(text)
    if not m:
        return ""
    start = m.end()
    m2 = re.compile(r"^\s{0,3}##\s+", re.MULTILINE).search(text, start)
    end = m2.start() if m2 else len(text)
    return text[start:end]


def _parse_pass_fail_from_table(text: str, row_name: str, pass_tokens: tuple[str, ...], fail_tokens: tuple[str, ...]) -> str:
    """Parse pass/fail from a Markdown table row, tolerant to light formatting."""
    m = re.search(
        rf"\|\s*{re.escape(row_name)}\s*\|\s*[*`_~\s]*(pass|fail|通过|失败|合格|不合格)[*`_~\s]*\s*\|",
        text,
        flags=re.IGNORECASE,
    )
    if not m:
        return "unknown"
    return _normalize_pass_fail(m.group(1), pass_tokens, fail_tokens)


def _parse_comparison(section_text: str) -> str:
    """Parse 'Comparison: ...' line. mismatch checked before match to avoid substring collision.

    Tolerates markdown decoration (bold, bullets) around the label.
    """
    m = re.search(r"^\s*[-*]?\s*\*{0,2}Comparison:?\*{0,2}\s*([^\n]+)$", section_text, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return "unknown"
    value = m.group(1).strip().lower()
    # BUG FIX: "mismatch" contains "match" as a substring.
    # Check mismatch FIRST (more specific pattern wins).
    if "mismatch" in value:
        return "fail"
    if "match" in value:
        return "pass"
    return "unknown"


def _parse_verdict(text: str, ready_tokens: tuple[str, ...], needs_tokens: tuple[str, ...]) -> str:
    """Parse verdict from ## Verdict (or known heading variants). No fulltext fallback."""
    # BUG FIX: try multiple heading variants instead of falling back to full text.
    verdict_sec = ""
    for h in ("Verdict", "Final Verdict", "结论", "总结"):
        verdict_sec = _extract_section(text, h)
        if verdict_sec:
            break
    if not verdict_sec:
        # No Verdict section found at all — return unknown (do NOT search full text
        # to avoid matching system-prompt boilerplate like "choose needs revision").
        return "unknown"

    lower = verdict_sec.lower()

    has_needs = ("needs revision" in lower) or ("not ready" in lower) or any(tok in verdict_sec for tok in needs_tokens)
    has_ready = ("ready for next milestone" in lower) or any(tok in verdict_sec for tok in ready_tokens)

    if has_needs and has_ready:
        return "unknown"
    if has_needs:
        return "needs_revision"
    if has_ready:
        return "ready"
    return "unknown"


def _parse_sweep_semantics(text: str) -> str:
    """Parse sweep semantics consistency verdict."""
    sec = _extract_section(text, "Sweep Semantics / Parameter Dependence")
    if not sec:
        return "unknown"
    m = re.search(r"^\s*[-*]?\s*\*{0,2}Consistency verdict:?\*{0,2}\s*(.+?)\s*$", sec, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return "unknown"
    tail = m.group(1)
    tail_l = tail.lower()

    has_pass = False
    has_fail = False
    if re.search(r"(?<![a-z])pass(?![a-z])", tail_l):
        has_pass = True
    if re.search(r"(?<![a-z])fail(?![a-z])", tail_l):
        has_fail = True
    # Chinese tokens (handle "不合格" before "合格").
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


# ---------------------------------------------------------------------------
# Step verdicts parsing (leader/asymmetric modes)
# ---------------------------------------------------------------------------

_STEP_VERDICT_RE = re.compile(
    r"^\s{0,3}##\s+Step\s+(\d+):\s*(.+?)$(?:(?!^\s{0,3}#{2,}\s)[\s\S])*?\*{0,2}Step\s+verdict:?\*{0,2}\s*(CONFIRMED|CHALLENGED|UNVERIFIABLE)",
    re.MULTILINE | re.IGNORECASE,
)


def _parse_step_verdicts(text: str) -> list[tuple[str, str]]:
    """Extract (step_name, verdict) pairs from 'Step verdict: CONFIRMED|CHALLENGED|UNVERIFIABLE'."""
    results: list[tuple[str, str]] = []
    for m in _STEP_VERDICT_RE.finditer(text):
        step_name = f"Step {m.group(1)}: {m.group(2).strip()}"
        verdict = m.group(3).strip().upper()
        results.append((step_name, verdict))
    return results


def _has_independent_derivation(text: str) -> bool:
    """Check if report contains a non-empty ## Independent Derivation section."""
    sec = _extract_section(text, "Independent Derivation")
    return bool(sec.strip())


# ---------------------------------------------------------------------------
# Nontriviality validation
# ---------------------------------------------------------------------------

def _validate_nontriviality(text: str) -> bool:
    """Validate that a NONTRIVIAL classification has required supporting fields.

    Returns True if:
      - Triviality classification is NONTRIVIAL AND
      - Falsification pathway is present and non-empty AND
      - Failure mode targeted is present and non-empty AND
      - Nontriviality reason is present and matches the controlled vocabulary

    If classification is TRIVIAL or absent, returns False (no downgrade needed).
    """
    comp_sec = _extract_section(text, "Computation Replication")
    if not comp_sec:
        return False

    # Helper: match a "Label: value" line tolerating bullets/bold prefixes
    def _field(label: str) -> re.Match | None:
        return re.search(
            rf"^\s*[-*]?\s*\*{{0,2}}{re.escape(label)}:?\*{{0,2}}[ \t]*(\S[^\n]*)$",
            comp_sec, re.IGNORECASE | re.MULTILINE,
        )

    # Check classification tag
    m_class = re.search(r"\*{0,2}Triviality classification:?\*{0,2}\s*(NONTRIVIAL|TRIVIAL)", comp_sec, re.IGNORECASE)
    if not m_class or m_class.group(1).upper() != "NONTRIVIAL":
        return False

    # Require all three supporting fields
    m_fp = _field("Falsification pathway")
    m_fm = _field("Failure mode targeted")

    if not m_fp or not m_fp.group(1).strip():
        return False
    if not m_fm or not m_fm.group(1).strip():
        return False

    # Enforce controlled vocabulary for nontriviality reason
    reason = _parse_nontriviality_reason(text)
    if reason is None:
        return False

    return True


def _parse_nontriviality_reason(text: str) -> str | None:
    """Extract and validate the Nontriviality reason value. Returns None if unparseable."""
    comp_sec = _extract_section(text, "Computation Replication")
    if not comp_sec:
        return None
    m = re.search(
        r"^\s*[-*]?\s*\*{0,2}Nontriviality reason:?\*{0,2}[ \t]*(\S[^\n]*)$",
        comp_sec, re.IGNORECASE | re.MULTILINE,
    )
    if not m:
        return None
    raw = m.group(1).strip()
    # Check controlled vocabulary
    if raw in NONTRIVIALITY_REASONS:
        return raw
    # Check OTHER:* pattern (require non-empty suffix)
    if raw.startswith("OTHER:") and raw[6:].strip():
        return raw
    return None


# ---------------------------------------------------------------------------
# Report parsing
# ---------------------------------------------------------------------------

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
    sweep_semantics = _parse_sweep_semantics(text)

    step_verdicts = _parse_step_verdicts(text)
    has_indep = _has_independent_derivation(text)
    nontriviality_ok = _validate_nontriviality(text)

    return ReportStatus(
        path=path,
        derivation=derivation,
        computation=computation,
        verdict=verdict,
        sweep_semantics=sweep_semantics,
        step_verdicts=step_verdicts,
        has_independent_derivation=has_indep,
        nontriviality_validated=nontriviality_ok,
    )


# ---------------------------------------------------------------------------
# Convergence checks (mode-dispatched)
# ---------------------------------------------------------------------------

def _is_converged(status: ReportStatus, *, require_sweep: bool = True) -> bool:
    """Check if a single report meets convergence criteria.

    Args:
        require_sweep: If True (default), sweep_semantics must be "pass".
            If False (theory milestones), sweep "unknown" is tolerated but
            explicit "fail" still blocks.
    """
    base = (
        status.derivation == "pass"
        and status.computation == "pass"
        and status.verdict == "ready"
    )
    if require_sweep:
        return base and status.sweep_semantics == "pass"
    # theory milestones: unknown sweep does not block, but explicit fail still blocks
    return base and status.sweep_semantics != "fail"


def _check_peer(a: ReportStatus, b: ReportStatus, require_sweep: bool) -> int:
    """Peer mode: both members must independently converge."""
    if _is_converged(a, require_sweep=require_sweep) and _is_converged(b, require_sweep=require_sweep):
        return 0
    return 1


def _check_leader(a: ReportStatus, b: ReportStatus, require_sweep: bool) -> int:
    """Leader mode: A is leader, B is verifier with step-level verdicts.

    Returns:
        0: converged
        1: not converged
        3: early stop (>=2 CHALLENGED from verifier)
    """
    # Check for early stop: >=2 CHALLENGED from verifier (member B)
    challenged_count = sum(1 for _, v in b.step_verdicts if v == "CHALLENGED")
    if challenged_count >= 2:
        return 3

    # Both must converge on standard criteria
    if _is_converged(a, require_sweep=require_sweep) and _is_converged(b, require_sweep=require_sweep):
        return 0
    return 1


def _check_asymmetric(a: ReportStatus, b: ReportStatus, require_sweep: bool) -> int:
    """Asymmetric mode: B must have ## Independent Derivation section.

    Returns:
        0: converged
        1: not converged
    """
    # Member B must have independent derivation section
    if not b.has_independent_derivation:
        return 1

    if _is_converged(a, require_sweep=require_sweep) and _is_converged(b, require_sweep=require_sweep):
        return 0
    return 1


def check_convergence(a: ReportStatus, b: ReportStatus, mode: str, require_sweep: bool) -> int:
    """Top-level dispatch by workflow mode."""
    if mode == "peer":
        return _check_peer(a, b, require_sweep)
    elif mode == "leader":
        return _check_leader(a, b, require_sweep)
    elif mode == "asymmetric":
        return _check_asymmetric(a, b, require_sweep)
    else:
        # Unknown mode: fallback to peer
        return _check_peer(a, b, require_sweep)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--member-a", type=Path, required=True, help="Member A report path (md/txt).")
    p.add_argument("--member-b", type=Path, required=True, help="Member B report path (md/txt).")
    p.add_argument(
        "--workflow-mode",
        choices=["peer", "leader", "asymmetric"],
        default="leader",
        help="Workflow mode (default: leader).",
    )
    p.add_argument(
        "--require-sweep",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Require sweep_semantics=pass for convergence (default: True). "
             "Use --no-require-sweep for theory milestones.",
    )
    args = p.parse_args()

    if not args.member_a.is_file():
        raise SystemExit(f"ERROR: not found: {args.member_a}")
    if not args.member_b.is_file():
        raise SystemExit(f"ERROR: not found: {args.member_b}")

    member_a = _parse_report(args.member_a)
    member_b = _parse_report(args.member_b)

    mode = args.workflow_mode
    require_sweep = args.require_sweep

    print(f"Team convergence check (mode={mode}, require_sweep={require_sweep})")
    print(
        f"- Member A: derivation={member_a.derivation}, computation={member_a.computation}, "
        f"verdict={member_a.verdict}, sweep={member_a.sweep_semantics} ({member_a.path})"
    )
    print(
        f"- Member B: derivation={member_b.derivation}, computation={member_b.computation}, "
        f"verdict={member_b.verdict}, sweep={member_b.sweep_semantics} ({member_b.path})"
    )
    if member_b.step_verdicts:
        print(f"- Member B step verdicts: {member_b.step_verdicts}")
    if mode == "asymmetric":
        print(f"- Member B independent derivation: {member_b.has_independent_derivation}")

    # Nontriviality audit (informational)
    for label, status in [("A", member_a), ("B", member_b)]:
        if status.nontriviality_validated:
            reason = _parse_nontriviality_reason(status.path.read_text(encoding="utf-8", errors="replace"))
            print(f"- Member {label} nontriviality: validated (reason={reason})")
        else:
            print(f"- Member {label} nontriviality: not validated (TRIVIAL or missing fields)")

    rc = check_convergence(member_a, member_b, mode, require_sweep)

    if rc == 0:
        print("[ok] Converged: both reviewers pass and verdict is ready.")
    elif rc == 3:
        challenged = [(name, v) for name, v in member_b.step_verdicts if v == "CHALLENGED"]
        print(f"[early-stop] Leader mode: verifier CHALLENGED {len(challenged)} steps: "
              f"{[name for name, _ in challenged]}. Apply fixes before re-running.")
    else:
        print("[fail] Not converged: apply fixes and re-run team cycle (e.g. tag M2-r1).")

    return rc


if __name__ == "__main__":
    raise SystemExit(main())
