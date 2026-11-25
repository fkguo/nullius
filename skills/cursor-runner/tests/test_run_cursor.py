from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

RUNNER = Path(__file__).resolve().parents[1] / "scripts/run_cursor.py"


@pytest.fixture
def request_files(tmp_path):
    client = tmp_path / "cursor"
    client.write_text("""#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import time

args = sys.argv[1:]
outcome = os.environ.get("FIXTURE_OUTCOME", "success")
if args == ["--list-models"]:
    if outcome == "list_timeout":
        subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
        print("started model-list child", flush=True)
        time.sleep(5)
    print("test-claude-id, test-gemini-id, test-grok-id")
    sys.exit(0)
assert args[:7] == ["--print", "--output-format", "stream-json", "--mode", "ask", "--sandbox", "enabled"]
assert args[7] == "--workspace" and Path(args[8]) == Path.cwd()
assert not list(Path.cwd().iterdir())
assert args[9] == "--trust" and args[10].startswith("--model=") and args[11] == "--"
assert sys.stdin.read() == ""
init = {"type": "system", "subtype": "init", "model": args[10].split("=", 1)[1],
        "session_id": "example-session"}
print(json.dumps(init), flush=True)
if outcome == "timeout":
    time.sleep(20)
if outcome == "partial":
    print('{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}')
    sys.exit(0)
if outcome == "model_error":
    print("Requested model is unavailable", file=sys.stderr)
    sys.exit(5)
result = {"type": "result", "subtype": "success", "is_error": False,
          "result": args[12], "session_id": "example-session"}
if outcome == "provider_error":
    result["is_error"] = True
if outcome == "wrong_session":
    result["session_id"] = "other-session"
print(json.dumps(result))
if outcome == "trailing":
    print("{truncated")
if outcome == "nonzero":
    sys.exit(7)
""")
    client.chmod(0o755)
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("--literal prompt with Unicode π\n", encoding="utf-8")
    instructions = tmp_path / "system.txt"
    instructions.write_text("Use a concise answer.", encoding="utf-8")
    out = tmp_path / "out.txt"
    return client, prompt, instructions, out


def invoke(files, *extra, outcome="success", model="test-grok-id"):
    client, prompt, instructions, out = files
    return subprocess.run(
        [sys.executable, str(RUNNER), "--cursor-bin", str(client), "--model", model,
         "--prompt-file", str(prompt), "--system-prompt-file", str(instructions),
         "--out", str(out), *extra],
        capture_output=True, text=True, timeout=8,
        env={**os.environ, "FIXTURE_OUTCOME": outcome},
    )


@pytest.mark.parametrize("model", ["test-claude-id", "test-gemini-id", "test-grok-id"])
def test_model_selection_and_terminal_result(request_files, tmp_path, model):
    _, prompt, instructions, out = request_files
    result = invoke(request_files, model=model)
    assert result.returncode == 0, result.stderr
    expected = f"{instructions.read_text()}\n\n{prompt.read_text()}"
    assert out.read_text(encoding="utf-8") == expected
    (trace,) = tmp_path.glob(".cursor-attempt-*")
    receipt = json.loads((trace / "receipt.json").read_text())
    assert receipt["requested_model"] == model == receipt["reported_model"]
    assert receipt["session_id"] == "example-session"
    assert receipt["output_sha256"] == hashlib.sha256(expected.encode()).hexdigest()


@pytest.mark.parametrize("outcome, code", [
    ("model_error", 5), ("partial", 12), ("trailing", 12),
    ("provider_error", 12), ("wrong_session", 12), ("nonzero", 7), ("timeout", 124),
])
def test_failures_keep_one_trace_and_no_final_output(request_files, tmp_path, outcome, code):
    result = invoke(request_files, "--timeout-secs", "1", outcome=outcome)
    assert result.returncode == code, result.stderr
    assert not request_files[-1].exists()
    (trace,) = tmp_path.glob(".cursor-attempt-*")
    assert (trace / "stderr.log").is_file()
    assert (trace / "receipt.json").is_file()
    assert (trace / "stdout.jsonl").read_text().count('"subtype": "init"') == 1


