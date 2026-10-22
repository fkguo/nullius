from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/run_dsh.py"
SPEC = importlib.util.spec_from_file_location("dsh_runner", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def events(text="complete result"):
    config = {"provider": "chosen-route", "model": "chosen-model", "maxTokens": 2048, "reasoningEffort": "low"}
    replay = {"response": {"kind": "pi-ai", "version": 2, "api": "openai-completions", "provider": "chosen-route", "model": "chosen-model", "stopReason": "stop", "responseId": "fake-response"}}
    return [
        {"type": "session", "version": 4, "id": "session-fake", "createdAt": 1792563270076, "cwd": "/fixture/workspace", "isSeeded": False, "delegationDepth": 0},
        {"type": "turn/start", "seq": 0, "data": {"turn": 1}},
        {"type": "request/header", "seq": 1, "data": {"header": {"config": config, "tools": []}}},
        {"type": "assistant/message", "seq": 2, "data": {"turn": 1, "step": 1, "message": {
            "role": "assistant", "source": {"kind": "model", "provider": "chosen-route", "model": "chosen-model", "replayState": replay},
            "content": [{"type": "text", "text": text}]},
            "stream": [
                {"type": "chunk", "time": 1792563270187, "chunk": {"type": "block-start", "index": 0, "blockType": "text"}},
                {"type": "text-chunks", "time0": 1792563270188, "index": 0, "dt": [], "texts": [text]},
                {"type": "chunk", "time": 1792563270195, "chunk": {"type": "block-end", "index": 0, "block": {"type": "text", "text": text}}},
                {"type": "chunk", "time": 1792563270195, "chunk": {"type": "finish", "reason": {"kind": "stop"}, "replayState": replay}}]}},
        {"type": "turn/end", "seq": 3, "data": {"turn": 1, "reason": {"kind": "completed"}}},
    ]


def check(rows):
    return runner.check_events(rows, "chosen-route", "chosen-model", 2048, "low")


def test_complete_message_and_full_unicode():
    text = "Result α\n" + "x" * 150000
    actual, evidence = check(events(text))
    assert actual == text
    assert evidence["provider_attestation"] == "unknown"


def test_canonical_header_omits_empty_tool_catalog():
    rows = events()
    del rows[2]["data"]["header"]["tools"]
    assert check(rows)[0] == "complete result"


def test_final_reasoning_only_message_cannot_reuse_earlier_text():
    rows = events()
    last = json.loads(json.dumps(rows[3]))
    last["seq"] = 3
    last["data"]["message"]["content"] = [{"type": "reasoning", "text": "unfinished"}]
    rows.insert(4, last)
    rows[-1]["seq"] = 4
    with pytest.raises(runner.RunError):
        check(rows)


@pytest.mark.parametrize("change", [
    "length", "error", "wrong-route", "tools", "wrong-cap", "wrong-effort", "missing-stop", "bad-sequence", "blank", "no-header", "no-terminal", "future-version",
])
def test_reject_misleading_success(change):
    rows = events()
    if change in ("length", "error"):
        rows[-1]["data"]["reason"]["kind"] = "max-tokens" if change == "length" else "error"
    elif change == "wrong-route":
        rows[2]["data"]["header"]["config"]["model"] = "other-model"
    elif change == "tools":
        rows[2]["data"]["header"]["tools"] = [{"name": "exit_plan_mode"}]
    elif change == "wrong-cap":
        rows[2]["data"]["header"]["config"]["maxTokens"] = 1024
    elif change == "wrong-effort":
        rows[2]["data"]["header"]["config"]["reasoningEffort"] = "high"
    elif change == "missing-stop":
        del rows[3]["data"]["message"]["source"]["replayState"]
    elif change == "bad-sequence":
        rows[3]["seq"] = 1
    elif change == "blank":
        rows[3]["data"]["message"]["content"] = [{"type": "reasoning", "text": "not final text"}]
    elif change == "no-header":
        del rows[2]
    elif change == "no-terminal":
        rows.pop()
    else:
        rows[0]["version"] = 99
    with pytest.raises(runner.RunError):
        check(rows)


@pytest.fixture
def dispatch(tmp_path):
    resources = tmp_path / "Harness.app/Contents/Resources"
    launcher = resources / "runtime/cli/bin/dsh"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("""#!/bin/sh
set -e
launcher=$0
while [ -L "$launcher" ]; do
  directory=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd -P)
  target=$(readlink "$launcher")
  case "$target" in
    /*) launcher=$target ;;
    *) launcher=$directory/$target ;;
  esac
done
resources=$(CDPATH= cd -- "$(dirname -- "$launcher")/../../.." && pwd -P)
ELECTRON_RUN_AS_NODE=1 exec "$resources/../MacOS/DeepSeek Harness" --expose-internals "$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"
""")
    launcher.chmod(0o755)
    (resources / "app.asar").write_text("synthetic test archive")
    (resources / "runtime/versions.json").write_text(json.dumps({"schemaVersion": 1, "node": "24.21.0", "pnpm": "11.28.5"}))
    executable = resources.parent / "MacOS/DeepSeek Harness"
    executable.parent.mkdir()
    executable.write_text("#!" + sys.executable + "\n" + r'''
import json,os,sys,time,signal
from pathlib import Path
mode=os.environ.get("FAKE_DSH_CASE","complete")
assert sys.argv[1] == "--expose-internals"
assert sys.argv[2].endswith("app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js")
assert os.environ["ELECTRON_RUN_AS_NODE"] == "1"
args=sys.argv[3:]
if args == ["--version"]:
    print(os.environ.get("FAKE_DSH_VERSION", "0.2.1-rc.2"))
    raise SystemExit(0)
if "--dump-config-schema" in args:
    ids=os.environ["FAKE_DSH_IDS"].split()
    if mode == "missing-isolation": ids.remove("agent-instructions")
    if mode == "unknown-plugin": ids.append("future-executable-extension")
    print(json.dumps({"x-cordis":{"profile":"headless","complete":True,"entries":[{"id":i,"name":"@deepseek-ai/dsh-"+i} for i in ids]}}))
    raise SystemExit(0)
if "--dump-default-config" in args:
    print("\n".join("- id: "+i+"\n  name: '@deepseek-ai/dsh-"+i+"'" for i in os.environ["FAKE_DSH_IDS"].split()))
    raise SystemExit(0)
if mode in ("timeout", "cancel"):
    print("usable partial output", flush=True)
    if mode == "cancel":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        Path(os.environ["FAKE_PID_FILE"]).write_text(str(os.getpid()))
    time.sleep(15)
patch=json.loads(Path(args[args.index("--patch")+1]).read_text())
def row(i):
    return next(r for r in reversed(patch) if r["id"] == i)
assert row("plan-mode")["disabled"]
assert row("session-title-llm")["disabled"]
assert row("credentials")["disabled"]
assert row("agent-instructions")["disabled"]
assert row("skill-filesystem")["disabled"]
assert row("llm-deepseek")["disabled"]
assert row("llm-deepseek-account")["disabled"]
assert all(r["disabled"] for r in patch if r["id"].startswith("tool-"))
if mode == "unknown-plugin":
    assert row("future-executable-extension")["disabled"]
assert row("system-prompt")["config"] == {"personaPrefix":"", "personaSuffix":"", "includeHarnessIdentity":False, "includeRuntimeContext":False}
assert "packChunks" not in row("session-persistence-jsonl")["config"]
assert Path.cwd().name == "workspace"
assert os.environ["DSH_TELEMETRY_DISABLED"] == "1"
assert "DSH_TOOLS_MODE" not in os.environ
assert args[-1].startswith("Task:\n")
rows=json.loads(os.environ["FAKE_EVENTS"])
rows[0]["cwd"] = str(Path.cwd())
if mode == "wrong-cwd": rows[0]["cwd"] = "/unrelated/workspace"
if mode == "length": rows[-1]["data"]["reason"]["kind"]="max-tokens"
if mode == "route": rows[2]["data"]["header"]["config"]["model"]="other-model"
if mode == "old-session": rows[0]["version"] = 0
root=Path(os.environ["DSH_HOME"])/"sessions/ws/session-fake"
root.mkdir(parents=True)
(root/("session.jsonl" if mode=="old-filename" else "session.v4.jsonl")).write_text("".join(json.dumps(r)+"\n" for r in rows))
if mode in ("mutate-launcher", "mutate-archive"):
    resources=Path(sys.argv[2].split("/app.asar/")[0])
    changed=resources / ("runtime/cli/bin/dsh" if mode=="mutate-launcher" else "app.asar")
    changed.write_text(changed.read_text()+"\nmutation")
if mode == "mutate-provider-config":
    Path(os.environ["FAKE_PROVIDER_FILE"]).write_text(json.dumps({"apiKeyEnv":"CHANGED_CONFIG_KEY", "models":[{"id":"unselected-model"}]}))
print("wrong stdout" if mode == "mismatch" else "complete result")
sys.exit(1 if mode == "exit-failure" else 0)
''')
    executable.chmod(0o755)
    # Literal current profile inventory: fixture must not inherit implementation allowlists.
    ids = "tool-plugin-manager plugin-manager timer hmr llm deepseek-llm-api-extensions session session-log-deepseek typert typert-loader typert-gateway remote-access session-title session-title-llm user-questions agent plugin-package-inventory-deepseek agent-default-model jobs llm-retry config-editor settings authorization deepseek-account credentials llm-pi-ai session-persistence-jsonl attachment-local session-query-sqlite working-directory tool-working-directory session-projection storage storage-json storage-domain session-projection-cache otel session-telemetry-otel subprocess sandbox sandbox-policy bash-sandbox pwsh-sandbox approval permission shell-env tool-bash tool-pwsh tool-jobs fs-observation-policy tool-fs tool-fs-search agent-instructions skill skill-filesystem tool-skill commands command-feedback goal goal-round-driver command-goal plan-mode token-meter compaction-basic command-compact subagent subagent-spawn-in-process subagent-fork-in-process tool-subagent-control tool-subagent-list-agents tool-subagent tool-subagent-fork ptc-runtime workflow-ptc tool-workflow timeout-policy spill-local spill-policy session-checkpoint-policy tool-result-pruner image-offload tool-todo tool-goal repeat-tool-reminder web web-search-deepseek web-deepseek-api web-fetch-http tool-web mcp-resources tools system-prompt agent-loop fs-sandbox llm-deepseek llm-deepseek-account headless-startup headless-runner"
    prompt = tmp_path / "prompt with spaces.txt"
    prompt.write_text("Inspect literal $(touch BAD) and `echo unsafe` inputs.")
    profile = tmp_path / "provider.json"
    profile.write_text(json.dumps({"apiKeyEnv": "TEST_MODEL_KEY", "models": [{"id": "chosen-model", "reasoningEfforts": {"low": "low"}}]}))
    out = tmp_path / "result.txt"
    env = os.environ | {"TEST_MODEL_KEY": "do-not-record-this-secret", "FAKE_EVENTS": json.dumps(events()), "FAKE_DSH_IDS": ids, "DSH_TOOLS_MODE": "code", "DSH_HOME": str(tmp_path / "user-home")}
    cmd = [sys.executable, str(SCRIPT), "--cli-entry", str(launcher), "--provider", "chosen-route", "--model", "chosen-model", "--provider-config-file", str(profile), "--prompt-file", str(prompt), "--out", str(out), "--max-tokens", "2048", "--reasoning", "low", "--timeout-secs", "4"]
    return cmd, env, out, tmp_path


def test_dispatch_capture_and_user_home_isolation(dispatch):
    cmd, env, out, root = dispatch
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=8)
    assert result.returncode == 0, result.stderr
    assert out.read_text() == "complete result\n"
    receipt = json.loads(next(Path(str(out) + ".attempts").glob("run.*/receipt.json")).read_text())
    assert receipt["status"] == "completed"
    assert receipt["evidence"]["requests"][0]["maxTokens"] == 2048
    assert not (root / "BAD").exists()
    assert not (root / "user-home").exists()
    assert "do-not-record-this-secret" not in result.stdout + result.stderr + json.dumps(receipt)


