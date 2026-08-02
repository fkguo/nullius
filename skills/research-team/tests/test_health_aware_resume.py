#!/usr/bin/env python3
"""Health-aware same-tag resume: the runner's resume branches reuse a member
seat's prior output only when the report passes the verdict health check —
a nonempty but verdict-less report (an unavailability-terminated or crashed
attempt) is moved aside (never deleted) and the seat re-dispatches.

Without this, a garbage report satisfies the old nonemptiness predicate and
the seat is skipped as "completed" on every future same-tag resume — the
machine leg of the "reviewer unavailability is a dispatch failure, not a
review round" placement rule.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
RUN_TEAM_CYCLE = SKILL_ROOT / "scripts" / "bin" / "run_team_cycle.sh"

HEALTHY_REPORT = """# Review

## Verdict

ready

## Sweep Semantics / Parameter Dependence

no sweep; baseline declared and constants held fixed
"""

GARBAGE_REPORT = """Reading additional input...
backend unavailable after 3 retries; no verdict produced
"""


def _shell_function_body(script: str, name: str) -> str:
    marker = f"{name}() {{"
    start = script.find(marker)
    assert start != -1, f"missing shell function {name}"
    i = start + len(marker)
    depth = 1
    while i < len(script):
        ch = script[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return script[start : i + 1]
        i += 1
    raise AssertionError(f"unterminated shell function {name}")


def _script_text() -> str:
    return RUN_TEAM_CYCLE.read_text(encoding="utf-8")


def _run_extracted(functions: list[str], body: str, *args: str) -> subprocess.CompletedProcess:
    script = _script_text()
    parts = [_shell_function_body(script, name) for name in functions]
    harness = "#!/bin/bash\nset -u\n" + "\n".join(parts) + f"\n{body}\n"
    return subprocess.run(
        ["bash", "-c", harness, "harness", *args],
        capture_output=True,
        text=True,
        timeout=60,
    )


# ------------------------------------------------- predicate behavior


def test_member_report_healthy_accepts_verdict_bearing_report(tmp_path: Path) -> None:
    report = tmp_path / "r.md"
    report.write_text(HEALTHY_REPORT, encoding="utf-8")
    proc = _run_extracted(
        ["member_report_healthy"], 'member_report_healthy "$1"', str(report)
    )
    assert proc.returncode == 0, proc.stderr


def test_member_report_healthy_rejects_verdict_less_report(tmp_path: Path) -> None:
    report = tmp_path / "r.md"
    report.write_text(GARBAGE_REPORT, encoding="utf-8")
    proc = _run_extracted(
        ["member_report_healthy"], 'member_report_healthy "$1"', str(report)
    )
    assert proc.returncode != 0


def test_member_report_healthy_rejects_missing_sweep_heading(tmp_path: Path) -> None:
    report = tmp_path / "r.md"
    report.write_text("## Verdict\n\nready\n", encoding="utf-8")
    proc = _run_extracted(
        ["member_report_healthy"], 'member_report_healthy "$1"', str(report)
    )
    assert proc.returncode != 0


def test_member_report_healthy_rejects_empty_and_absent(tmp_path: Path) -> None:
    empty = tmp_path / "empty.md"
    empty.write_text("", encoding="utf-8")
    for candidate in (str(empty), str(tmp_path / "absent.md")):
        proc = _run_extracted(
            ["member_report_healthy"], 'member_report_healthy "$1"', candidate
        )
        assert proc.returncode != 0


# ------------------------------------------------- move-aside behavior


def test_move_aside_preserves_content_and_removes_original(tmp_path: Path) -> None:
    report = tmp_path / "tag_member_a.md"
    report.write_text(GARBAGE_REPORT, encoding="utf-8")
    proc = _run_extracted(
        ["move_aside_unhealthy_report"],
        'move_aside_unhealthy_report "member-a" "$1"',
        str(report),
    )
    assert proc.returncode == 0, proc.stderr
    assert not report.exists()
    backups = list(tmp_path.glob("tag_member_a.md.unhealthy.*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == GARBAGE_REPORT
    assert "moved aside" in proc.stdout


def test_move_aside_never_deletes() -> None:
    body = _shell_function_body(_script_text(), "move_aside_unhealthy_report")
    assert "mv -f --" in body
    assert "rm " not in body


# ------------------------------------------------- resume wiring (structure)


def test_all_four_member_resume_conditions_are_health_gated() -> None:
    script = _script_text()
    expected_conditions = [
        # full_access seats: report + evidence + health
        'if [[ "${RESUME}" -eq 1 && -s "${member_a_out}" && -s "${member_a_evidence}" ]] '
        '&& member_report_healthy "${member_a_out}"; then',
        'if [[ "${RESUME}" -eq 1 && -s "${member_b_out}" && -s "${member_b_evidence}" ]] '
        '&& member_report_healthy "${member_b_out}"; then',
        # packet_only seats: report + health
        'if [[ "${RESUME}" -eq 1 && -s "${member_a_out}" ]] '
        '&& member_report_healthy "${member_a_out}"; then',
        'if [[ "${RESUME}" -eq 1 && -s "${member_b_out}" ]] '
        '&& member_report_healthy "${member_b_out}"; then',
    ]
    for condition in expected_conditions:
        assert condition in script, f"missing health-gated resume condition: {condition}"


def test_every_health_gated_branch_moves_the_unhealthy_report_aside() -> None:
    script = _script_text()
    assert script.count('move_aside_unhealthy_report "member-a"') == 2
    assert script.count('move_aside_unhealthy_report "member-b"') == 2


def test_sidecar_reuse_stays_on_nonemptiness() -> None:
    """Sidecar consultations carry no verdict contract: their reuse predicate
    deliberately stays nonemptiness, and no health check applies to them."""
    script = _script_text()
    assert 'if [[ "${RESUME}" -eq 1 && -s "${sc_out}" ]]; then' in script
    assert 'member_report_healthy "${sc_out}"' not in script
