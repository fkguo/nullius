"""Deterministic-failure classification tests for the claude-cli-runner.

`run_claude.sh` retries with exponential backoff on TRANSIENT failures, but a
deterministic failure (usage error, unbound variable, invalid API key, region
ineligibility, ...) reproduces identically on every retry. Inside its retry
loop the runner classifies STDERR after a non-zero exit and fails immediately
with the diagnostic instead of burning the backoff budget.

The behavioral tests drive the real retry loop against a fake `claude` CLI on
PATH (the fake-CLI convention of the sibling *-cli-runner suites) and count
invocations through the call log the fake appends to.

This module also carries the cross-runner consistency lock: the
`classify_deterministic_failure` function is duplicated VERBATIM in all five
*-cli-runner scripts (cross-skill imports are forbidden; each skill must stay
self-contained), and `test_classifier_is_byte_identical_across_all_five_runners`
fails as soon as any copy drifts.
"""

from __future__ import annotations

import difflib
import os
import subprocess
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
SKILLS_ROOT = SKILL_DIR.parent
RUNNER = SKILL_DIR / "scripts" / "run_claude.sh"

# All five runner scripts that must carry a byte-identical copy of
# classify_deterministic_failure (comment header included).
RUNNER_SCRIPTS = {
    "claude-cli-runner": SKILLS_ROOT / "claude-cli-runner" / "scripts" / "run_claude.sh",
    "codex-cli-runner": SKILLS_ROOT / "codex-cli-runner" / "scripts" / "run_codex.sh",
    "gemini-cli-runner": SKILLS_ROOT / "gemini-cli-runner" / "scripts" / "run_gemini.sh",
    "opencode-cli-runner": SKILLS_ROOT / "opencode-cli-runner" / "scripts" / "run_opencode.sh",
    "kimi-cli-runner": SKILLS_ROOT / "kimi-cli-runner" / "scripts" / "run_kimi.sh",
}

# Extraction markers for the shared classifier block (documented contract):
# the block STARTS at the comment line beginning with CLASSIFIER_HEADER_PREFIX,
# runs through a contiguous comment header into the function opener line
# CLASSIFIER_OPENER, and ENDS at the first subsequent line that is exactly "}"
# at column 0 (the scripts keep all inner lines of the function indented).
CLASSIFIER_HEADER_PREFIX = "# Deterministic-failure classifier"
CLASSIFIER_OPENER = "classify_deterministic_failure() {"


def _write_fake_claude(bin_dir: Path) -> Path:
    fake = bin_dir / "claude"
    fake.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

mode="${FAKE_MODE:-success}"
log_file="${FAKE_LOG:-}"
state_file="${FAKE_STATE:-}"

if [[ -n "${log_file}" ]]; then
  printf 'args=' >>"${log_file}"
  printf '%q ' "$@" >>"${log_file}"
  printf '\\n' >>"${log_file}"
fi

# Consume the stdin prompt like the real CLI.
cat >/dev/null || true

case "${mode}" in
  deterministic_invalid_api_key)
    echo 'API Error: 401 {"error":{"type":"authentication_error","message":"invalid api key"}}' >&2
    exit 1
    ;;
  connection_reset_once_then_success)
    if [[ -n "${state_file}" && ! -f "${state_file}" ]]; then
      printf 'failed\\n' >"${state_file}"
      echo 'fetch failed: connection reset by peer' >&2
      exit 1
    fi
    echo "OK_RETRY"
    ;;
  *)
    echo "OK_DEFAULT"
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
    system_text: str = "system\n",
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    _write_fake_claude(bin_dir)

    prompt = tmp_path / "prompt.txt"
    prompt.write_text(prompt_text, encoding="utf-8")
    system = tmp_path / "system.txt"
    system.write_text(system_text, encoding="utf-8")
    out = tmp_path / "out.txt"
    log = tmp_path / "fake_claude.log"

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["FAKE_MODE"] = fake_mode
    env["FAKE_LOG"] = str(log)
    env["FAKE_STATE"] = str(tmp_path / "fake_state")

    cmd = [
        "bash",
        str(RUNNER),
        "--system-prompt-file",
        str(system),
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
    return proc, out, log


def _out_text(out_path: Path) -> str:
    if not out_path.exists():
        return ""
    return out_path.read_text(encoding="utf-8")


def _log_text(log_path: Path) -> str:
    if not log_path.exists():
        return ""
    return log_path.read_text(encoding="utf-8")


# --- Behavioral contract (real retry loop against a fake CLI) ---


def test_deterministic_failure_is_not_retried(tmp_path: Path) -> None:
    # run_claude.sh classifies STDERR after a non-zero exit inside its retry
    # loop: a deterministic diagnostic must stop after ONE attempt even though
    # --max-retries allows more, and surface the classification on stderr.
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=[],
        fake_mode="deterministic_invalid_api_key",
    )
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert _log_text(log_path).count("args=") == 1, "deterministic failure must fail on the first attempt"
    assert "Claude failed with a deterministic error" in proc.stderr
    assert "invalid api key" in proc.stderr
    assert _out_text(out_path) == ""


