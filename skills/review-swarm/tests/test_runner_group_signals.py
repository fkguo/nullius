"""Supervisors signal a CLI's process group only while the CLI is unreaped.

A supervisor starts the CLI with start_new_session=True, so the CLI's pid is
also its group number. That number names the CLI's group provably only while
the CLI is unreaped; afterwards the kernel may reissue it. These tests route
every signal sent after the reap to a detached stand-in process and require the
stand-in to survive, and reproduce on Linux the macOS EPERM answer for a group
whose only remaining member is the zombie leader (see group_signal_kernel).
"""
from __future__ import annotations

import importlib.util
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


SKILLS = Path(__file__).resolve().parents[2]
PROCESS_BUDGETS = {name: SKILLS / f"{name}-cli-runner/scripts/process_budget.py"
                   for name in ("claude", "kimi", "opencode")}
RUN_GEMINI = SKILLS / "gemini-cli-runner/scripts/run_gemini.sh"
RUN_MULTI_TASK = SKILLS / "review-swarm/scripts/bin/run_multi_task.py"
SMOKE = SKILLS / "review-swarm/scripts/bin/smoke_run_multi_task_real.py"
REPRODUCTION_CHECK = SKILLS / "research-harness/scripts/independent_reproduction_check.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses resolve annotations through it
    spec.loader.exec_module(module)
    return module


kernel = _load("group_signal_kernel", Path(__file__).with_name("group_signal_kernel.py"))


# The fake CLI. "alone" exits at once. "descendants" first leaves two
# descendants in its group, one that stops on SIGTERM and one that ignores it
# (only SIGKILL stops it), each recording the signals it sees, then exits.
# "quiet-descendants" does the same with the descendants' output redirected
# away from the CLI's. "sleeps" does the same as "descendants" but keeps
# running; "sleeps-alone" just keeps running.
FAKE_CLI = r'''
import os, signal, subprocess, sys, time
mode, workdir = sys.argv[1], sys.argv[2]
DESCENDANT = """
import os, signal, sys, time
log, behaviour = sys.argv[1], sys.argv[2]
def on_term(signum, frame):
    with open(log, "a") as stream:
        stream.write("TERM\\n")
    if behaviour == "exits":
        os._exit(0)
signal.signal(signal.SIGTERM, on_term)
with open(log, "a") as stream:
    stream.write("ready %d\\n" % os.getpid())
while True:
    time.sleep(0.05)
"""
def ready(behaviour):
    path = os.path.join(workdir, behaviour + ".log")
    return os.path.exists(path) and "ready" in open(path).read()
if mode in ("descendants", "quiet-descendants", "sleeps"):
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL} if mode.startswith("quiet") else {}
    for behaviour in ("exits", "ignores"):
        subprocess.Popen([sys.executable, "-c", DESCENDANT, os.path.join(workdir, behaviour + ".log"), behaviour],
                         **quiet)
    while not (ready("exits") and ready("ignores")):
        time.sleep(0.01)
    open(os.path.join(workdir, "descendants.ready"), "w").close()
open(os.path.join(workdir, "cli.started"), "w").close()
if mode.startswith("sleeps"):
    time.sleep(60)
'''


class Standin:
    """A detached process standing in for an unrelated group that reuses a number."""

    def __init__(self):
        self.proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"],
                                     start_new_session=True)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()


@pytest.fixture
def standin():
    process = Standin()
    try:
        yield process
    finally:
        process.stop()


def _child_env(tmp_path: Path, standin: Standin) -> tuple[dict, Path]:
    env = os.environ.copy()
    log = tmp_path / "late-signals.log"
    log.touch()
    kernel.install_for_children(tmp_path / "site", env, standin.proc.pid, log)
    return env, log


def _descendant_pids(workdir: Path) -> dict[str, int]:
    pids = {}
    for behaviour in ("exits", "ignores"):
        lines = (workdir / f"{behaviour}.log").read_text().splitlines()
        pids[behaviour] = int(lines[0].split()[1])
    return pids


def _assert_descendants_stopped(workdir: Path) -> None:
    pids = _descendant_pids(workdir)
    try:
        for behaviour, pid in pids.items():
            assert kernel.wait_gone(pid), f"descendant that {behaviour} on SIGTERM survived"
            assert "TERM" in (workdir / f"{behaviour}.log").read_text(), behaviour
    finally:
        for pid in pids.values():
            if not kernel.gone(pid):
                os.kill(pid, signal.SIGKILL)


def _wait_file(path: Path, timeout: float = 20) -> None:
    deadline = time.monotonic() + timeout
    while not path.exists():
        assert time.monotonic() < deadline, f"{path.name} did not appear"
        time.sleep(0.02)


# --- process_budget.py (claude, kimi, opencode copies) -----------------------