def test_list_models_and_dry_run(request_files, tmp_path):
    client, prompt, _, out = request_files
    result = subprocess.run([sys.executable, str(RUNNER), "--cursor-bin", str(client), "--list-models"],
                            capture_output=True, text=True, timeout=5)
    assert result.returncode == 0 and "test-gemini-id" in result.stdout
    result = invoke(request_files, "--dry-run")
    assert result.returncode == 0
    assert prompt.read_text().strip() not in result.stdout
    assert json.loads(result.stdout)["requested_model"] == "test-grok-id"
    assert not out.exists() and not list(tmp_path.glob(".cursor-attempt-*"))


def test_model_listing_timeout_closes_descendants_inheriting_output(request_files):
    client, _, _, _ = request_files
    result = subprocess.run(
        [sys.executable, str(RUNNER), "--cursor-bin", str(client), "--list-models", "--timeout-secs", "1"],
        capture_output=True, text=True, timeout=4,
        env={**os.environ, "FIXTURE_OUTCOME": "list_timeout"},
    )
    assert result.returncode == 124
    assert result.stdout == "started model-list child\n"


def test_start_failure_records_attempt_diagnostics(request_files, tmp_path):
    client, _, _, out = request_files
    client.write_text(f"#!{tmp_path / 'missing-interpreter'}\n")
    result = invoke(request_files)
    assert result.returncode == 2
    assert not out.exists()
    (trace,) = tmp_path.glob(".cursor-attempt-*")
    receipt = json.loads((trace / "receipt.json").read_text())
    assert receipt["cursor_exit_code"] == 2
    assert receipt["launch_error"] in (trace / "stderr.log").read_text()


def test_linux_process_scan_handles_non_utf8_names(monkeypatch):
    spec = importlib.util.spec_from_file_location("cursor_process_budget", RUNNER.with_name("process_budget.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    proc_stats = {
        "/proc/10/stat": b"10 (unrelated\xff) S 1 10 1\n",
        "/proc/20/stat": b"20 (group) Z 1 20 1\n",
        "/proc/30/stat": b"30 (worker) with parenthesis\xff) S 1 20 1\n",
    }
    monkeypatch.setattr(module, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(module, "os", SimpleNamespace(listdir=lambda _path: ["10", "20", "30"]))

    def open_stat(path, mode):
        assert mode == "rb"
        return io.BytesIO(proc_stats[path])

    monkeypatch.setattr(module, "open", open_stat, raising=False)
    assert module.group_has_live_member(20)
    proc_stats["/proc/30/stat"] = b"30 (worker\xff) X 1 20 1\n"
    assert not module.group_has_live_member(20)


def test_output_alias_cannot_overwrite_prompt(request_files, tmp_path):
    client, prompt, system, out = request_files
    original = prompt.read_bytes()
    out.hardlink_to(prompt)
    result = invoke((client, prompt, system, out))
    assert result.returncode == 2
    assert prompt.read_bytes() == original
    assert not list(tmp_path.glob(".cursor-attempt-*"))


def test_oversize_prompt_fails_before_dispatch(request_files, tmp_path):
    _, prompt, _, _ = request_files
    prompt.write_text("π" * (32 * 1024))
    result = invoke(request_files)
    assert result.returncode == 2 and "64 KiB" in result.stderr
    assert not list(tmp_path.glob(".cursor-attempt-*"))


def test_fifo_prompt_is_rejected_without_waiting_for_input(request_files, tmp_path):
    _, prompt, _, _ = request_files
    prompt.unlink()
    os.mkfifo(prompt)
    result = invoke(request_files)
    assert result.returncode == 2 and "regular file" in result.stderr
    assert not list(tmp_path.glob(".cursor-attempt-*"))