def test_transient_failure_still_retries_then_succeeds(tmp_path: Path) -> None:
    # Negative control: a transient-looking failure (connection reset, exit 1)
    # must NOT be classified as deterministic — the existing retry loop still
    # runs and recovers on the second attempt.
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=[],
        fake_mode="connection_reset_once_then_success",
    )
    assert proc.returncode == 0, proc.stderr
    assert _log_text(log_path).count("args=") == 2, "transient failure must keep the retry budget"
    assert "retrying in" in proc.stderr
    assert _out_text(out_path) == "OK_RETRY\n"


# --- Cross-runner consistency lock ---


def _extract_classifier_block(script: Path) -> str:
    """Extract the shared classifier block from a runner script.

    Markers: from the comment line starting with CLASSIFIER_HEADER_PREFIX,
    through the contiguous '#' comment header and the CLASSIFIER_OPENER line,
    to the first following line that is exactly '}' at column 0.
    """
    lines = script.read_text(encoding="utf-8").splitlines()

    header_idxs = [i for i, line in enumerate(lines) if line.startswith(CLASSIFIER_HEADER_PREFIX)]
    assert len(header_idxs) == 1, (
        f"{script}: expected exactly one '{CLASSIFIER_HEADER_PREFIX}' header, found {len(header_idxs)}"
    )
    start = header_idxs[0]

    opener_idxs = [i for i, line in enumerate(lines) if line == CLASSIFIER_OPENER]
    assert len(opener_idxs) == 1, (
        f"{script}: expected exactly one '{CLASSIFIER_OPENER}' definition, found {len(opener_idxs)}"
    )
    opener = opener_idxs[0]
    assert opener > start, f"{script}: classifier header must precede the function definition"
    for i in range(start, opener):
        assert lines[i].startswith("#"), (
            f"{script}: line {i + 1} interrupts the classifier comment header: {lines[i]!r}"
        )

    close = next((i for i in range(opener + 1, len(lines)) if lines[i] == "}"), None)
    assert close is not None, f"{script}: no closing brace found for classify_deterministic_failure"

    return "\n".join(lines[start : close + 1]) + "\n"


def test_classifier_is_byte_identical_across_all_five_runners() -> None:
    """Lock: classify_deterministic_failure is byte-identical in all five runners.

    The deterministic-failure classifier is intentionally DUPLICATED (verbatim,
    comment header included) in:

      skills/claude-cli-runner/scripts/run_claude.sh
      skills/codex-cli-runner/scripts/run_codex.sh
      skills/gemini-cli-runner/scripts/run_gemini.sh
      skills/opencode-cli-runner/scripts/run_opencode.sh
      skills/kimi-cli-runner/scripts/run_kimi.sh

    because cross-skill imports are forbidden (each skill must stay
    self-contained). THE RULE: whoever edits the classifier in ONE script must
    apply the same byte-for-byte edit to ALL FIVE. This test extracts the block
    (from its '# Deterministic-failure classifier' comment header through the
    function's closing brace) from every script and fails on the first copy
    that drifts from the others.
    """
    for name, script in RUNNER_SCRIPTS.items():
        assert script.is_file(), f"{name}: runner script not found at {script}"

    blocks = {name: _extract_classifier_block(script) for name, script in RUNNER_SCRIPTS.items()}

    reference_name = "claude-cli-runner"
    reference = blocks[reference_name]

    # Guard the extraction itself: a degenerate match must not pass silently.
    assert 'case "${code}" in' in reference
    assert "'invalid api key'" in reference

    for name, block in blocks.items():
        if block == reference:
            continue
        diff = "\n".join(
            difflib.unified_diff(
                reference.splitlines(),
                block.splitlines(),
                fromfile=str(RUNNER_SCRIPTS[reference_name]),
                tofile=str(RUNNER_SCRIPTS[name]),
                lineterm="",
            )
        )
        raise AssertionError(
            f"classify_deterministic_failure in {name} diverged from {reference_name}; "
            f"the five copies must stay byte-identical (edit one -> update all five).\n{diff}"
        )
