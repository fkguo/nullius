"""Deterministic-failure classification tests for the codex-cli-runner retry loop.

`run_codex.sh` retries with exponential backoff on TRANSIENT failures, but a
deterministic failure (usage error, unbound variable, auth/region
ineligibility, ...) reproduces identically on every retry. The runner
classifies the TAIL 40 lines of the combined stdout+stderr attempt log after a
non-zero exit (codex exec streams prompt and agent text into the same log, so
only the tail is a safe grep surface) and fails immediately with the
diagnostic instead of burning the backoff budget.

These tests drive the real retry loop against a fake `codex` CLI on PATH
(sibling suites' fake-CLI convention) and count invocations through a counter
file the fake appends to.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = SKILL_DIR / "scripts" / "run_codex.sh"


def _write_fake_codex(bin_dir: Path) -> Path:
    fake = bin_dir / "codex"
    fake.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

mode="${FAKE_MODE:-success}"
count_file="${FAKE_COUNT_FILE:-}"

# Count every invocation so tests can assert how many times the runner
# actually called the CLI (deterministic failure => exactly once).
call_index=1
if [[ -n "${count_file}" ]]; then
  printf 'x\\n' >>"${count_file}"
  call_index="$(wc -l <"${count_file}" | tr -d '[:space:]')"
fi

# First positional is the `exec` subcommand.
if [[ "${1:-}" == "exec" ]]; then
  shift
fi

out_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      out_file="${2:-}"
      shift 2
      ;;
    -m|-c|-p|--sandbox)
      shift 2
      ;;
    --skip-git-repo-check|-)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# Consume the stdin prompt like the real CLI.
cat >/dev/null || true

case "${mode}" in
  deterministic_unbound_variable)
    echo "codex banner line"
    echo "codex: line 1: CODEX_FAKE_VAR: unbound variable" >&2
    exit 1
    ;;
  transient_reset_then_success)
    if [[ "${call_index}" -le 1 ]]; then
      echo "stream error: connection reset by peer" >&2
      exit 1
    fi
    if [[ -n "${out_file}" ]]; then
      printf 'OK_RETRY\\n' >"${out_file}"
    fi
    echo "session id: 00000000-0000-0000-0000-000000000000"
    exit 0
    ;;
  *)
    if [[ -n "${out_file}" ]]; then
      printf 'OK_DEFAULT\\n' >"${out_file}"
    fi
    exit 0
    ;;
esac
""",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    return fake


def _run_runner(
    tmp_path: Path,
    *,
    args: list[str],
    fake_mode: str,
    prompt_text: str = "hello\n",
) -> tuple[subprocess.CompletedProcess[str], Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    _write_fake_codex(bin_dir)

    prompt = tmp_path / "prompt.txt"
    prompt.write_text(prompt_text, encoding="utf-8")
    out = tmp_path / "out.txt"

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["FAKE_MODE"] = fake_mode
    env["FAKE_COUNT_FILE"] = str(tmp_path / "fake_codex_calls.log")

    cmd = [
        "bash",
        str(RUNNER),
        "--prompt-file",
        str(prompt),
        "--out",
        str(out),
        "--max-retries",
        "3",
        "--sleep-secs",
        "0",
        *args,
    ]
    proc = subprocess.run(cmd, text=True, capture_output=True, env=env, check=False)
    return proc, out


def _out_text(out_path: Path) -> str:
    if not out_path.exists():
        return ""
    return out_path.read_text(encoding="utf-8")


def _fake_call_count(tmp_path: Path) -> int:
    count_file = tmp_path / "fake_codex_calls.log"
    if not count_file.exists():
        return 0
    return len(count_file.read_text(encoding="utf-8").splitlines())


def test_deterministic_diagnostic_in_log_tail_fails_immediately(tmp_path: Path) -> None:
    # The diagnostic lands in the tail of the combined attempt log (stderr is
    # merged into it by the runner): the retry loop must stop after ONE
    # attempt even though --max-retries allows more.
    proc, out_path = _run_runner(
        tmp_path,
        args=[],
        fake_mode="deterministic_unbound_variable",
    )
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert _fake_call_count(tmp_path) == 1, "deterministic failure must fail on the first attempt"
    assert "Codex failed with a deterministic error" in proc.stderr
    assert "unbound variable" in proc.stderr
    assert _out_text(out_path) == ""


def test_transient_failure_still_retries_then_succeeds(tmp_path: Path) -> None:
    # Negative control: a transient-looking failure (connection reset, exit 1)
    # must NOT be classified as deterministic — the existing retry loop still
    # runs and recovers on the second attempt.
    proc, out_path = _run_runner(
        tmp_path,
        args=[],
        fake_mode="transient_reset_then_success",
    )
    assert proc.returncode == 0, proc.stderr
    assert _fake_call_count(tmp_path) == 2, "transient failure must keep the retry budget"
    assert "retrying in" in proc.stderr
    assert _out_text(out_path) == "OK_RETRY\n"