def _budget_run(tmp_path: Path, provider: str, mode: str, standin: Standin, *,
                timeout_secs: float = 0, cancel: bool = False,
                deadline_when_cli_started: bool = False,
                ignore_sigchld: bool = False) -> tuple[int, str, Path]:
    script = PROCESS_BUDGETS[provider]
    workdir = tmp_path / "work"
    workdir.mkdir()
    fake = tmp_path / "fake_cli.py"
    fake.write_text(FAKE_CLI)
    state = tmp_path / "budget.json"
    env, log = _child_env(tmp_path, standin)
    if deadline_when_cli_started:
        # The supervisor's clock jumps an hour ahead once the CLI has started.
        env["GROUP_SIGNAL_CLOCK_ADVANCE_AFTER"] = str(workdir / "cli.started")
    subprocess.run([sys.executable, str(script), "init", "--state", str(state),
                    "--timeout-secs", str(timeout_secs)], env=env, check=True, timeout=30)
    cmd = [sys.executable, str(script), "run", "--state", str(state),
           "--stdout", str(tmp_path / "cli.out"), "--stderr", str(tmp_path / "cli.err"),
           "--", sys.executable, str(fake), mode, str(workdir)]
    preexec = kernel.ignore_sigchld_for_children(env) if ignore_sigchld else None
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            preexec_fn=preexec)
    try:
        if cancel:
            _wait_file(workdir / "descendants.ready")
            proc.send_signal(signal.SIGTERM)
        _, stderr = proc.communicate(timeout=60)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    cli_err = tmp_path / "cli.err"
    return proc.returncode, stderr + (cli_err.read_text() if cli_err.exists() else ""), log


@pytest.mark.parametrize("provider", sorted(PROCESS_BUDGETS))
@pytest.mark.parametrize("mode", ["alone", "descendants"])
def test_budget_signals_group_before_reaping_cli_that_exits(tmp_path, standin, provider, mode):
    code, stderr, log = _budget_run(tmp_path, provider, mode, standin)
    assert log.read_text() == "", "a group was signalled after its leader was reaped"
    assert standin.alive()
    assert code == 0, stderr
    if mode == "descendants":
        _assert_descendants_stopped(tmp_path / "work")


@pytest.mark.parametrize("provider", sorted(PROCESS_BUDGETS))
def test_budget_cancel_stops_group_before_reaping(tmp_path, standin, provider):
    code, stderr, log = _budget_run(tmp_path, provider, "sleeps", standin, cancel=True)
    assert log.read_text() == "", "a group was signalled after its leader was reaped"
    assert standin.alive()
    assert code == 128 + signal.SIGTERM, stderr
    _assert_descendants_stopped(tmp_path / "work")


@pytest.mark.parametrize("provider", sorted(PROCESS_BUDGETS))
def test_budget_deadline_stops_group_before_reaping(tmp_path, standin, provider):
    code, stderr, log = _budget_run(tmp_path, provider, "sleeps", standin, timeout_secs=600,
                                    deadline_when_cli_started=True)
    assert log.read_text() == "", "a group was signalled after its leader was reaped"
    assert standin.alive()
    assert code == 124, stderr
    _assert_descendants_stopped(tmp_path / "work")


# A supervisor started with SIGCHLD ignored: unless it sets SIGCHLD back to its
# default, the kernel reaps the exited CLI itself, and every later signal to
# the CLI's group number is late (Linux: waitid answers ECHILD; macOS: the
# kqueue watch answers ESRCH or fires for a pid already reaped).

def _kill_survivors(workdir: Path) -> None:
    """Kill the fake CLI's descendants that a failed run left behind."""
    for behaviour in ("exits", "ignores"):
        log = workdir / f"{behaviour}.log"
        lines = log.read_text().splitlines() if log.exists() else []
        if lines and lines[0].startswith("ready "):
            pid = int(lines[0].split()[1])
            if not kernel.gone(pid):
                os.kill(pid, signal.SIGKILL)


def _assert_no_echild(stderr: str) -> None:
    assert "ChildProcessError" not in stderr and "No child processes" not in stderr, stderr
    assert "Traceback" not in stderr, stderr


@pytest.mark.parametrize("provider", sorted(PROCESS_BUDGETS))
def test_budget_owns_sigchld_when_started_with_it_ignored(tmp_path, standin, provider):
    try:
        code, stderr, log = _budget_run(tmp_path, provider, "descendants", standin, ignore_sigchld=True)
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        _assert_no_echild(stderr)
        assert code == 0, stderr
        _assert_descendants_stopped(tmp_path / "work")
    finally:
        _kill_survivors(tmp_path / "work")


@pytest.fixture
def sigchld_ignored():
    """SIGCHLD ignored in this process: the kernel reaps exited children itself."""
    previous = signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    try:
        yield
    finally:
        signal.signal(signal.SIGCHLD, previous)


