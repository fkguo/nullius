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


def _convergence(tmp_path: Path, *, status: str = "converged", a: int = 2, b: int = 1) -> Path:
    payload = {
        "status": status,
        "report_status": {
            "member_a": {"verdict": "ready", "minor_issues_count": a},
            "member_b": {"verdict": "ready", "minor_issues_count": b},
        },
    }
    p = tmp_path / "convergence.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
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


def test_unreadable_convergence_is_input_error(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text("{not json", encoding="utf-8")
    code, verdict = _run("--convergence-json", str(p))
    assert code == 2
    assert verdict["status"] == "input_error"
