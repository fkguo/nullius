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
from typing import Any, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from convergence_schema import (
    build_gate_meta,
    default_member_status,
    emit_convergence_result,
    validate_convergence_result,
)
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
    r"^\s{0,3}##\s+Step\s+(\d+):\s*(.+?)$(?:(?!^\s{0,3}#{2,}\s)[\s\S])*?^\s*\*{0,2}Step\s+verdict:?\*{0,2}\s*(CONFIRMED|CHALLENGED|UNVERIFIABLE)",
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

def _collect_parse_errors(status: ReportStatus, member: str, require_sweep: bool) -> list[str]:
    errors: list[str] = []
    if status.derivation == "unknown":
        errors.append(f"{member}: failed to parse derivation replication status")
    if status.computation == "unknown":
        errors.append(f"{member}: failed to parse computation replication status")
    if status.verdict == "unknown":
        errors.append(f"{member}: failed to parse verdict section/value")
    if require_sweep and status.sweep_semantics == "unknown":
        errors.append(f"{member}: failed to parse sweep semantics consistency verdict")
    return errors


def _summarize_member(status: ReportStatus, parse_errors: list[str]) -> dict[str, Any]:
    challenged = sum(1 for _, verdict in status.step_verdicts if verdict == "CHALLENGED")
    confirmed = sum(1 for _, verdict in status.step_verdicts if verdict == "CONFIRMED")
    unverifiable = sum(1 for _, verdict in status.step_verdicts if verdict == "UNVERIFIABLE")
    return {
        "verdict": status.verdict if status.verdict in {"ready", "needs_revision"} else "unknown",
        "blocking_count": None,
        "parse_ok": len(parse_errors) == 0,
        "derivation": status.derivation,
        "computation": status.computation,
        "sweep_semantics": status.sweep_semantics,
        "challenged_steps": challenged,
        "confirmed_steps": confirmed,
        "unverifiable_steps": unverifiable,
        "independent_derivation": status.has_independent_derivation,
        "nontriviality_validated": status.nontriviality_validated,
        "source_path": str(status.path),
        "errors": parse_errors,
    }


def _collect_not_converged_reasons(a: ReportStatus, b: ReportStatus, mode: str, require_sweep: bool) -> list[str]:
    reasons: list[str] = []
    for member, status in (("member_a", a), ("member_b", b)):
        if status.derivation != "pass":
            reasons.append(f"{member}: derivation={status.derivation}")
        if status.computation != "pass":
            reasons.append(f"{member}: computation={status.computation}")
        if status.verdict != "ready":
            reasons.append(f"{member}: verdict={status.verdict}")
        if require_sweep and status.sweep_semantics != "pass":
            reasons.append(f"{member}: sweep_semantics={status.sweep_semantics}")
        if not require_sweep and status.sweep_semantics == "fail":
            reasons.append(f"{member}: sweep_semantics=fail")
    if mode == "asymmetric" and not b.has_independent_derivation:
        reasons.append("member_b: missing non-empty ## Independent Derivation section")
    if not reasons:
        reasons.append("convergence criteria not satisfied")
    return reasons


def _emit_result_or_fallback(
    *,
    status: str,
    exit_code: int,
    reasons: list[str],
    report_status: dict[str, Any],
    meta: dict[str, Any],
    out_json: Path | None,
) -> int:
    result: dict[str, Any] = {
        "status": status,
        "exit_code": exit_code,
        "reasons": reasons,
        "report_status": report_status,
        "meta": meta,
    }

    schema_errors = validate_convergence_result(result)
    if schema_errors:
        result = {
            "status": "parse_error",
            "exit_code": 2,
            "reasons": ["schema validation failed", *schema_errors],
            "report_status": {
                k: {**v, "parse_ok": False}
                for k, v in report_status.items()
            },
            "meta": meta,
        }
        exit_code = 2

    emit_convergence_result(result, out_json=out_json)
    return exit_code

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
    # RT-05: optional context display (does NOT change convergence logic)
    p.add_argument(
        "--phase0-landscape",
        type=Path,
        default=None,
        help="Path to Phase 0 method_landscape.md (informational display only).",
    )
    p.add_argument(
        "--phase2-responses",
        type=Path,
        default=None,
        help="Path to Phase 2 consultation responses directory (informational display only).",
    )
    p.add_argument(
        "--out-json",
        type=Path,
        default=None,
        help="Optional file path to persist the structured convergence result JSON.",
    )
    args = p.parse_args()

    mode = args.workflow_mode
    require_sweep = args.require_sweep
    base_meta = build_gate_meta("team_convergence")
    base_meta["workflow_mode"] = mode
    base_meta["require_sweep"] = require_sweep

    missing_reasons: list[str] = []
    if not args.member_a.is_file():
        missing_reasons.append(f"member_a report not found: {args.member_a}")
    if not args.member_b.is_file():
        missing_reasons.append(f"member_b report not found: {args.member_b}")
    if missing_reasons:
        return _emit_result_or_fallback(
            status="parse_error",
            exit_code=2,
            reasons=missing_reasons,
            report_status={
                "member_a": default_member_status(args.member_a),
                "member_b": default_member_status(args.member_b),
            },
            meta=base_meta,
            out_json=args.out_json,
        )

    member_a = _parse_report(args.member_a)
    member_b = _parse_report(args.member_b)

    parse_errors_a = _collect_parse_errors(member_a, "member_a", require_sweep=require_sweep)
    parse_errors_b = _collect_parse_errors(member_b, "member_b", require_sweep=require_sweep)

    report_status: dict[str, Any] = {
        "member_a": _summarize_member(member_a, parse_errors_a),
        "member_b": _summarize_member(member_b, parse_errors_b),
    }

    parse_errors = [*parse_errors_a, *parse_errors_b]
    if parse_errors:
        return _emit_result_or_fallback(
            status="parse_error",
            exit_code=2,
            reasons=parse_errors,
            report_status=report_status,
            meta=base_meta,
            out_json=args.out_json,
        )

    rc = check_convergence(member_a, member_b, mode, require_sweep)
    if rc == 0:
        status = "converged"
        reasons = []
    elif rc == 3:
        status = "early_stop"
        challenged = [name for name, verdict in member_b.step_verdicts if verdict == "CHALLENGED"]
        reasons = [f"member_b challenged steps: {len(challenged)}", *challenged]
    else:
        status = "not_converged"
        reasons = _collect_not_converged_reasons(member_a, member_b, mode=mode, require_sweep=require_sweep)

    return _emit_result_or_fallback(
        status=status,
        exit_code=rc,
        reasons=reasons,
        report_status=report_status,
        meta=base_meta,
        out_json=args.out_json,
    )


if __name__ == "__main__":
    raise SystemExit(main())