@pytest.mark.parametrize("mode", ["length", "route", "mismatch", "exit-failure", "timeout", "old-session", "old-filename", "wrong-cwd", "mutate-launcher", "mutate-archive"])
def test_failed_dispatch_never_delivers(dispatch, mode):
    cmd, env, out, root = dispatch
    env["FAKE_DSH_CASE"] = mode
    if mode == "timeout":
        cmd[-1] = "0.4"
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=8)
    assert result.returncode == 1
    assert not out.exists()
    run = next(Path(str(out) + ".attempts").glob("run.*"))
    receipt = json.loads((run / "receipt.json").read_text())
    assert receipt["status"] in ("failed", "interrupted")
    assert (run / "output.partial").exists()


@pytest.mark.parametrize("second_signal", [signal.SIGTERM, signal.SIGINT])
def test_repeated_cancellation_cannot_interrupt_group_cleanup(dispatch, second_signal):
    cmd, env, out, root = dispatch
    pid_file = root / "child.pid"
    env.update(FAKE_DSH_CASE="cancel", FAKE_PID_FILE=str(pid_file))
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child = None
    try:
        deadline = time.monotonic() + 3
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert pid_file.exists(), "mock child did not launch"
        child = int(pid_file.read_text())
        proc.send_signal(signal.SIGTERM)
        time.sleep(0.2)
        proc.send_signal(second_signal)
        proc.communicate(timeout=4)
        assert proc.returncode == 1
        assert not out.exists()
        with pytest.raises(ProcessLookupError):
            os.kill(child, 0)
        run = next(Path(str(out) + ".attempts").glob("run.*"))
        assert (run / "output.partial").read_text() == "usable partial output\n"
        assert json.loads((run / "receipt.json").read_text())["status"] == "interrupted"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if child is not None:
            try:
                os.killpg(child, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_dry_run_without_credentials_does_not_launch(dispatch):
    cmd, env, out, root = dispatch
    del env["TEST_MODEL_KEY"]
    env["FAKE_DSH_CASE"] = "timeout"
    result = subprocess.run(cmd + ["--dry-run"], env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 0
    assert not out.exists()
    run = next(Path(str(out) + ".attempts").glob("run.*"))
    assert not (run / "stdout.txt").exists()


def test_existing_delivery_not_overwritten(dispatch):
    cmd, env, out, root = dispatch
    out.write_text("old delivery")
    result = subprocess.run(cmd, env=env, capture_output=True, timeout=4)
    assert result.returncode == 1
    assert out.read_text() == "old delivery"


def test_atomic_publication_never_leaves_partial_delivery(tmp_path, monkeypatch):
    out = tmp_path / "result"
    def disk_failure(_fd):
        raise OSError("simulated storage failure")
    monkeypatch.setattr(runner.os, "fsync", disk_failure)
    with pytest.raises(OSError):
        runner.publish_output(out, b"complete result")
    assert not out.exists()
    assert list(tmp_path.iterdir()) == []


def test_atomic_publication_refuses_existing_file(tmp_path):
    out = tmp_path / "result"
    out.write_text("previous result")
    with pytest.raises(FileExistsError):
        runner.publish_output(out, b"complete result")
    assert out.read_text() == "previous result"
    assert list(tmp_path.iterdir()) == [out]


def test_oversized_prompt_refused_before_launch(dispatch):
    cmd, env, out, root = dispatch
    (root / "prompt with spaces.txt").write_text("x" * (os.sysconf("SC_ARG_MAX") + 1))
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 1
    assert "argument budget" in result.stderr
    assert not out.exists()


@pytest.mark.parametrize("bad", [{"headers": {"Authorization": "secret"}}, {"apiKey": "secret"}])
def test_inline_credentials_refused(dispatch, bad):
    cmd, env, out, root = dispatch
    p = root / "provider.json"
    profile = json.loads(p.read_text()) | bad
    p.write_text(json.dumps(profile))
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 1
    assert "secret" not in result.stdout + result.stderr


@pytest.mark.parametrize("version", ["0.1.0-rc.7", "0.2.1-rc.3", "999.0.0"])
def test_old_or_unknown_runtime_refused(dispatch, version):
    cmd, env, out, _ = dispatch
    env["FAKE_DSH_VERSION"] = version
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 1
    assert not out.exists()
    assert "unsupported DSH runtime" in result.stderr


def test_missing_isolation_row_refused(dispatch):
    cmd, env, out, _ = dispatch
    env["FAKE_DSH_CASE"] = "missing-isolation"
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 1
    assert not out.exists()
    assert "isolation contract" in result.stderr


def test_unknown_profile_plugin_is_explicitly_disabled(dispatch):
    cmd, env, out, _ = dispatch
    env["FAKE_DSH_CASE"] = "unknown-plugin"
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 0, result.stderr
    assert out.read_text() == "complete result\n"


@pytest.mark.parametrize("mutation", ["old-version", "null-id", "seeded", "delegated", "sequence-gap", "dropped-prefix", "old-replay", "wrong-role", "retry", "attempt", "wrong-stream-stop", "missing-stream"])
def test_current_session_integrity_refusals(mutation):
    rows = events()
    if mutation == "old-version":
        rows[0]["version"] = 0
    elif mutation == "null-id":
        rows[0]["id"] = None
    elif mutation == "seeded":
        rows[0]["isSeeded"] = True
    elif mutation == "delegated":
        rows[0]["delegationDepth"] = 1
    elif mutation in ("sequence-gap", "dropped-prefix"):
        for row in rows[1 if mutation == "dropped-prefix" else 3:]:
            row["seq"] += 1
    elif mutation == "old-replay":
        rows[3]["data"]["message"]["source"]["replayState"]["response"]["version"] = 1
    elif mutation == "wrong-role":
        rows[3]["data"]["message"]["role"] = "user"
    elif mutation in ("retry", "attempt"):
        rows.insert(3, {"type": "llm/retry" if mutation == "retry" else "assistant/attempt", "seq": 2, "data": {}})
        for index, row in enumerate(rows[1:]):
            row["seq"] = index
    elif mutation == "wrong-stream-stop":
        rows[3]["data"]["stream"][-1]["chunk"]["reason"]["kind"] = "length"
    else:
        del rows[3]["data"]["stream"]
    with pytest.raises(runner.RunError):
        check(rows)


def test_caller_cwd_must_match_fresh_session():
    with pytest.raises(runner.RunError):
        runner.check_events(events(), "chosen-route", "chosen-model", 2048, "low", expected_cwd="/different/workspace")


def test_resume_is_not_silently_accepted(dispatch):
    cmd, env, out, _ = dispatch
    result = subprocess.run(cmd + ["--resume", "old-session"], env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode != 0
    assert not out.exists()


def test_missing_credentials_refused_before_dispatch(dispatch):
    cmd, env, out, _ = dispatch
    del env["TEST_MODEL_KEY"]
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 1
    assert "apiKeyEnv" in result.stderr
    assert not out.exists()
    assert not list(Path(str(out) + ".attempts").glob("run.*/stdout.txt"))


@pytest.mark.parametrize("nested", [{"apiKey": "do-not-record-nested-secret"}, {"transport": {"headers": {"Authorization": "do-not-record-nested-secret"}}}])
def test_nested_selected_model_credentials_refused(dispatch, nested):
    cmd, env, out, root = dispatch
    profile_file = root / "provider.json"
    profile = json.loads(profile_file.read_text())
    profile["models"][0].update(nested)
    profile_file.write_text(json.dumps(profile))
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 1
    assert not out.exists()
    assert "do-not-record-nested-secret" not in result.stdout + result.stderr
    for receipt_file in Path(str(out) + ".attempts").glob("run.*/receipt.json"):
        assert "do-not-record-nested-secret" not in receipt_file.read_text()


def test_atomic_publication_deadline_covers_fsync(tmp_path, monkeypatch):
    out = tmp_path / "result"
    clock = [1.0]
    real_fsync = runner.os.fsync
    def slow_storage(fd):
        real_fsync(fd)
        clock[0] = 3.0
    monkeypatch.setattr(runner.os, "fsync", slow_storage)
    monkeypatch.setattr(runner.time, "monotonic", lambda: clock[0])
    with pytest.raises(runner.RunError, match="deadline"):
        runner.publish_output(out, b"complete result", deadline=2.0)
    assert not out.exists()
    assert list(tmp_path.iterdir()) == []


def test_provider_receipt_hash_binds_dispatched_config_bytes(dispatch):
    cmd, env, out, root = dispatch
    profile_file = root / "provider.json"
    original = profile_file.read_bytes()
    env.update(FAKE_DSH_CASE="mutate-provider-config", FAKE_PROVIDER_FILE=str(profile_file))
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=4)
    assert result.returncode == 0, result.stderr
    assert out.read_text() == "complete result\n"
    assert profile_file.read_bytes() != original
    receipt = json.loads(next(Path(str(out) + ".attempts").glob("run.*/receipt.json")).read_text())
    assert receipt["provider_config_sha256"] == runner.digest(original)
    assert receipt["provider_config_sha256"] != runner.digest(profile_file.read_bytes())


def test_trace_alias_binds_the_physical_isolated_working_directory(dispatch):
    cmd, env, out, root = dispatch
    physical = root / "physical-traces"
    physical.mkdir()
    alias = root / "trace-alias"
    alias.symlink_to(physical, target_is_directory=True)
    result = subprocess.run(cmd + ["--trace-dir", str(alias)], env=env, capture_output=True, text=True, timeout=8)
    assert result.returncode == 0, result.stderr
    receipt = json.loads(next(physical.glob("run.*/receipt.json")).read_text())
    assert str(Path(receipt["isolated_cwd"]).resolve(strict=True)) == receipt["isolated_cwd"]
    assert out.read_text() == "complete result\n"


@pytest.mark.parametrize("mutation", ["created_at", "stream_delta", "stream_end", "stream_both"])
def test_current_stream_and_timestamp_cannot_contradict_committed_message(mutation):
    rows = events()
    if mutation == "created_at":
        del rows[0]["createdAt"]
    else:
        stream = rows[3]["data"]["stream"]
        if mutation in {"stream_delta", "stream_both"}:
            stream[1]["texts"] = ["contradictory stream"]
        if mutation in {"stream_end", "stream_both"}:
            stream[2]["chunk"]["block"]["text"] = "contradictory stream"
    with pytest.raises(runner.RunError):
        check(rows)