def _child_exited_helpers():
    helpers = [(f"process_budget_{name}", path, "child_exited", "ChildReapingError")
               for name, path in sorted(PROCESS_BUDGETS.items())]
    helpers += [("run_multi_task_reaping", RUN_MULTI_TASK, "_child_exited", "_ChildReapingError"),
                ("smoke_run_multi_task_real_reaping", SMOKE, "_child_exited", "_ChildReapingError"),
                ("independent_reproduction_check_reaping", REPRODUCTION_CHECK, "_child_exited",
                 "ChildReapingError")]
    return helpers


@pytest.mark.parametrize("name,path,function,error", _child_exited_helpers(),
                         ids=[h[0] for h in _child_exited_helpers()])
def test_child_exited_reports_a_child_reaped_elsewhere(monkeypatch, sigchld_ignored,
                                                       name, path, function, error):
    # A child the kernel has already reaped is no zombie: the helper must say
    # so rather than answer "exited" (macOS ESRCH) or leak ECHILD (Linux).
    monkeypatch.syspath_prepend(str(path.parent))
    module = _load(name, path)
    proc = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
    deadline = time.monotonic() + 20
    while True:  # auto-reaped: the pid answers ESRCH, never as a zombie
        try:
            os.kill(proc.pid, 0)
        except ProcessLookupError:
            break
        assert time.monotonic() < deadline, "the ignored SIGCHLD did not reap the child"
        time.sleep(0.01)
    with pytest.raises(Exception) as caught:
        getattr(module, function)(proc.pid, 1)
    assert type(caught.value).__name__ == error, repr(caught.value)
    proc.wait()


@pytest.mark.parametrize("provider", sorted(PROCESS_BUDGETS))
def test_budget_stop_group_treats_eperm_as_nothing_left(monkeypatch, provider):
    path = PROCESS_BUDGETS[provider]
    monkeypatch.syspath_prepend(str(path.parent))
    module = _load(f"process_budget_{provider}", path)
    monkeypatch.setattr(os, "killpg", kernel.emulated_killpg(os.killpg))
    proc = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
    try:
        kernel.wait_zombie(proc.pid)  # the group's only member is the unreaped zombie leader
        module.stop_group(proc)
        assert proc.returncode == 0
    finally:
        if proc.returncode is None:
            proc.kill()
            proc.wait()


# --- run_gemini.sh supervisor ------------------------------------------------

def _gemini_supervisor_source() -> str:
    text = RUN_GEMINI.read_text()
    start = text.index("python3 -c '\n") + len("python3 -c '\n")
    return text[start:text.index("\n' env ", start)]


@pytest.mark.parametrize("mode", ["alone", "descendants"])
def test_gemini_supervisor_kills_group_before_reaping(tmp_path, standin, mode):
    workdir = tmp_path / "work"
    workdir.mkdir()
    fake = tmp_path / "fake_cli.py"
    fake.write_text(FAKE_CLI)
    env, log = _child_env(tmp_path, standin)
    # Files, not pipes: descendants that survive must not hold up the run.
    with (tmp_path / "supervisor.out").open("wb") as out, (tmp_path / "supervisor.err").open("wb") as err:
        proc = subprocess.run([sys.executable, "-c", _gemini_supervisor_source(),
                               sys.executable, str(fake), mode, str(workdir)],
                              env=env, stdout=out, stderr=err, timeout=60)
    assert log.read_text() == "", "a group was signalled after its leader was reaped"
    assert standin.alive()
    assert proc.returncode == 0, (tmp_path / "supervisor.err").read_text()
    if mode == "descendants":
        _assert_descendants_stopped(workdir)


def test_gemini_supervisor_owns_sigchld_when_started_with_it_ignored(tmp_path, standin):
    workdir = tmp_path / "work"
    workdir.mkdir()
    fake = tmp_path / "fake_cli.py"
    fake.write_text(FAKE_CLI)
    env, log = _child_env(tmp_path, standin)
    preexec = kernel.ignore_sigchld_for_children(env)
    with (tmp_path / "supervisor.out").open("wb") as out, (tmp_path / "supervisor.err").open("wb") as err:
        proc = subprocess.run([sys.executable, "-c", _gemini_supervisor_source(),
                               sys.executable, str(fake), "descendants", str(workdir)],
                              env=env, stdout=out, stderr=err, timeout=60, preexec_fn=preexec)
    stderr = (tmp_path / "supervisor.err").read_text()
    try:
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        _assert_no_echild(stderr)
        assert proc.returncode == 0, stderr
        _assert_descendants_stopped(workdir)
    finally:
        _kill_survivors(workdir)


