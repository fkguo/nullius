"""Witnesses that a Claude lane carries only its own request, not the operator's context.

Without ``--safe-mode`` the Claude CLI loads the operator's user-level instructions, CLAUDE.md and
AGENTS.md files of the working directory and its parents, the project's auto memory, plugins, hooks and
skills into every call. The runner passes ``--safe-mode`` by default (it keeps the login, unlike
``--bare``), records the allowed sources in ``context_sources.json`` and, under live capture, rejects a
lane whose init event still reports an auto-memory location.

The fake-CLI tests pin the flags and the records. The reduced-stream tests use the init events of two
real live-capture streams (fixtures/init_events_reduced.json: before and after the change, with
operator-specific names replaced by placeholders). The installed-CLI test checks that the local CLI
still offers the flag; it is skipped only when no ``claude`` executable is on PATH.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = SKILL_DIR / "scripts" / "run_claude.sh"
CONTEXT_SOURCES = SKILL_DIR / "scripts" / "context_sources.py"
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "init_events_reduced.json").read_text(encoding="utf-8"))
NOT_HERMETIC = 78

FAKE = r'''import json, os, sys
from pathlib import Path
sys.stdin.read()
with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as fp:
    fp.write(json.dumps(sys.argv[1:]) + "\n")
init = os.environ.get("FAKE_INIT")
text = "four"
def emit(obj):
    print(json.dumps(obj), flush=True)
if "--output-format" not in sys.argv:
    print(text)
    sys.exit(0)
if init:
    emit(json.loads(init))
emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "m1"}}})
emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
      "content_block": {"type": "text", "text": ""}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
      "delta": {"type": "text_delta", "text": text}}})
emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
emit({"type": "stream_event", "event": {"type": "message_stop"}})
emit({"type": "result", "subtype": "success", "is_error": False, "session_id": "s", "result": text})
'''


def _run(tmp_path: Path, *args: str, init: dict | None = None) -> tuple[subprocess.CompletedProcess[str], Path, list[list[str]]]:
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    cli = bindir / "claude"
    cli.write_text("#!" + sys.executable + "\n" + FAKE, encoding="utf-8")
    cli.chmod(0o755)
    (tmp_path / "system.txt").write_text("system\n", encoding="utf-8")
    (tmp_path / "prompt.txt").write_text("What is 2+2?\n", encoding="utf-8")
    out = tmp_path / "out.txt"
    log = tmp_path / "calls.jsonl"
    env = {**os.environ, "PATH": f"{bindir}:{os.environ.get('PATH', '')}", "FAKE_LOG": str(log)}
    if init is not None:
        env["FAKE_INIT"] = json.dumps(init)
    proc = subprocess.run(
        ["bash", str(RUNNER), "--system-prompt-file", str(tmp_path / "system.txt"),
         "--prompt-file", str(tmp_path / "prompt.txt"), "--out", str(out),
         "--max-retries", "3", "--sleep-secs", "0", *args],
        text=True, capture_output=True, env=env, check=False)
    calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []
    return proc, out, calls


def _record(out: Path, name: str) -> dict:
    found = sorted(Path(str(out) + ".attempts").glob(f"run.*/{name}"))
    assert len(found) == 1, found
    return json.loads(found[0].read_text(encoding="utf-8"))


def test_runner_starts_every_lane_in_safe_mode_by_default(tmp_path: Path) -> None:
    proc, out, calls = _run(tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert len(calls) == 1 and "--safe-mode" in calls[0]
    assert out.read_text(encoding="utf-8") == "four\n"
    declared = _record(out, "context_sources.json")
    assert declared["hermetic"] is True and declared["mechanism"] == "--safe-mode"
    assert any("auto memory" in item for item in declared["excluded"])
    assert any("AGENTS.md" in item for item in declared["excluded"])
    assert any("user-level" in item for item in declared["excluded"])
    assert declared["per_call_observation"] == "unavailable without live capture"


def test_operator_context_is_loaded_only_on_explicit_request_and_recorded(tmp_path: Path) -> None:
    proc, out, calls = _run(tmp_path, "--load-operator-context")
    assert proc.returncode == 0, proc.stderr
    assert "--safe-mode" not in calls[0]
    declared = _record(out, "context_sources.json")
    assert declared["hermetic"] is False and declared["excluded"] == []


def test_dry_run_shows_the_flag_the_real_call_passes(tmp_path: Path) -> None:
    proc, _, calls = _run(tmp_path, "--dry-run")
    assert proc.returncode == 0 and calls == []
    invocation = next(line for line in proc.stdout.splitlines() if line.startswith("  claude --print"))
    assert " --safe-mode " in invocation
    assert "Operator context: excluded" in proc.stdout
    proc, _, _ = _run(tmp_path, "--dry-run", "--load-operator-context")
    assert "--safe-mode" not in next(l for l in proc.stdout.splitlines() if l.startswith("  claude --print"))


def test_live_lane_with_the_reduced_safe_mode_init_event_is_accepted(tmp_path: Path) -> None:
    proc, out, calls = _run(tmp_path, "--live-capture", init=FIXTURE["safe_mode"])
    assert proc.returncode == 0, proc.stderr
    assert "--safe-mode" in calls[0]
    assert out.read_text(encoding="utf-8") == "four"
    observed = _record(out, "attempt_1.context_observed.json")
    assert observed["verdict"] == "hermetic" and observed["memory_paths"] == [] and observed["init_event_seen"]
    assert _record(out, "context_sources.json")["per_call_observation"].startswith("init event memory_paths")


def test_live_lane_reporting_operator_memory_is_rejected_not_retried(tmp_path: Path) -> None:
    proc, out, calls = _run(tmp_path, "--live-capture", init=FIXTURE["operator"])
    assert proc.returncode == NOT_HERMETIC, proc.stderr
    assert len(calls) == 1, "a lane that loaded operator memory would load it again; no retry"
    assert "operator memory entered the lane" in proc.stderr
    assert not out.exists() and Path(str(out) + ".not-hermetic").read_text(encoding="utf-8") == "four"
    observed = _record(out, "attempt_1.context_observed.json")
    assert observed["verdict"] == "not_hermetic" and observed["memory_paths"]


def test_successful_live_lane_without_init_event_is_rejected(tmp_path: Path) -> None:
    proc, out, _ = _run(tmp_path, "--live-capture")
    assert proc.returncode == NOT_HERMETIC, proc.stderr
    assert "exclusion was not observed" in proc.stderr
    assert not out.exists()


def test_operator_mode_records_memory_without_rejecting(tmp_path: Path) -> None:
    proc, out, _ = _run(tmp_path, "--live-capture", "--load-operator-context", init=FIXTURE["operator"])
    assert proc.returncode == 0, proc.stderr
    observed = _record(out, "attempt_1.context_observed.json")
    assert observed["verdict"] == "not_required" and observed["memory_paths"]


def test_reduced_real_init_events_separate_hermetic_from_operator_lanes() -> None:
    """The safe-mode init event lists no memory and no operator- or plugin-provided skill or agent."""
    safe, operator = FIXTURE["safe_mode"], FIXTURE["operator"]
    assert "memory_paths" not in safe and operator["memory_paths"]["auto"]
    for listing in ("skills", "agents"):
        assert not [n for n in safe[listing] if n.startswith("operator-") or ":" in n], listing
        assert [n for n in operator[listing] if n.startswith("operator-") or ":" in n], listing
    assert safe["apiKeySource"] == "none", "the measured lane ran on the login, not an API key"


def test_installed_cli_offers_safe_mode() -> None:
    claude = shutil.which("claude")
    if claude is None:
        pytest.skip("no claude CLI on PATH")
    proc = subprocess.run([claude, "--help"], text=True, capture_output=True, check=False, timeout=60)
    assert "--safe-mode" in proc.stdout, "the installed Claude CLI no longer offers --safe-mode"
