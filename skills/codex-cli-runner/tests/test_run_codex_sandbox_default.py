"""Safety contract tests for the codex-cli-runner sandbox default.

`run_codex.sh` is the runner the cross-model review / derivation-verify lanes
invoke for codex reviewers, which assume a READ-ONLY reviewer. codex >=0.140
made `--full-auto` imply `--sandbox workspace-write`, so passing both
`--sandbox read-only` and `--full-auto` (the runner's old default) silently ran
codex with WORKSPACE WRITE access. These tests lock in that:

1. the runner never wires up the deprecated `--full-auto` flag, and
2. the default `--dry-run` invocation is read-only and non-interactive, and
3. an explicit write sandbox is still honored, and a bad value is rejected.

The `--dry-run` checks exercise the real arg-building path (CMD_ARGS) and exit
before the `codex` preflight, so they run without codex installed.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
RUN_CODEX = SKILL_ROOT / "scripts" / "run_codex.sh"


def _text() -> str:
    return RUN_CODEX.read_text(encoding="utf-8")


def _dry_run(tmp_path: Path, *extra: str) -> subprocess.CompletedProcess:
    prompt_f = tmp_path / "prompt.txt"
    prompt_f.write_text("task", encoding="utf-8")
    out_f = tmp_path / "out.md"
    return subprocess.run(
        [
            "bash", str(RUN_CODEX),
            "--prompt-file", str(prompt_f),
            "--out", str(out_f),
            "--dry-run",
            *extra,
        ],
        capture_output=True, text=True,
    )


def _invocation_line(stdout: str) -> str:
    for line in stdout.splitlines():
        if "codex exec" in line:
            return line
    raise AssertionError(f"no 'codex exec' invocation line in:\n{stdout}")


# --- Static contract ---


def test_full_auto_machinery_is_gone() -> None:
    t = _text()
    # The variable + flag handling that produced the override bug must be gone.
    assert "FULL_AUTO" not in t, "FULL_AUTO machinery must be removed"
    assert "(--full-auto)" not in t, "must never append --full-auto to codex args"
    assert "--full-auto)" not in t, "must not parse a --full-auto runner flag"


def test_read_only_default_and_pinned_approval() -> None:
    t = _text()
    assert 'SANDBOX="read-only"' in t, "default sandbox must be read-only"
    assert 'approval_policy="never"' in t, "non-interactivity must be pinned"


# --- Behavioral contract (real arg-building via --dry-run) ---


def test_default_dry_run_is_read_only_non_interactive(tmp_path: Path) -> None:
    proc = _dry_run(tmp_path)
    assert proc.returncode == 0, proc.stderr
    inv = _invocation_line(proc.stdout)
    assert "--sandbox read-only" in inv, inv
    assert 'approval_policy="never"' in inv, inv
    assert "--full-auto" not in inv, "default run must not request --full-auto"
    assert "workspace-write" not in inv, "default run must not escalate to write"


def test_explicit_workspace_write_is_honored(tmp_path: Path) -> None:
    proc = _dry_run(tmp_path, "--sandbox", "workspace-write")
    assert proc.returncode == 0, proc.stderr
    inv = _invocation_line(proc.stdout)
    assert "--sandbox workspace-write" in inv, inv
    assert "--full-auto" not in inv, "write mode must be reached via --sandbox, not --full-auto"


def test_invalid_sandbox_is_rejected(tmp_path: Path) -> None:
    proc = _dry_run(tmp_path, "--sandbox", "read_only")  # underscore typo
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "Invalid --sandbox" in proc.stderr


def test_removed_full_auto_flag_is_rejected(tmp_path: Path) -> None:
    # The old --full-auto / --no-full-auto runner flags are gone; passing them
    # should fail loudly rather than silently re-enabling the override.
    proc = _dry_run(tmp_path, "--full-auto")
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "Unknown arg" in proc.stderr
