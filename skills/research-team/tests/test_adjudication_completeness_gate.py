"""Fold-boundary disposition gate: converged-with-minors cannot fold silently.

The convergence gate surfaces per-member `minor_issues_count`; this gate is
the machine consumer at the fold boundary. Fail-closed: missing adjudication,
empty disposition cells, bare "discard" without a reason, and fewer completed
rows than recorded findings are all refusals.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

GATE = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "gates"
    / "check_adjudication_completeness.py"
)


def _member(minor: int, source_path: str | None = None) -> dict:
    out = {
        "verdict": "ready",
        "blocking_count": 0,
        "parse_ok": True,
        "minor_issues_count": minor,
    }
    if source_path is not None:
        out["source_path"] = source_path
    return out


def _convergence_payload(
    *,
    status: str = "converged",
    a: int = 2,
    b: int = 1,
    source_a: str | None = None,
    source_b: str | None = None,
) -> dict:
    exit_code = 0 if status == "converged" else 1
    return {
        "status": status,
        "exit_code": exit_code,
        "reasons": [],
        "report_status": {
            "member_a": _member(a, source_a),
            "member_b": _member(b, source_b),
        },
        "meta": {
            "gate_id": "team_convergence",
            "generated_at": "2026-07-31T00:00:00Z",
            "parser_version": "test",
            "schema_id": "convergence_gate_result_v1",
            "schema_version": 1,
        },
    }


def _convergence(
    tmp_path: Path,
    *,
    status: str = "converged",
    a: int = 2,
    b: int = 1,
    source_a: str | None = None,
    source_b: str | None = None,
) -> Path:
    p = tmp_path / "convergence.json"
    p.write_text(
        json.dumps(
            _convergence_payload(
                status=status, a=a, b=b, source_a=source_a, source_b=source_b
            )
        ),
        encoding="utf-8",
    )
    return p


def _adjudication(tmp_path: Path, rows: list[str]) -> Path:
    text = "\n".join(
        [
            "# Adjudication",
            "",
            "| Finding | Source | Disposition (fix now / acceptance point <name> / discard: <reason>) |",
            "|---|---|---|",
            *rows,
            "",
        ]
    )
    p = tmp_path / "adjudication.md"
    p.write_text(text, encoding="utf-8")
    return p


def _run(*argv: str) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, str(GATE), *argv], capture_output=True, text=True, timeout=60
    )
    return proc.returncode, json.loads(proc.stdout.strip())


def test_complete_dispositions_pass(tmp_path: Path) -> None:
    conv = _convergence(tmp_path)
    adj = _adjudication(
        tmp_path,
        [
            "| fixture hardening idea | A | discard: beyond declared scope, no consumer-visible effect |",
            "| tolerance literal naming | A | fix now |",
            "| extra negative control | B | acceptance point M3-interface-freeze |",
        ],
    )
    code, verdict = _run("--convergence-json", str(conv), "--adjudication", str(adj))
    assert code == 0, verdict
    assert verdict["status"] == "pass"
    assert verdict["minor_issues"] == 3
    assert verdict["dispositions"] == 3


def test_missing_adjudication_fails(tmp_path: Path) -> None:
    conv = _convergence(tmp_path)
    code, verdict = _run("--convergence-json", str(conv))
    assert code == 1
    assert verdict["status"] == "fail"


def test_empty_disposition_cell_fails(tmp_path: Path) -> None:
    conv = _convergence(tmp_path)
    adj = _adjudication(
        tmp_path,
        [
            "| fixture hardening idea | A | fix now |",
            "| tolerance literal naming | A |  |",
            "| extra negative control | B | acceptance point M3 |",
        ],
    )
    code, verdict = _run("--convergence-json", str(conv), "--adjudication", str(adj))
    assert code == 1
    assert verdict["status"] == "fail"


def test_bare_discard_without_reason_fails(tmp_path: Path) -> None:
    conv = _convergence(tmp_path, a=1, b=0)
    adj = _adjudication(tmp_path, ["| fixture idea | A | discard |"])
    code, verdict = _run("--convergence-json", str(conv), "--adjudication", str(adj))
    assert code == 1
    assert verdict["status"] == "fail"


def test_fewer_rows_than_recorded_findings_fails(tmp_path: Path) -> None:
    conv = _convergence(tmp_path)  # 3 owed
    adj = _adjudication(tmp_path, ["| only one | A | fix now |"])
    code, verdict = _run("--convergence-json", str(conv), "--adjudication", str(adj))
    assert code == 1
    assert verdict["status"] == "fail"


def test_zero_minor_issues_pass_without_adjudication(tmp_path: Path) -> None:
    conv = _convergence(tmp_path, a=0, b=0)
    code, verdict = _run("--convergence-json", str(conv))
    assert code == 0
    assert verdict["status"] == "pass"


def test_not_converged_skips(tmp_path: Path) -> None:
    conv = _convergence(tmp_path, status="not_converged")
    code, verdict = _run("--convergence-json", str(conv))
    assert code == 0
    assert verdict["status"] == "skip"


def test_other_tables_neither_satisfy_nor_trip_the_gate(tmp_path: Path) -> None:
    # The adjudication also carries a blocking-issue action table whose last
    # column is free-text. Its rows must not count toward dispositions
    # (inflation would let an undispositioned finding fold) and must not be
    # graded as malformed dispositions (false fail).
    conv = _convergence(tmp_path)  # 3 owed
    text = "\n".join(
        [
            "# Adjudication",
            "",
            "| Item | Source | Type (FACT/JUDGMENT/IDEA) | Decision (accept/modify/reject) | Rationale + evidence pointer | Action + owner |",
            "|---|---|---|---|---|---|",
            "| boundary check wrong | A | FACT | accept | src/module.py:42 | fix now |",
            "| another blocker | B | FACT | accept | notes.md | Rewrote boundary check, owner A |",
            "",
            "| Finding | Source | Disposition (fix now / acceptance point <name> / discard: <reason>) |",
            "|---|---|---|",
            "| fixture hardening idea | A | discard: beyond declared scope |",
            "| tolerance literal naming | A | fix now |",
            "",
        ]
    )
    adj = tmp_path / "adjudication.md"
    adj.write_text(text, encoding="utf-8")
    code, verdict = _run("--convergence-json", str(conv), "--adjudication", str(adj))
    # Only the 2 genuine disposition rows count: 2 < 3 owed -> fail (the
    # action-table "fix now" cell must not inflate the count), and the
    # free-text action cell must not be reported as malformed.
    assert code == 1, verdict
    assert verdict["status"] == "fail"
    assert "only 2 completed" in verdict["reason"]


def test_wrong_gate_id_is_input_error(tmp_path: Path) -> None:
    payload = _convergence_payload(a=0, b=0)
    payload["meta"]["gate_id"] = "draft_convergence"
    p = tmp_path / "convergence.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    code, verdict = _run("--convergence-json", str(p))
    assert code == 2
    assert verdict["status"] == "input_error"


def test_schema_invalid_convergence_is_input_error(tmp_path: Path) -> None:
    payload = _convergence_payload()
    del payload["exit_code"]
    p = tmp_path / "convergence.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    code, verdict = _run("--convergence-json", str(p))
    assert code == 2
    assert verdict["status"] == "input_error"


def test_null_minor_count_is_input_error_not_zero(tmp_path: Path) -> None:
    payload = _convergence_payload(a=0, b=0)
    payload["report_status"]["member_a"]["minor_issues_count"] = None
    p = tmp_path / "convergence.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    code, verdict = _run("--convergence-json", str(p))
    assert code == 2, verdict
    assert verdict["status"] == "input_error"


def test_placeholder_disposition_fails(tmp_path: Path) -> None:
    conv = _convergence(tmp_path, a=1, b=0)
    adj = _adjudication(tmp_path, ["| fixture idea | A | acceptance point <name> |"])
    code, verdict = _run("--convergence-json", str(conv), "--adjudication", str(adj))
    assert code == 1
    assert verdict["status"] == "fail"


def _member_report(tmp_path: Path, name: str, findings: list[str]) -> Path:
    lines = ["# Member report", "", "## Minor Issues"]
    lines += [f"- {f}" for f in findings] or ["- (none)"]
    lines += ["", "## Verdict", "- ready for next milestone", "- Blocking issues: none", ""]
    p = tmp_path / name
    p.write_text("\n".join(lines), encoding="utf-8")
    return p


def test_identity_binding_catches_unrelated_row_padding(tmp_path: Path) -> None:
    # Arbitrary unique rows cannot stand in for the recorded findings.
    report_a = _member_report(
        tmp_path, "a.md", ["fixture hardening idea", "tolerance literal naming"]
    )
    report_b = _member_report(tmp_path, "b.md", [])
    conv = _convergence(
        tmp_path, a=2, b=0, source_a=str(report_a), source_b=str(report_b)
    )
    adj = _adjudication(
        tmp_path,
        [
            "| unrelated row one | A | fix now |",
            "| unrelated row two | A | fix now |",
        ],
    )
    code, verdict = _run(
        "--convergence-json", str(conv), "--adjudication", str(adj),
        "--member-report", str(report_a), "--member-report", str(report_b),
    )
    assert code == 1, verdict
    assert verdict["status"] == "fail"


def test_identity_binding_passes_with_matching_rows(tmp_path: Path) -> None:
    report_a = _member_report(
        tmp_path, "a.md", ["fixture hardening idea", "tolerance literal naming"]
    )
    report_b = _member_report(tmp_path, "b.md", ["extra negative control"])
    conv = _convergence(
        tmp_path, a=2, b=1, source_a=str(report_a), source_b=str(report_b)
    )
    adj = _adjudication(
        tmp_path,
        [
            "| **Fixture hardening idea** | A | discard: beyond declared scope |",
            "| tolerance literal naming | A | fix now |",
            "| extra negative control (B's suggestion) | B | acceptance point M3 |",
        ],
    )
    code, verdict = _run(
        "--convergence-json", str(conv), "--adjudication", str(adj),
        "--member-report", str(report_a), "--member-report", str(report_b),
    )
    assert code == 0, verdict
    assert verdict["status"] == "pass"
    assert verdict["binding"] == "identity"


def test_identity_binding_same_text_from_both_members_owes_two_rows(tmp_path: Path) -> None:
    report_a = _member_report(tmp_path, "a.md", ["shared hardening idea"])
    report_b = _member_report(tmp_path, "b.md", ["shared hardening idea"])
    conv = _convergence(
        tmp_path, a=1, b=1, source_a=str(report_a), source_b=str(report_b)
    )
    one_row = _adjudication(tmp_path, ["| shared hardening idea | A | fix now |"])
    code, verdict = _run(
        "--convergence-json", str(conv), "--adjudication", str(one_row),
        "--member-report", str(report_a), "--member-report", str(report_b),
    )
    assert code == 1, verdict
    two_rows = _adjudication(
        tmp_path,
        [
            "| shared hardening idea | A | fix now |",
            "| shared hardening idea | B | fix now |",
        ],
    )
    code, verdict = _run(
        "--convergence-json", str(conv), "--adjudication", str(two_rows),
        "--member-report", str(report_a), "--member-report", str(report_b),
    )
    assert code == 0, verdict


def test_substituted_member_reports_are_rejected(tmp_path: Path) -> None:
    # The supplied reports must be exactly the reports the convergence gate
    # read; a substituted pair with fabricated findings is an input error.
    real_a = _member_report(tmp_path, "real_a.md", ["real finding one", "real finding two"])
    real_b = _member_report(tmp_path, "real_b.md", [])
    conv = _convergence(
        tmp_path, a=2, b=0, source_a=str(real_a), source_b=str(real_b)
    )
    fake_a = _member_report(tmp_path, "fake_a.md", ["fake issue 1", "fake issue 2"])
    fake_b = _member_report(tmp_path, "fake_b.md", [])
    adj = _adjudication(
        tmp_path,
        ["| fake issue 1 | A | fix now |", "| fake issue 2 | A | fix now |"],
    )
    code, verdict = _run(
        "--convergence-json", str(conv), "--adjudication", str(adj),
        "--member-report", str(fake_a), "--member-report", str(fake_b),
    )
    assert code == 2, verdict
    assert verdict["status"] == "input_error"


def test_reports_supplied_but_no_recorded_paths_is_input_error(tmp_path: Path) -> None:
    report_a = _member_report(tmp_path, "a.md", ["one finding"])
    report_b = _member_report(tmp_path, "b.md", [])
    conv = _convergence(tmp_path, a=1, b=0)  # no source_path recorded
    adj = _adjudication(tmp_path, ["| one finding | A | fix now |"])
    code, verdict = _run(
        "--convergence-json", str(conv), "--adjudication", str(adj),
        "--member-report", str(report_a), "--member-report", str(report_b),
    )
    assert code == 2, verdict
    assert verdict["status"] == "input_error"


def test_two_phase_matching_handles_substring_findings(tmp_path: Path) -> None:
    # "tests" and "more tests" with rows "more tests" and "tests (context)"
    # have a valid assignment; naive greedy order would fail it.
    report_a = _member_report(tmp_path, "a.md", ["tests", "more tests"])
    report_b = _member_report(tmp_path, "b.md", [])
    conv = _convergence(
        tmp_path, a=2, b=0, source_a=str(report_a), source_b=str(report_b)
    )
    adj = _adjudication(
        tmp_path,
        ["| more tests | A | fix now |", "| tests (context) | A | fix now |"],
    )
    code, verdict = _run(
        "--convergence-json", str(conv), "--adjudication", str(adj),
        "--member-report", str(report_a), "--member-report", str(report_b),
    )
    assert code == 0, verdict


def test_count_fallback_still_guards_without_reports(tmp_path: Path) -> None:
    conv = _convergence(tmp_path, a=2, b=0)
    adj = _adjudication(tmp_path, ["| only one | A | fix now |"])
    code, verdict = _run("--convergence-json", str(conv), "--adjudication", str(adj))
    assert code == 1, verdict
    assert verdict["status"] == "fail"


def test_absent_minor_count_key_is_contract_drift(tmp_path: Path) -> None:
    # The team convergence gate always emits the field; per the repository's
    # no-backward-compatibility invariant an absent key is contract drift,
    # never an implicit zero.
    payload = _convergence_payload(a=0, b=0)
    del payload["report_status"]["member_a"]["minor_issues_count"]
    del payload["report_status"]["member_b"]["minor_issues_count"]
    p = tmp_path / "convergence.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    code, verdict = _run("--convergence-json", str(p))
    assert code == 2, verdict
    assert verdict["status"] == "input_error"


def test_unreadable_convergence_is_input_error(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text("{not json", encoding="utf-8")
    code, verdict = _run("--convergence-json", str(p))
    assert code == 2
    assert verdict["status"] == "input_error"
