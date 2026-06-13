"""Contract + behavioral tests for the scaffolded codex runner asset.

The asset `assets/run_codex.sh` is copied verbatim into every scaffolded
project (`scaffold_research_workflow.sh`) and invoked as research-team
member_b's runner. It previously hard-failed on the well-documented
"codex exits 0 but writes an empty --output-last-message file" mode with no
retry, which lost member_b cycles. These tests lock in:

1. the resilience contract (retry loop + `--max-retries` so
   `run_member_review.py`'s feature-detection enables overrides), and
2. that the preserved CLI surface the consumers depend on is unchanged, and
3. the actual retry behaviour, by stubbing `codex` on PATH.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
RUN_CODEX = SKILL_ROOT / "assets" / "run_codex.sh"


def _text() -> str:
    return RUN_CODEX.read_text(encoding="utf-8")


def test_runner_declares_retry_flags_for_feature_detection() -> None:
    # run_member_review.py gates retry-flag pass-through on the runner text
    # containing "--max-retries"; without it, fast-mode overrides silently no-op.
    t = _text()
    assert "--max-retries" in t
    assert "--sleep-secs" in t


def test_runner_has_exponential_backoff_retry_loop() -> None:
    t = _text()
    assert "2 ** (attempt - 1)" in t, "exponential backoff missing"
    assert "retrying in" in t, "retry messaging missing"
    assert "attempt=$(( attempt + 1 ))" in t, "attempt counter missing"


def test_runner_retries_on_exit0_empty_output() -> None:
    # The specific regression: exit 0 + empty output must be treated as a
    # retry-able failure, not success and not an immediate hard-exit.
    t = _text()
    assert '${code} -eq 0 && -s "${OUT}"' in t, "success requires non-empty output"
    assert "empty output" in t
    # the old non-retrying hard exit must be gone
    assert "codex produced empty output" not in t


def test_runner_preserves_consumer_cli_surface() -> None:
    # run_member_review.py passes these for runner_kind=codex; do not break them.
    t = _text()
    for flag in ("--system-prompt-file", "--prompt-file", "--out", "--reasoning-effort", "--model"):
        assert flag in t, f"consumer CLI flag {flag} missing"
    # execution behaviour the member_b clean-room auditor depends on
    assert "--output-last-message" in t
    assert "--sandbox read-only" in t
    assert 'approval_policy="never"' in t


def _write_codex_stub(stub_dir: Path, state_file: Path, succeed_on: int) -> None:
    stub = stub_dir / "codex"
    stub.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'out=""\n'
        'prev=""\n'
        'for a in "$@"; do\n'
        '  if [[ "$prev" == "--output-last-message" ]]; then out="$a"; fi\n'
        '  prev="$a"\n'
        "done\n"
        "cat >/dev/null\n"  # consume the piped prompt
        f'state="{state_file}"\n'
        f"succeed_on={succeed_on}\n"
        "n=0\n"
        '[[ -f "$state" ]] && n=$(cat "$state")\n'
        "n=$((n+1))\n"
        'echo "$n" >"$state"\n'
        'if [[ "$n" -ge "$succeed_on" && -n "$out" ]]; then printf \'ok\' >"$out"; fi\n'
        "exit 0\n",
        encoding="utf-8",
    )
    stub.chmod(0o755)


def _run(tmp_path: Path, stub_dir: Path, max_retries: int) -> subprocess.CompletedProcess:
    sys_f = tmp_path / "sys.txt"
    sys_f.write_text("system", encoding="utf-8")
    prompt_f = tmp_path / "prompt.txt"
    prompt_f.write_text("task", encoding="utf-8")
    out_f = tmp_path / "out.md"
    env = dict(os.environ)
    env["PATH"] = f"{stub_dir}{os.pathsep}{env['PATH']}"
    return subprocess.run(
        [
            "bash", str(RUN_CODEX),
            "--system-prompt-file", str(sys_f),
            "--prompt-file", str(prompt_f),
            "--out", str(out_f),
            "--max-retries", str(max_retries),
            "--sleep-secs", "0",
        ],
        env=env, capture_output=True, text=True,
    )


def test_behaviour_exhausts_retries_then_fails(tmp_path: Path) -> None:
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    state = tmp_path / "calls"
    _write_codex_stub(stub_dir, state, succeed_on=999)  # never writes output
    proc = _run(tmp_path, stub_dir, max_retries=3)
    assert proc.returncode != 0, proc.stderr
    assert state.read_text().strip() == "3", "should attempt exactly --max-retries times"
    assert not (tmp_path / "out.md").exists() or (tmp_path / "out.md").stat().st_size == 0


def test_behaviour_recovers_on_later_attempt(tmp_path: Path) -> None:
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    state = tmp_path / "calls"
    _write_codex_stub(stub_dir, state, succeed_on=2)  # empty once, then succeeds
    proc = _run(tmp_path, stub_dir, max_retries=5)
    assert proc.returncode == 0, proc.stderr
    assert state.read_text().strip() == "2", "should stop retrying once output is non-empty"
    assert (tmp_path / "out.md").read_text() == "ok"
