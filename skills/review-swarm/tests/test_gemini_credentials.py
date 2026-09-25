"""Authentication lifecycle tests use only synthetic local credentials/runners."""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


RUNNER = Path(__file__).resolve().parents[1] / "scripts/bin/run_multi_task.py"


@pytest.fixture
def case(tmp_path, monkeypatch):
    home = tmp_path / "user-home"
    auth = home / ".gemini"
    auth.mkdir(parents=True)
    (auth / "settings.json").write_text(json.dumps({"security": {"auth": {
        "selectedType": "oauth-personal", "test_private_field": "dummy-private-config",
    }}}))
    (auth / "oauth_creds.json").write_text('{"token":"dummy-token-never-valid"}')
    (auth / "google_accounts.json").write_text('{"accounts":[]}')
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("REVIEW_SWARM_NO_AUTO_CONFIG", "1")
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    monkeypatch.setenv("FAKE_HOME_REPORT", str(tmp_path / "observation.json"))
    fake = tmp_path / "runner.py"
    fake.write_text('''#!/usr/bin/env bash
exec python3 - "$@" <<'PY'
import json, os, stat, sys, time
from pathlib import Path
args = sys.argv[1:]
home = Path(args[args.index("--gemini-cli-home") + 1])
root = home / ".gemini"
report = {"home": str(home), "home_mode": stat.S_IMODE(home.stat().st_mode),
          "directory_mode": stat.S_IMODE(root.stat().st_mode),
          "file_modes": {p.name: stat.S_IMODE(p.stat().st_mode) for p in root.iterdir()},
          "settings": json.loads((root / "settings.json").read_text()),
          "oauth_present": (root / "oauth_creds.json").is_file()}
Path(os.environ["FAKE_HOME_REPORT"]).write_text(json.dumps(report))
mode = os.environ.get("FAKE_HOME_MODE", "ok")
if mode == "sleep":
    time.sleep(60)
if mode == "fail":
    print("failed at " + str(home), file=sys.stderr)
    sys.exit(7)
Path(args[args.index("--out") + 1]).write_text("VERDICT: READY\\n" + str(home))
print(str(home))
PY
''')
    fake.chmod(0o755)
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("synthetic test")
    out = tmp_path / "artifacts"
    args = [str(RUNNER), "--out-dir", str(out), "--prompt", str(prompt), "--system", str(prompt),
            "--gemini-runner", str(fake), "--models", "gemini/default",
            "--backend-tool-mode", "gemini=review", "--fallback-mode", "off"]
    return args, out, tmp_path / "observation.json", auth


def assert_private_and_removed(report, out):
    data = json.loads(report.read_text())
    home = Path(data["home"])
    assert not home.exists()
    assert not home.is_relative_to(out.parent.resolve())
    assert data["home_mode"] == data["directory_mode"] == 0o700
    assert set(data["file_modes"].values()) == {0o600}
    assert data["oauth_present"]
    assert data["settings"]["mcpServers"] == {}
    for artifact in out.rglob("*"):
        if artifact.is_file():
            text = artifact.read_text()
            assert data["home"] not in text
            assert "dummy-token-never-valid" not in text
            assert "dummy-private-config" not in text
    assert not list(out.rglob("oauth_creds.json"))


@pytest.mark.parametrize("mode,expected", [("ok", 0), ("fail", 2), ("sleep", 2)])
def test_cleanup_success_failure_timeout(case, monkeypatch, mode, expected):
    args, out, report, auth = case
    monkeypatch.setenv("FAKE_HOME_MODE", mode)
    before = {p.name: p.read_bytes() for p in auth.iterdir()}
    proc = subprocess.run([sys.executable, *args, "--timeout-secs", "1"], capture_output=True, text=True, timeout=10)
    assert proc.returncode == expected, proc.stderr
    assert_private_and_removed(report, out)
    assert {p.name: p.read_bytes() for p in auth.iterdir()} == before


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT, signal.SIGHUP])
def test_signal_stops_worker_before_home_cleanup(case, monkeypatch, signum):
    args, out, report, _ = case
    monkeypatch.setenv("FAKE_HOME_MODE", "sleep")
    proc = subprocess.Popen([sys.executable, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 5
        while not report.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert report.exists()
        proc.send_signal(signum)
        stdout, stderr = proc.communicate(timeout=5)
        assert proc.returncode == 128 + signum, (stdout, stderr)
        assert_private_and_removed(report, out)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_setup_exception_cleans_partial_auth_copy(case, monkeypatch):
    args, _, _, _ = case
    spec = importlib.util.spec_from_file_location("credential_lifecycle_runner", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    created = []

    def fail_copy(home):
        created.append(home)
        (home / ".gemini").mkdir(mode=0o700)
        (home / ".gemini/oauth_creds.json").write_text("dummy-partial")
        raise OSError("synthetic copy failure")

    monkeypatch.setattr(module, "_copy_default_gemini_oauth_support_files", fail_copy)
    monkeypatch.setattr(sys, "argv", args)
    with pytest.raises(OSError, match="synthetic copy failure"):
        module.main()
    assert created and all(not home.exists() for home in created)
