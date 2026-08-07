"""The team cycle stamps a run's code origin at creation.

Run-directory creation is a mandatory machine moment: measured adoption
showed that stamping left to a remembered second command simply does not
happen (hundreds of runs later reconstructed heuristically). These tests pin
(a) the stamp block sits between run-dir creation and the first phase work,
(b) the launcher is invoked with the project root and the absolute run dir —
    unconditionally: re-entry idempotency lives in the ledger-locked stamp
    writer (one stamp per run id), never in an on-disk mirror check the
    ledger does not vouch for,
(c) a failing or missing launcher warns and never aborts the cycle.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
RUN_TEAM_CYCLE = SKILL_ROOT / "scripts" / "bin" / "run_team_cycle.sh"

BLOCK_START = 'NULLIUS_LAUNCHER="${PROJECT_ROOT}/.nullius/bin/nullius"'


def _stamp_block(script: str) -> str:
    start = script.find(BLOCK_START)
    assert start != -1, "missing origin-stamp block (NULLIUS_LAUNCHER anchor)"
    # The block is the if/elif/fi that immediately follows the anchor; inner
    # if-bodies are indented, so the top-level closer is the first `fi` at
    # column zero.
    end = script.find("\nfi\n", start)
    assert end != -1
    return script[start : end + len("\nfi\n")]


def test_stamp_block_sits_between_run_dir_creation_and_cycle_trap() -> None:
    script = RUN_TEAM_CYCLE.read_text(encoding="utf-8")
    mkdir_idx = script.find('run_dir="${OUT_DIR}/runs/${safe_tag}"')
    stamp_idx = script.find(BLOCK_START)
    trap_idx = script.find("trap on_exit EXIT")
    assert mkdir_idx != -1 and stamp_idx != -1 and trap_idx != -1
    assert mkdir_idx < stamp_idx < trap_idx


def test_stamp_block_never_exits_the_cycle_on_failure() -> None:
    block = _stamp_block(RUN_TEAM_CYCLE.read_text(encoding="utf-8"))
    assert "exit" not in block, "the stamp is bookkeeping, not a gate: no exit paths allowed"
    assert "WARNING" in block


def _run_block(tmp_path: Path, *, launcher_body: str | None) -> subprocess.CompletedProcess[str]:
    project_root = tmp_path / "proj"
    run_dir = project_root / "team" / "runs" / "tag-r1"
    run_dir.mkdir(parents=True)
    calls = tmp_path / "calls.log"
    if launcher_body is not None:
        launcher = project_root / ".nullius" / "bin" / "nullius"
        launcher.parent.mkdir(parents=True)
        launcher.write_text(
            "#!/usr/bin/env bash\n"
            f"echo \"$@\" >> {calls}\n" + launcher_body,
            encoding="utf-8",
        )
        launcher.chmod(0o755)

    block = _stamp_block(RUN_TEAM_CYCLE.read_text(encoding="utf-8"))
    # Same shell options as the production script (set -euo pipefail): the
    # no-exit-on-failure property must hold under -e, not only under the
    # text lock.
    driver = (
        "set -euo pipefail\n"
        f"PROJECT_ROOT={project_root}\n"
        f"run_dir=team/runs/tag-r1\n"
        f"run_dir_abs={run_dir}\n"
        f"{block}"
        "echo CYCLE_CONTINUED\n"
    )
    return subprocess.run(
        ["bash", "-c", driver],
        capture_output=True,
        text=True,
        cwd=project_root,
        check=False,
    )


def test_launcher_invoked_once_with_project_root_and_absolute_run_dir(tmp_path: Path) -> None:
    result = _run_block(
        tmp_path,
        launcher_body='echo "stamped tag-r1: exact_clean @ abc"\nexit 0\n',
    )
    assert result.returncode == 0
    assert "CYCLE_CONTINUED" in result.stdout
    assert "[trace] origin stamped tag-r1" in result.stdout
    calls = (tmp_path / "calls.log").read_text(encoding="utf-8").strip().splitlines()
    assert len(calls) == 1
    call = calls[0]
    assert f"--project-root {tmp_path / 'proj'}" in call
    assert "trace stamp" in call
    assert str(tmp_path / "proj" / "team" / "runs" / "tag-r1") in call


def test_reentry_invokes_the_idempotent_writer_and_continues(tmp_path: Path) -> None:
    # Re-entry semantics live in the stamp writer (ledger-idempotent): the
    # block always invokes it, and an already-stamped answer flows through
    # as a normal success. No mirror-file check may gate the invocation —
    # a crash-orphaned mirror without a ledger event must not suppress
    # stamping forever.
    result = _run_block(
        tmp_path,
        launcher_body='echo "already stamped tag-r1: exact_clean (existing stamp binds the same tracked code tree)"\nexit 0\n',
    )
    assert result.returncode == 0
    assert "CYCLE_CONTINUED" in result.stdout
    assert "[trace] origin already stamped tag-r1" in result.stdout
    calls = (tmp_path / "calls.log").read_text(encoding="utf-8").strip().splitlines()
    assert len(calls) == 1


def test_stamp_block_consults_no_mirror_file(tmp_path: Path) -> None:
    block = _stamp_block(RUN_TEAM_CYCLE.read_text(encoding="utf-8"))
    assert "run_origin.json" not in block, (
        "the ledger is the stamp authority; gating on a mirror file lets a "
        "crash-orphaned mirror suppress stamping forever"
    )


def test_failed_stamp_warns_and_continues(tmp_path: Path) -> None:
    result = _run_block(
        tmp_path,
        launcher_body='echo "boom" >&2\nexit 1\n',
    )
    assert result.returncode == 0
    assert "CYCLE_CONTINUED" in result.stdout
    assert "WARNING: origin stamp failed" in result.stderr
    assert "unstamped" in result.stderr


def test_missing_launcher_notes_and_continues(tmp_path: Path) -> None:
    result = _run_block(tmp_path, launcher_body=None)
    assert result.returncode == 0
    assert "CYCLE_CONTINUED" in result.stdout
    assert "no nullius launcher" in result.stderr