def test_gemini_supervisor_cleanup_survives_repeated_signals(tmp_path, standin):
    # In production the supervisor can get SIGTERM twice: from the runner
    # group's stop and from the shell's cleanup. Later signals must not cut
    # the group's stop short.
    workdir = tmp_path / "work"
    workdir.mkdir()
    fake = tmp_path / "fake_cli.py"
    fake.write_text(FAKE_CLI)
    env, log = _child_env(tmp_path, standin)
    with (tmp_path / "supervisor.out").open("wb") as out, (tmp_path / "supervisor.err").open("wb") as err:
        proc = subprocess.Popen([sys.executable, "-c", _gemini_supervisor_source(),
                                 sys.executable, str(fake), "sleeps", str(workdir)],
                                env=env, stdout=out, stderr=err)
    try:
        _wait_file(workdir / "descendants.ready")
        for _ in range(60):
            proc.send_signal(signal.SIGTERM)
            time.sleep(0.01)
        proc.wait(timeout=30)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    assert log.read_text() == "", "a group was signalled after its leader was reaped"
    assert standin.alive()
    assert proc.returncode == 128 + signal.SIGTERM, (tmp_path / "supervisor.err").read_text()
    _assert_descendants_stopped(workdir)


# --- run_multi_task.py --------------------------------------------------------

STUB_RUNNER = """#!/usr/bin/env bash
exec python3 - "$@" <<'PY'
import os, sys, time
from pathlib import Path
(Path(os.environ["STUB_READY_DIR"]) / str(os.getpid())).write_text("")
time.sleep(60)
PY
"""


