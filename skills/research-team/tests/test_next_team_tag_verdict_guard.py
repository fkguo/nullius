#!/usr/bin/env python3
"""Round-advance guard: unavailability is not a round.

next_team_tag.py must warn (or refuse under --refuse-unverdicted) when the
latest existing round left report files but no verdict-bearing report — the
signature of an unavailability-terminated or crashed cycle. Advancing the
round suffix over such a round burns bounded-round capacity on a round that
never happened; the honest move is a same-tag --resume.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
TOOL = SKILL_ROOT / "scripts" / "bin" / "next_team_tag.py"

BASE = "20260801T000000Z-m1-topic"

VERDICT_REPORT = "# Review\n\n## Verdict\n\nready\n"
GARBAGE_REPORT = "backend unavailable; no verdict produced\n"


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _run(out_dir: Path, tag: str, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(TOOL), "--tag", tag, "--out-dir", str(out_dir), *extra],
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_no_prior_rounds_yields_r1_without_warning(tmp_path: Path) -> None:
    proc = _run(tmp_path, BASE)
    assert proc.returncode == 0
    assert proc.stdout.strip() == f"{BASE}-r1"
    assert "WARNING" not in proc.stderr


def test_verdict_bearing_latest_round_advances_without_warning(tmp_path: Path) -> None:
    _write(tmp_path / "runs" / f"{BASE}-r1" / f"{BASE}-r1_member_a.md", VERDICT_REPORT)
    proc = _run(tmp_path, BASE)
    assert proc.returncode == 0
    assert proc.stdout.strip() == f"{BASE}-r2"
    assert "WARNING" not in proc.stderr


def test_verdict_less_latest_round_warns_and_suggests_same_tag_resume(tmp_path: Path) -> None:
    _write(tmp_path / "runs" / f"{BASE}-r1" / f"{BASE}-r1_member_a.md", GARBAGE_REPORT)
    _write(tmp_path / "runs" / f"{BASE}-r1" / f"{BASE}-r1_member_b.md", GARBAGE_REPORT)
    proc = _run(tmp_path, BASE)
    assert proc.returncode == 0
    assert proc.stdout.strip() == f"{BASE}-r2"
    assert "WARNING" in proc.stderr
    assert "prefer resuming the SAME tag" in proc.stderr
    assert f"{BASE}-r1" in proc.stderr


def test_refuse_unverdicted_exits_3_and_emits_no_tag(tmp_path: Path) -> None:
    _write(tmp_path / "runs" / f"{BASE}-r1" / f"{BASE}-r1_member_a.md", GARBAGE_REPORT)
    proc = _run(tmp_path, BASE, "--refuse-unverdicted")
    assert proc.returncode == 3
    assert proc.stdout.strip() == ""
    assert "ERROR" in proc.stderr


def test_one_verdict_bearing_member_suffices(tmp_path: Path) -> None:
    """A round where one seat returned a verdict and the other failed is a
    real (partial) round — resuming it is handled by health-aware resume;
    the guard only fires when NO seat produced a verdict."""
    _write(tmp_path / "runs" / f"{BASE}-r1" / f"{BASE}-r1_member_a.md", GARBAGE_REPORT)
    _write(tmp_path / "runs" / f"{BASE}-r1" / f"{BASE}-r1_member_b.md", VERDICT_REPORT)
    proc = _run(tmp_path, BASE)
    assert proc.returncode == 0
    assert "WARNING" not in proc.stderr


def test_guard_looks_at_latest_round_only(tmp_path: Path) -> None:
    """A verdict-less OLD round does not warn once a later round carries a
    verdict; a verdict-less LATEST round warns even when earlier rounds were
    healthy."""
    _write(tmp_path / "runs" / f"{BASE}-r1" / f"{BASE}-r1_member_a.md", GARBAGE_REPORT)
    _write(tmp_path / "runs" / f"{BASE}-r2" / f"{BASE}-r2_member_a.md", VERDICT_REPORT)
    proc = _run(tmp_path, BASE)
    assert proc.returncode == 0
    assert "WARNING" not in proc.stderr

    _write(tmp_path / "runs" / f"{BASE}-r3" / f"{BASE}-r3_member_a.md", GARBAGE_REPORT)
    proc = _run(tmp_path, BASE)
    assert proc.returncode == 0
    assert proc.stdout.strip() == f"{BASE}-r4"
    assert "WARNING" in proc.stderr
    assert f"{BASE}-r3" in proc.stderr


def test_out_dir_root_fallback_layout_is_scanned(tmp_path: Path) -> None:
    """Older layouts keep reports at the out-dir root; the guard sees them."""
    _write(tmp_path / f"{BASE}-r1_member_a.md", GARBAGE_REPORT)
    proc = _run(tmp_path, BASE)
    assert proc.returncode == 0
    assert "WARNING" in proc.stderr


def test_unreadable_report_is_indeterminate_not_verdict_less(tmp_path: Path) -> None:
    """A permission-locked report (ungraceful-kill residue) is indeterminate:
    the guard neither warns with the resume suggestion nor refuses under the
    strict flag — it announces the indeterminate status and steps aside."""
    import os

    if os.geteuid() == 0:
        return  # root reads through permission bits; scenario unbuildable
    report = _write(
        tmp_path / "runs" / f"{BASE}-r1" / f"{BASE}-r1_member_a.md", VERDICT_REPORT
    )
    report.chmod(0)
    try:
        proc = _run(tmp_path, BASE)
        assert proc.returncode == 0
        assert proc.stdout.strip() == f"{BASE}-r2"
        assert "WARNING" not in proc.stderr
        assert "indeterminate" in proc.stderr
        strict = _run(tmp_path, BASE, "--refuse-unverdicted")
        assert strict.returncode == 0
        assert strict.stdout.strip() == f"{BASE}-r2"
    finally:
        report.chmod(0o644)
