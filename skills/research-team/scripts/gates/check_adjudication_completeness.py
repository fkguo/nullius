#!/usr/bin/env python3
"""
Fold-boundary gate: a converged cycle's non-blocking findings must be
dispositioned before results are folded.

Severity-graded convergence lets members report `ready` while carrying Minor
Issues; the convergence gate surfaces per-member `minor_issues_count` in its
machine result and the adjudication builder emits a fillable disposition
table. This gate is the machine consumer that closes the loop: run it at the
fold boundary (before folding a converged cycle's results into the durable
record). It fails closed when recorded minor issues lack explicit
dispositions — an empty disposition cell, a bare "discard" without a reason,
or a missing adjudication file are refusals, not warnings.

Semantics:
  - The convergence result JSON (from check_team_convergence.py) is the
    authority for how many minor issues were recorded.
  - status != "converged"  -> SKIP (exit 0): folding a non-converged cycle is
    already forbidden upstream; this gate only guards the fold of a converged
    one.
  - total minor issues == 0 -> PASS (nothing owed; no adjudication required).
  - total minor issues  > 0 -> the adjudication file must exist and contain at
    least that many completed disposition rows. A completed row's disposition
    cell matches one of exactly three forms (case-insensitive):
        fix now[: free text]
        acceptance point <name>
        discard: <reason>
    A table row whose finding cell is filled but whose disposition cell is
    empty or malformed is a refusal (that is the "adjudication not finished"
    state the builder's template warns about).

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (dispositions incomplete / adjudication missing)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from convergence_schema import validate_convergence_result  # type: ignore

_DISPOSITION_RE = re.compile(
    r"^(?:fix\s+now\b.*|acceptance\s+point\s+\S.*|discard:\s*\S.*)$",
    re.IGNORECASE,
)

_SECTION_RE_TEMPLATE = r"^\s{{0,3}}##\s+{heading}\s*$"


def _normalize_finding(text: str) -> str:
    """Normalize a finding text for identity matching: strip markdown
    emphasis and code markers, collapse whitespace, lowercase — so
    "**actual finding**" and "actual finding" are the same identity."""
    stripped = re.sub(r"[*_`]", "", text)
    return re.sub(r"\s+", " ", stripped).strip().lower()


def _member_minor_findings(report_text: str) -> list[str]:
    """Extract normalized Minor Issues finding texts from a member report,
    with the same list-item discipline as the convergence gate's counter."""
    pat = re.compile(_SECTION_RE_TEMPLATE.format(heading=re.escape("Minor Issues")),
                     re.MULTILINE | re.IGNORECASE)
    m = pat.search(report_text)
    if not m:
        return []
    start = m.end()
    m2 = re.compile(r"^\s{0,3}##\s+", re.MULTILINE).search(report_text, start)
    section = report_text[start : m2.start() if m2 else len(report_text)]
    findings: list[str] = []
    for ln in section.splitlines():
        s = ln.strip()
        if not (re.match(r"^[-*+]\s", s) or re.match(r"^\d+\.\s", s)):
            continue
        body = re.sub(r"^(?:[-*+]\s+|\d+\.\s+)", "", s).strip()
        if _normalize_finding(body) in {"", "(none)", "none", "...", "n/a"}:
            continue
        findings.append(_normalize_finding(body))
    return findings