@pytest.mark.parametrize("parallel", ["--parallel", "--no-parallel"])
def test_multi_task_stop_signals_only_unreaped_runners(tmp_path, standin, parallel):
    runner = tmp_path / "run_opencode.sh"
    runner.write_text(STUB_RUNNER)
    runner.chmod(0o755)
    prompt = tmp_path / "prompt.md"
    prompt.write_text("synthetic test\n")
    ready = tmp_path / "ready"
    ready.mkdir()
    env, log = _child_env(tmp_path, standin)
    env.update(REVIEW_SWARM_NO_AUTO_CONFIG="1", STUB_READY_DIR=str(ready))
    models = "some-provider/model-a,some-provider/model-b" if parallel == "--parallel" else "some-provider/model-a"
    proc = subprocess.Popen([sys.executable, str(RUN_MULTI_TASK), "--out-dir", str(tmp_path / "out"),
                             "--opencode-runner", str(runner), "--system", str(prompt), "--prompt", str(prompt),
                             "--models", models, parallel, "--timeout-secs", "120"],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    runners: list[int] = []
    try:
        expected = len(models.split(","))
        deadline = time.monotonic() + 30
        while len(list(ready.iterdir())) < expected:
            assert time.monotonic() < deadline and proc.poll() is None, "stub runners did not start"
            time.sleep(0.02)
        runners = [int(p.name) for p in ready.iterdir()]
        proc.send_signal(signal.SIGTERM)
        _, stderr = proc.communicate(timeout=30)
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        assert proc.returncode == 128 + signal.SIGTERM, stderr
        for pid in runners:
            assert kernel.wait_gone(pid), "a stub runner survived the stop"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for pid in runners:
            if not kernel.gone(pid):
                os.kill(pid, signal.SIGKILL)


STRAGGLER = """
import signal, sys, time
log = sys.argv[1]
def on_term(signum, frame):
    with open(log, "a") as stream:
        stream.write("TERM\\n")
signal.signal(signal.SIGTERM, on_term)
with open(log, "a") as stream:
    stream.write("ready\\n")
while True:
    time.sleep(0.05)
"""

STRAGGLING_RUNNER = """#!/usr/bin/env bash
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
python3 "$STRAGGLER" "$STRAGGLER_LOG" </dev/null >/dev/null 2>&1 &
echo "$!" > "$STRAGGLER_PID"
while ! grep -q ready "$STRAGGLER_LOG" 2>/dev/null; do sleep 0.01; done
printf 'VERDICT: READY\\n' > "$out"
"""


def test_multi_task_completed_runner_group_is_stopped_before_reaping(tmp_path, standin):
    # A runner that completes normally may leave a same-group descendant with
    # its output redirected: it still gets SIGTERM, then SIGKILL.
    runner = tmp_path / "run_opencode.sh"
    runner.write_text(STRAGGLING_RUNNER)
    runner.chmod(0o755)
    straggler = tmp_path / "straggler.py"
    straggler.write_text(STRAGGLER)
    prompt = tmp_path / "prompt.md"
    prompt.write_text("synthetic test\n")
    straggler_log, straggler_pid = tmp_path / "straggler.log", tmp_path / "straggler.pid"
    env, log = _child_env(tmp_path, standin)
    env.update(REVIEW_SWARM_NO_AUTO_CONFIG="1", STRAGGLER=str(straggler),
               STRAGGLER_LOG=str(straggler_log), STRAGGLER_PID=str(straggler_pid))
    proc = subprocess.run([sys.executable, str(RUN_MULTI_TASK), "--out-dir", str(tmp_path / "out"),
                           "--opencode-runner", str(runner), "--system", str(prompt), "--prompt", str(prompt),
                           "--models", "some-provider/model-a", "--timeout-secs", "120"],
                          env=env, capture_output=True, text=True, timeout=60)
    pid = int(straggler_pid.read_text())
    try:
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        assert proc.returncode == 0, proc.stderr
        assert kernel.wait_gone(pid), "the completed runner's straggler survived"
        assert "TERM" in straggler_log.read_text(), "the straggler got no SIGTERM before SIGKILL"
    finally:
        if not kernel.gone(pid):
            os.kill(pid, signal.SIGKILL)


def test_multi_task_owns_sigchld_when_started_with_it_ignored(tmp_path, standin):
    # The completed-runner case above, with SIGCHLD ignored by the caller.
    runner = tmp_path / "run_opencode.sh"
    runner.write_text(STRAGGLING_RUNNER)
    runner.chmod(0o755)
    straggler = tmp_path / "straggler.py"
    straggler.write_text(STRAGGLER)
    prompt = tmp_path / "prompt.md"
    prompt.write_text("synthetic test\n")
    straggler_log, straggler_pid = tmp_path / "straggler.log", tmp_path / "straggler.pid"
    env, log = _child_env(tmp_path, standin)
    env.update(REVIEW_SWARM_NO_AUTO_CONFIG="1", STRAGGLER=str(straggler),
               STRAGGLER_LOG=str(straggler_log), STRAGGLER_PID=str(straggler_pid))
    preexec = kernel.ignore_sigchld_for_children(env)
    proc = subprocess.run([sys.executable, str(RUN_MULTI_TASK), "--out-dir", str(tmp_path / "out"),
                           "--opencode-runner", str(runner), "--system", str(prompt), "--prompt", str(prompt),
                           "--models", "some-provider/model-a", "--timeout-secs", "120"],
                          env=env, capture_output=True, text=True, timeout=60, preexec_fn=preexec)
    pid = int(straggler_pid.read_text())
    try:
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        _assert_no_echild(proc.stderr)
        assert proc.returncode == 0, proc.stderr
        assert kernel.wait_gone(pid), "the completed runner's straggler survived"
        assert "TERM" in straggler_log.read_text(), "the straggler got no SIGTERM before SIGKILL"
    finally:
        if not kernel.gone(pid):
            os.kill(pid, signal.SIGKILL)


# The same runner, but the straggler inherits the runner's stdout and stderr,
# so the pipes stay open until the straggler is stopped.
INHERITING_RUNNER = STRAGGLING_RUNNER.replace(
    'python3 "$STRAGGLER" "$STRAGGLER_LOG" </dev/null >/dev/null 2>&1 &',
    'python3 "$STRAGGLER" "$STRAGGLER_LOG" </dev/null &')


def test_multi_task_completed_runner_group_is_stopped_before_pipe_eof(tmp_path, standin):
    # A runner that completes normally may leave a same-group descendant that
    # inherited its stdout and stderr: the group is stopped (SIGTERM, then
    # SIGKILL) and the runner reaped without waiting for end of file.
    assert INHERITING_RUNNER != STRAGGLING_RUNNER
    runner = tmp_path / "run_opencode.sh"
    runner.write_text(INHERITING_RUNNER)
    runner.chmod(0o755)
    straggler = tmp_path / "straggler.py"
    straggler.write_text(STRAGGLER)
    prompt = tmp_path / "prompt.md"
    prompt.write_text("synthetic test\n")
    straggler_log, straggler_pid = tmp_path / "straggler.log", tmp_path / "straggler.pid"
    env, log = _child_env(tmp_path, standin)
    env.update(REVIEW_SWARM_NO_AUTO_CONFIG="1", STRAGGLER=str(straggler),
               STRAGGLER_LOG=str(straggler_log), STRAGGLER_PID=str(straggler_pid))
    proc = subprocess.Popen([sys.executable, str(RUN_MULTI_TASK), "--out-dir", str(tmp_path / "out"),
                             "--opencode-runner", str(runner), "--system", str(prompt), "--prompt", str(prompt),
                             "--models", "some-provider/model-a", "--timeout-secs", "0"],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        try:
            _, stderr = proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            pytest.fail("run_multi_task waited for the straggler's end of file instead of stopping its group")
        pid = int(straggler_pid.read_text())
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        assert proc.returncode == 0, stderr
        assert kernel.wait_gone(pid), "the completed runner's straggler survived"
        assert "TERM" in straggler_log.read_text(), "the straggler got no SIGTERM before SIGKILL"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if straggler_pid.exists():
            pid = int(straggler_pid.read_text())
            if not kernel.gone(pid):
                os.kill(pid, signal.SIGKILL)


# A runner that records each SIGTERM it sees and keeps running (only SIGKILL
# stops it), so the stop spends its whole grace period sleeping.
TERM_COUNTING_RUNNER = """#!/usr/bin/env bash
exec python3 - "$@" <<'PY'
import os, signal, time
from pathlib import Path
log = Path(os.environ["STUB_READY_DIR"]) / str(os.getpid())
def on_term(signum, frame):
    with open(log, "a") as stream:
        stream.write("TERM\\n")
signal.signal(signal.SIGTERM, on_term)
log.write_text("ready\\n")
while True:
    time.sleep(0.05)
PY
"""


@pytest.mark.parametrize("parallel", ["--parallel", "--no-parallel"])
def test_multi_task_stop_survives_repeated_signals(tmp_path, standin, parallel):
    # Signals arriving while the stop sleeps through its grace period must not
    # start another stop inside it: the runner sees exactly one SIGTERM.
    runner = tmp_path / "run_opencode.sh"
    runner.write_text(TERM_COUNTING_RUNNER)
    runner.chmod(0o755)
    prompt = tmp_path / "prompt.md"
    prompt.write_text("synthetic test\n")
    ready = tmp_path / "ready"
    ready.mkdir()
    env, log = _child_env(tmp_path, standin)
    env.update(REVIEW_SWARM_NO_AUTO_CONFIG="1", STUB_READY_DIR=str(ready))
    proc = subprocess.Popen([sys.executable, str(RUN_MULTI_TASK), "--out-dir", str(tmp_path / "out"),
                             "--opencode-runner", str(runner), "--system", str(prompt), "--prompt", str(prompt),
                             "--models", "some-provider/model-a", parallel, "--timeout-secs", "120"],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    runners: list[int] = []
    try:
        deadline = time.monotonic() + 30
        while not any("ready" in p.read_text() for p in ready.iterdir()):
            assert time.monotonic() < deadline and proc.poll() is None, "stub runner did not start"
            time.sleep(0.02)
        runners = [int(p.name) for p in ready.iterdir()]
        # All within 0.6 s, well inside the 2 s grace the ignoring runner forces.
        for _ in range(60):
            proc.send_signal(signal.SIGTERM)
            time.sleep(0.01)
        _, stderr = proc.communicate(timeout=30)
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        assert proc.returncode == 128 + signal.SIGTERM, stderr
        for pid in runners:
            assert kernel.wait_gone(pid), "a stub runner survived the stop"
            assert (ready / str(pid)).read_text().count("TERM") == 1, "the stop was restarted inside itself"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for pid in runners:
            if not kernel.gone(pid):
                os.kill(pid, signal.SIGKILL)


# A runner that leaves a same-group straggler (records and ignores SIGTERM)
# and keeps running until a signal stops it.
STOPPED_RUNNER = """#!/usr/bin/env bash
python3 "$STRAGGLER" "$STRAGGLER_LOG" </dev/null >/dev/null 2>&1 &
echo "$!" > "$STRAGGLER_PID"
while ! grep -q ready "$STRAGGLER_LOG" 2>/dev/null; do sleep 0.01; done
exec python3 -c 'import os, pathlib, time; pathlib.Path(os.environ["STUB_READY_DIR"], str(os.getpid())).write_text(""); time.sleep(60)'
"""


def test_multi_task_stop_owns_sigchld_when_started_with_it_ignored(tmp_path, standin):
    # A stop while the runner runs, with SIGCHLD ignored by the caller: the
    # runner dies of the SIGTERM while its straggler holds the group through
    # the grace; the group may be signalled again (grace checks, SIGKILL)
    # only while the runner is still unreaped.
    runner = tmp_path / "run_opencode.sh"
    runner.write_text(STOPPED_RUNNER)
    runner.chmod(0o755)
    straggler = tmp_path / "straggler.py"
    straggler.write_text(STRAGGLER)
    prompt = tmp_path / "prompt.md"
    prompt.write_text("synthetic test\n")
    ready = tmp_path / "ready"
    ready.mkdir()
    straggler_log, straggler_pid = tmp_path / "straggler.log", tmp_path / "straggler.pid"
    env, log = _child_env(tmp_path, standin)
    env.update(REVIEW_SWARM_NO_AUTO_CONFIG="1", STUB_READY_DIR=str(ready), STRAGGLER=str(straggler),
               STRAGGLER_LOG=str(straggler_log), STRAGGLER_PID=str(straggler_pid))
    preexec = kernel.ignore_sigchld_for_children(env)
    proc = subprocess.Popen([sys.executable, str(RUN_MULTI_TASK), "--out-dir", str(tmp_path / "out"),
                             "--opencode-runner", str(runner), "--system", str(prompt), "--prompt", str(prompt),
                             "--models", "some-provider/model-a", "--no-parallel", "--timeout-secs", "120"],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            preexec_fn=preexec)
    pids: list[int] = []
    try:
        deadline = time.monotonic() + 30
        while not list(ready.iterdir()):
            assert time.monotonic() < deadline and proc.poll() is None, "stub runner did not start"
            time.sleep(0.02)
        pids = [int(p.name) for p in ready.iterdir()] + [int(straggler_pid.read_text())]
        proc.send_signal(signal.SIGTERM)
        _, stderr = proc.communicate(timeout=30)
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        _assert_no_echild(stderr)
        assert proc.returncode == 128 + signal.SIGTERM, stderr
        for pid in pids:
            assert kernel.wait_gone(pid), "the runner or its straggler survived the stop"
        assert "TERM" in straggler_log.read_text(), "the straggler got no SIGTERM before SIGKILL"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for pid in pids:
            if not kernel.gone(pid):
                os.kill(pid, signal.SIGKILL)


def test_multi_task_stop_between_spawn_and_registration(tmp_path, standin):
    # Sequential mode spawns on the main thread, where the stop handler runs:
    # a stop arriving right after Popen() must still reach the new runner.
    runner = tmp_path / "run_opencode.sh"
    runner.write_text(STUB_RUNNER)
    runner.chmod(0o755)
    prompt = tmp_path / "prompt.md"
    prompt.write_text("synthetic test\n")
    ready = tmp_path / "ready"
    ready.mkdir()
    spawned = tmp_path / "spawned.pids"
    env, log = _child_env(tmp_path, standin)
    env.update(REVIEW_SWARM_NO_AUTO_CONFIG="1", STUB_READY_DIR=str(ready),
               GROUP_SIGNAL_TERM_AFTER_SPAWN=str(runner), GROUP_SIGNAL_SPAWN_PIDS=str(spawned))
    proc = subprocess.run([sys.executable, str(RUN_MULTI_TASK), "--out-dir", str(tmp_path / "out"),
                           "--opencode-runner", str(runner), "--system", str(prompt), "--prompt", str(prompt),
                           "--models", "some-provider/model-a", "--no-parallel", "--timeout-secs", "120"],
                          env=env, capture_output=True, text=True, timeout=60)
    runners = [int(line) for line in spawned.read_text().split()]
    try:
        assert len(runners) == 1
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        assert proc.returncode == 128 + signal.SIGTERM, proc.stderr
        assert kernel.wait_gone(runners[0]), "the runner spawned just before the stop survived"
    finally:
        for pid in runners:
            if not kernel.gone(pid):
                os.kill(pid, signal.SIGKILL)


def test_multi_task_signal_group_treats_eperm_as_nothing_left(monkeypatch):
    monkeypatch.syspath_prepend(str(RUN_MULTI_TASK.parent))
    module = _load("run_multi_task_group_signals", RUN_MULTI_TASK)
    monkeypatch.setattr(os, "killpg", kernel.emulated_killpg(os.killpg))
    proc = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
    try:
        kernel.wait_zombie(proc.pid)
        with module._PROCESS_LOCK:
            module._ACTIVE_PROCESSES.add(proc)
        assert module._signal_group(proc, signal.SIGTERM) is False
    finally:
        module._ACTIVE_PROCESSES.discard(proc)
        proc.wait()


# --- smoke_run_multi_task_real.py --------------------------------------------

def test_smoke_timeout_kill_treats_eperm_as_nothing_left(monkeypatch):
    module = _load("smoke_run_multi_task_real_group_signals", SMOKE)
    monkeypatch.setattr(os, "killpg", kernel.emulated_killpg(os.killpg))

    def child_exited(pid, timeout):
        # The deadline falls due just after the CLI exited but before the reap.
        kernel.wait_zombie(pid)
        return False

    monkeypatch.setattr(module, "_child_exited", child_exited)
    result = module._run_with_timeout([sys.executable, "-c", "pass"], 60)
    assert result.timed_out is True
    assert result.exit_code is None


def _smoke_with_late_signal_log(tmp_path, standin, monkeypatch, name):
    module = _load(name, SMOKE)
    monkeypatch.setattr(module, "_STOP_GRACE_SECS", 0.5, raising=False)
    log = tmp_path / "late-signals.log"
    log.touch()
    monkeypatch.setattr(os, "killpg", kernel.emulated_killpg(os.killpg, standin.proc.pid, str(log)))
    workdir = tmp_path / "work"
    workdir.mkdir()
    fake = tmp_path / "fake_cli.py"
    fake.write_text(FAKE_CLI)
    return module, log, workdir, fake


def test_smoke_timeout_sends_sigterm_before_sigkill(tmp_path, standin, monkeypatch):
    module, log, workdir, fake = _smoke_with_late_signal_log(
        tmp_path, standin, monkeypatch, "smoke_run_multi_task_real_group_stop")
    real_child_exited = module._child_exited

    def child_exited(pid, timeout):
        # The deadline falls due once the CLI and its descendants are running;
        # the CLI is still running then, as it would be at any real deadline.
        _wait_file(workdir / "descendants.ready")
        assert not real_child_exited(pid, 0)
        return False

    monkeypatch.setattr(module, "_child_exited", child_exited)
    result = module._run_with_timeout([sys.executable, str(fake), "sleeps", str(workdir)], 60)
    assert log.read_text() == "", "a group was signalled after its leader was reaped"
    assert standin.alive()
    assert result.timed_out is True
    _assert_descendants_stopped(workdir)


def test_smoke_completed_cli_group_is_stopped_before_reaping(tmp_path, standin, monkeypatch):
    # A CLI that exits normally may leave same-group descendants with their
    # output redirected: they still get SIGTERM, then SIGKILL, while the CLI
    # is unreaped (a signal after the reap would be logged as late).
    module, log, workdir, fake = _smoke_with_late_signal_log(
        tmp_path, standin, monkeypatch, "smoke_run_multi_task_real_completed")
    result = module._run_with_timeout([sys.executable, str(fake), "quiet-descendants", str(workdir)], 60)
    assert log.read_text() == "", "a group was signalled after its leader was reaped"
    assert standin.alive()
    assert result.timed_out is False
    assert result.exit_code == 0, result.stderr
    _assert_descendants_stopped(workdir)


SMOKE_MAIN = """
import importlib.util, sys
smoke, fake, workdir, root = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("smoke_run_multi_task_real", smoke)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._STOP_GRACE_SECS = 0.5
# The fake CLI stands in for run_multi_task; main() is otherwise unchanged.
module._build_cmd = lambda **_: [sys.executable, fake, "quiet-descendants", workdir]
sys.argv = [smoke, "--backends", "opencode", "--timeout-secs", "60", "--work-dir", root]
raise SystemExit(module.main())
"""


def test_smoke_owns_sigchld_when_started_with_it_ignored(tmp_path, standin):
    workdir = tmp_path / "work"
    workdir.mkdir()
    fake = tmp_path / "fake_cli.py"
    fake.write_text(FAKE_CLI)
    env, log = _child_env(tmp_path, standin)
    preexec = kernel.ignore_sigchld_for_children(env)
    root = tmp_path / "smoke"
    proc = subprocess.run([sys.executable, "-c", SMOKE_MAIN, str(SMOKE), str(fake), str(workdir), str(root)],
                          env=env, capture_output=True, text=True, timeout=60, preexec_fn=preexec)
    try:
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        _assert_no_echild(proc.stderr)
        # The fake CLI writes no review output, so the smoke case itself fails (1).
        assert proc.returncode == 1, proc.stderr
        row = json.loads((root / "smoke_summary.json").read_text())["results"][0]
        assert (row["timed_out"], row["exit_code"]) == (False, 0), row
        _assert_descendants_stopped(workdir)
    finally:
        _kill_survivors(workdir)


# --- independent_reproduction_check.py (standalone) --------------------------

def test_reproduction_check_owns_sigchld_when_started_with_it_ignored(tmp_path, standin):
    # The entry's shell exits normally while a descendant that records and
    # ignores SIGTERM still runs in its group.
    project = tmp_path / "proj"
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    manifest.parent.mkdir(parents=True)
    descendant = project / "descendant.py"
    descendant.write_text(STRAGGLER)
    descendant_log, descendant_pid = tmp_path / "descendant.log", tmp_path / "descendant.pid"
    q = shlex.quote
    entry = (f"{q(sys.executable)} descendant.py {q(str(descendant_log))} </dev/null >/dev/null 2>&1 & "
             f"echo $! > {q(str(descendant_pid))}; "
             f"while ! grep -q ready {q(str(descendant_log))} 2>/dev/null; do sleep 0.01; done; "
             "echo 'final value = 1.5'")
    manifest.write_text(json.dumps({
        "manifest_version": 1, "entry_command": entry, "working_inputs": ["descendant.py"],
        "timeout_seconds": 60, "environment_note": "test interpreter; no network",
        "expected": [{"id": "value", "stdout_pattern": r"final value = ([-+0-9.eE]+)",
                      "value": 1.5, "tolerance": {"kind": "absolute", "value": 1e-9}}]}))
    env, log = _child_env(tmp_path, standin)
    preexec = kernel.ignore_sigchld_for_children(env)
    work = tmp_path / "check"
    proc = subprocess.run([sys.executable, str(REPRODUCTION_CHECK), "--manifest", str(manifest),
                           "--project-root", str(project), "--isolation", "copy", "--work-dir", str(work)],
                          env=env, capture_output=True, text=True, timeout=60, preexec_fn=preexec)
    pid = int(descendant_pid.read_text())
    try:
        report = json.loads((work / "report.json").read_text())
        assert log.read_text() == "", "a group was signalled after its leader was reaped"
        assert standin.alive()
        _assert_no_echild(proc.stderr)
        assert report["errors"] == [], report["errors"]
        assert report["entry"]["exit_code"] == 0, report["entry"]
        assert (proc.returncode, report["verdict"]) == (0, "reproduced"), proc.stderr
        assert kernel.wait_gone(pid), "the entry's descendant survived"
        assert "TERM" in descendant_log.read_text(), "the descendant got no SIGTERM before SIGKILL"
    finally:
        if not kernel.gone(pid):
            os.kill(pid, signal.SIGKILL)