def _fail(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    print(json.dumps({"status": "fail", "reason": msg}))
    return 1


def _input_error(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    print(json.dumps({"status": "input_error", "reason": msg}))
    return 2


def _count_minor_issues(convergence: dict) -> tuple[int, list[str]]:
    """Sum per-member minor_issues_count; missing or malformed values are
    ERRORS, never silently zero. The team convergence gate always emits the
    field, so an absent key means contract drift — per the repository's
    no-backward-compatibility invariant there is no legacy fallback."""
    total = 0
    errors: list[str] = []
    for member, payload in (convergence.get("report_status") or {}).items():
        if not isinstance(payload, dict):
            errors.append(f"report_status.{member} is not an object")
            continue
        if "minor_issues_count" not in payload:
            errors.append(
                f"report_status.{member} lacks minor_issues_count — the team "
                "convergence gate always emits it; an absent key is contract "
                "drift, never an implicit zero"
            )
            continue
        count = payload["minor_issues_count"]
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            errors.append(
                f"report_status.{member}.minor_issues_count must be a non-negative "
                f"integer (got {count!r}) — a malformed count is never treated as zero"
            )
            continue
        total += count
    return total, errors


def _completed_disposition_rows(adjudication_text: str) -> tuple[list[str], list[str]]:
    """Count completed disposition rows and collect malformed-row diagnostics.

    Only rows of the DISPOSITION table are counted: the table whose header
    row starts with a Finding/Item column and whose last column header names
    the disposition. Other tables in the adjudication (e.g. the blocking-
    issue action table) neither satisfy nor trip this gate. Separator rows
    and template placeholder rows are skipped; a counted row with a filled
    finding cell but an empty or malformed disposition cell is a defect.
    """
    completed_rows: list[str] = []
    problems: list[str] = []
    in_disposition_table = False
    for raw in adjudication_text.splitlines():
        line = raw.strip()
        if not (line.startswith("|") and line.endswith("|")):
            # Any non-table line ends the current table.
            in_disposition_table = False
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        # Separator rows keep the current table state.
        if all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
            continue
        # A header row selects or deselects the disposition table: only the
        # table whose LAST column header names the disposition is counted —
        # the adjudication also carries other tables (e.g. the blocking-issue
        # action table) whose last cells must neither satisfy nor trip this
        # gate.
        if cells and cells[0].lower() in {"finding", "item"}:
            in_disposition_table = bool(cells) and cells[-1].lower().startswith("disposition")
            continue
        if not in_disposition_table or len(cells) < 3:
            continue
        finding, disposition = cells[0], cells[-1]
        if not finding:
            continue  # template placeholder row
        if not disposition:
            problems.append(f"row {finding!r}: empty disposition cell")
            continue
        if "<name>" in disposition or "<reason>" in disposition:
            problems.append(
                f"row {finding!r}: disposition {disposition!r} still carries a "
                "template placeholder — fill it in"
            )
            continue
        if not _DISPOSITION_RE.match(disposition):
            problems.append(
                f"row {finding!r}: disposition {disposition!r} matches none of "
                "'fix now', 'acceptance point <name>', 'discard: <reason>'"
            )
            continue
        completed_rows.append(_normalize_finding(finding))
    return completed_rows, problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--convergence-json",
        type=Path,
        required=True,
        help="machine result emitted by check_team_convergence.py",
    )
    ap.add_argument(
        "--adjudication",
        type=Path,
        default=None,
        help="adjudication markdown carrying the disposition table "
        "(required when minor issues were recorded)",
    )
    ap.add_argument(
        "--member-report",
        type=Path,
        action="append",
        default=[],
        help="member report path (repeatable). When provided, every Minor "
        "Issues finding extracted from the reports must be covered by a "
        "completed disposition row (identity binding); without reports the "
        "gate falls back to count coverage",
    )
    args = ap.parse_args()

    if not args.convergence_json.is_file():
        return _input_error(f"convergence result not found: {args.convergence_json}")
    try:
        convergence = json.loads(args.convergence_json.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return _input_error(f"unreadable convergence result: {e}")
    if not isinstance(convergence, dict):
        return _input_error("convergence result must be a JSON object")
    schema_errors = validate_convergence_result(convergence)
    if schema_errors:
        return _input_error(
            "convergence result fails the shared contract: " + "; ".join(schema_errors)
        )
    gate_id = ((convergence.get("meta") or {}).get("gate_id"))
    if gate_id != "team_convergence":
        return _input_error(
            f"convergence result carries gate_id {gate_id!r}; this gate consumes "
            "team_convergence results only"
        )

    status = convergence.get("status")
    if status != "converged":
        print(
            f"- Gate: SKIP (convergence status is {status!r}; this gate guards the "
            "fold of a converged cycle)",
            file=sys.stderr,
        )
        print(json.dumps({"status": "skip", "reason": f"cycle status {status!r}"}))
        return 0

    owed, count_errors = _count_minor_issues(convergence)
    if count_errors:
        return _input_error("; ".join(count_errors))
    if owed == 0:
        print("- Gate: PASS (no minor issues recorded; no dispositions owed)", file=sys.stderr)
        print(json.dumps({"status": "pass", "minor_issues": 0, "dispositions": 0}))
        return 0

    if args.adjudication is None:
        return _fail(
            f"{owed} minor issue(s) recorded but no --adjudication supplied; every "
            "non-blocking finding owes an explicit disposition before the fold"
        )
    if not args.adjudication.is_file():
        return _fail(f"adjudication file not found: {args.adjudication}")
    try:
        text = args.adjudication.read_text(encoding="utf-8")
    except OSError as e:
        return _input_error(f"unreadable adjudication: {e}")

    completed_rows, problems = _completed_disposition_rows(text)
    for p in problems:
        print(f"  * {p}", file=sys.stderr)
    if problems:
        return _fail(
            "adjudication contains malformed or empty disposition cells — an empty "
            "cell means the adjudication is not finished"
        )

    member_findings: list[str] = []
    if args.member_report:
        # Source binding: the supplied reports must be exactly the reports the
        # convergence gate read (report_status.*.source_path). Substituting a
        # different pair of files would let fabricated findings stand in for
        # the recorded ones.
        recorded_paths = set()
        for payload in (convergence.get("report_status") or {}).values():
            if isinstance(payload, dict) and isinstance(payload.get("source_path"), str):
                recorded_paths.add(Path(payload["source_path"]).resolve())
        supplied_paths = {rp.resolve() for rp in args.member_report}
        if recorded_paths and supplied_paths != recorded_paths:
            return _input_error(
                "supplied member reports do not match the reports the convergence "
                f"gate read — recorded {sorted(str(x) for x in recorded_paths)}, "
                f"supplied {sorted(str(x) for x in supplied_paths)}"
            )
        if not recorded_paths:
            return _input_error(
                "convergence result records no report source paths; cannot bind the "
                "supplied member reports to the recorded findings"
            )
    for report_path in args.member_report:
        if not report_path.is_file():
            return _input_error(f"member report not found: {report_path}")
        try:
            member_findings.extend(_member_minor_findings(report_path.read_text(encoding="utf-8")))
        except OSError as e:
            return _input_error(f"unreadable member report: {e}")

    if args.member_report:
        # Identity binding: every finding extracted from the member reports
        # (a multiset — the same text from two members owes two rows) must be
        # covered by a completed disposition row whose finding cell matches
        # it (equal, or the row carries the finding text plus context). Rows
        # not matching any finding neither satisfy nor mask anything.
        from collections import Counter

        finding_counts = Counter(member_findings)
        available = Counter(completed_rows)
        covered_counts: dict[str, int] = {f: 0 for f in finding_counts}
        # Two-phase assignment so a short finding cannot greedily consume a
        # row that exactly matches a longer one: exact-equality rows bind
        # first, substring (finding-plus-context) rows second.
        for finding, needed in finding_counts.items():
            if available.get(finding, 0) > 0:
                take = min(needed, available[finding])
                available[finding] -= take
                covered_counts[finding] += take
        for finding, needed in sorted(
            finding_counts.items(), key=lambda kv: -len(kv[0])
        ):
            still = needed - covered_counts[finding]
            if still <= 0:
                continue
            for row, row_count in list(available.items()):
                if row_count <= 0 or row == finding:
                    continue
                if finding in row:
                    take = min(still, row_count)
                    available[row] -= take
                    covered_counts[finding] += take
                    still -= take
                if still <= 0:
                    break
        unmatched = [
            f"{finding!r} (owed {needed}, matched {covered_counts[finding]})"
            for finding, needed in finding_counts.items()
            if covered_counts[finding] < needed
        ]
        if len(member_findings) < owed:
            return _fail(
                f"{owed} minor issue(s) recorded at convergence but only "
                f"{len(member_findings)} extracted from the supplied member reports — "
                "supply the same reports the convergence gate read"
            )
        if unmatched:
            return _fail(
                "recorded findings without a matching completed disposition row: "
                + "; ".join(unmatched)
            )
        print(
            f"- Gate: PASS (identity-bound: {len(member_findings)} finding(s) each "
            "covered by a completed disposition row)",
            file=sys.stderr,
        )
        print(
            json.dumps(
                {
                    "status": "pass",
                    "minor_issues": owed,
                    "dispositions": len(completed_rows),
                    "binding": "identity",
                }
            )
        )
        return 0

    # Count-coverage fallback (no member reports supplied — standalone use).
    if len(completed_rows) < owed:
        return _fail(
            f"{owed} minor issue(s) recorded but only {len(completed_rows)} completed "
            "disposition row(s) found — every non-blocking finding owes exactly one "
            "of: fix now / acceptance point <name> / discard: <reason>"
        )
    print(
        f"- Gate: PASS ({len(completed_rows)} disposition(s) cover {owed} recorded "
        "minor issue(s); count coverage — supply --member-report for identity binding)",
        file=sys.stderr,
    )
    print(
        json.dumps(
            {
                "status": "pass",
                "minor_issues": owed,
                "dispositions": len(completed_rows),
                "binding": "count",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
