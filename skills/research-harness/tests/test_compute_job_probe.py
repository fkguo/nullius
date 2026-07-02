"""Tests for the compute-job liveness/progress/stall probe."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "compute_job_probe.py"
_spec = importlib.util.spec_from_file_location("compute_job_probe", _MOD)
cjp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cjp)


# --- pure verdict logic ---

def test_decide_running_when_checkpoint_advancing():
    assert cjp.decide(True, 5, 10, [3, 4, 5], 3) == "running"


def test_decide_stalled_when_flat_across_full_window():
    assert cjp.decide(True, 5, 10, [5, 5, 5], 3) == "stalled"


def test_decide_not_stalled_before_window_fills():
    assert cjp.decide(True, 5, 10, [5, 5], 3) == "running"


def test_decide_completed():
    assert cjp.decide(False, 10, 10, [9, 10], 3) == "completed"
    assert cjp.decide(False, 12, 10, [12], 3) == "completed"


def test_decide_killed_incomplete():
    assert cjp.decide(False, 4, 10, [3, 4], 3) == "killed_incomplete"


def test_decide_stopped_when_no_expected_target():
    assert cjp.decide(False, 4, None, [4], 3) == "stopped"


def test_decide_deadline_reached_is_not_a_crash():
    # marker + stopped-incomplete -> deadline_reached, with or without an expected target
    assert cjp.decide(False, 4, 10, [3, 4], 3, deadline_fired=True) == "deadline_reached"
    assert cjp.decide(False, 4, None, [4], 3, deadline_fired=True) == "deadline_reached"


def test_decide_completed_wins_over_stale_deadline_marker():
    # all expected units landed -> completed, even if the marker was left behind
    assert cjp.decide(False, 10, 10, [10], 3, deadline_fired=True) == "completed"


def test_decide_running_verdicts_ignore_deadline_marker():
    # a demonstrably alive job stays running/stalled; a leftover marker is stale
    assert cjp.decide(True, 5, 10, [3, 4, 5], 3, deadline_fired=True) == "running"
    assert cjp.decide(True, 5, 10, [5, 5, 5], 3, deadline_fired=True) == "stalled"


# --- checkpoint counting ---

def test_count_checkpoint_lines(tmp_path):
    assert cjp.count_checkpoint_lines(None) == 0
    assert cjp.count_checkpoint_lines(tmp_path / "missing.tsv") == 0
    f = tmp_path / "ck.tsv"
    f.write_text("a\t1\nb\t2\nc\t3\n", encoding="utf-8")
    assert cjp.count_checkpoint_lines(f) == 3


# --- probe end-to-end (no matching process) ---

def test_probe_not_running_is_killed_incomplete(tmp_path):
    ck = tmp_path / "ck.tsv"
    ck.write_text("u1\t1\nu2\t2\n", encoding="utf-8")
    hist = tmp_path / "h.probe"
    r = cjp.probe("no_such_job_pattern_zzz_unlikely_xyz", ck, 5, hist, 3, now=1000.0)
    assert r["running"] is False
    assert r["checkpoint_count"] == 2
    assert r["verdict"] == "killed_incomplete"
    assert hist.exists()


def test_probe_deadline_marker_turns_stop_into_deadline_reached(tmp_path):
    ck = tmp_path / "ck.tsv"
    ck.write_text("u1\t1\nu2\t2\n", encoding="utf-8")
    marker = tmp_path / "ck.tsv.deadline"
    marker.write_text("", encoding="utf-8")
    hist = tmp_path / "h.probe"
    r = cjp.probe("no_such_job_pattern_zzz_unlikely_xyz", ck, 5, hist, 3, now=1000.0,
                  deadline_marker=marker)
    assert r["deadline_fired"] is True
    assert r["verdict"] == "deadline_reached"
    # absent marker path -> unchanged killed_incomplete
    r2 = cjp.probe("no_such_job_pattern_zzz_unlikely_xyz", ck, 5, hist, 3, now=1001.0,
                   deadline_marker=tmp_path / "missing.deadline")
    assert r2["deadline_fired"] is False
    assert r2["verdict"] == "killed_incomplete"


# --- probe integration: detect running, stall, then kill ---

def test_probe_detects_running_then_stall_then_kill(tmp_path):
    marker = f"probe_marker_{os.getpid()}_{int(time.time())}"
    script = tmp_path / f"{marker}.sh"
    script.write_text("#!/bin/sh\nsleep 30\n", encoding="utf-8")  # marker is in the script PATH -> sh command line
    script.chmod(0o755)
    proc = subprocess.Popen(["/bin/sh", str(script)])
    try:
        time.sleep(0.4)  # let the process appear in the table
        ck = tmp_path / "ck.tsv"
        ck.write_text("u1\t1\nu2\t2\n", encoding="utf-8")  # 2 lines that will NOT grow
        hist = tmp_path / "h.probe"
        verdicts = [cjp.probe(marker, ck, 10, hist, 3, now=1000.0 + i)["verdict"] for i in range(3)]
        # running + checkpoint flat across the 3-probe window -> stalled (livelock signal)
        assert verdicts == ["running", "running", "stalled"], verdicts
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    # after the process is gone: not running, count(2) < expected(10) -> relaunch
    r = cjp.probe(marker, ck, 10, hist, 3, now=2000.0)
    assert r["running"] is False
    assert r["verdict"] == "killed_incomplete"


def test_decide_outputs_are_in_verdicts_enum():
    cases = [
        (True, 5, 10, [3, 4, 5], 3),
        (True, 5, 10, [5, 5, 5], 3),
        (True, 5, 10, [5], 1),   # degenerate window -> never stalled
        (False, 10, 10, [10], 3),
        (False, 4, 10, [4], 3),
        (False, 4, None, [4], 3),
        (False, 4, 10, [4], 3, True),   # deadline marker present
        (False, 4, None, [4], 3, True),
    ]
    for c in cases:
        assert cjp.decide(*c) in cjp.VERDICTS, c
    # degenerate stall-window must not raise or falsely stall
    assert cjp.decide(True, 5, 10, [5], 1) == "running"
    assert cjp.decide(True, 5, 10, [5, 5], 0) == "running"


def test_cli_derives_default_deadline_marker_from_checkpoint(tmp_path):
    ck = tmp_path / "ck.tsv"
    ck.write_text("u1\t1\n", encoding="utf-8")
    (tmp_path / "ck.tsv.deadline").write_text("", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(_MOD), "--pattern", "no_such_job_pattern_zzz_unlikely_xyz",
         "--checkpoint", str(ck), "--expected", "5",
         "--history", str(tmp_path / "h.probe")],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(proc.stdout)
    assert data["deadline_marker"] == str(tmp_path / "ck.tsv.deadline")
    assert data["deadline_fired"] is True
    assert data["verdict"] == "deadline_reached"


def test_cli_explicit_deadline_marker_wins_over_derivation(tmp_path):
    ck = tmp_path / "ck.tsv"
    ck.write_text("u1\t1\n", encoding="utf-8")
    custom = tmp_path / "custom.dl"
    custom.write_text("", encoding="utf-8")  # only the EXPLICIT marker exists, not ck.tsv.deadline
    proc = subprocess.run(
        [sys.executable, str(_MOD), "--pattern", "no_such_job_pattern_zzz_unlikely_xyz",
         "--checkpoint", str(ck), "--expected", "5",
         "--history", str(tmp_path / "h.probe"),
         "--deadline-marker", str(custom)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(proc.stdout)
    assert data["deadline_marker"] == str(custom)
    assert data["deadline_fired"] is True
    assert data["verdict"] == "deadline_reached"


def test_cli_empty_deadline_marker_disables_deadline_probing(tmp_path):
    ck = tmp_path / "ck.tsv"
    ck.write_text("u1\t1\n", encoding="utf-8")
    (tmp_path / "ck.tsv.deadline").write_text("", encoding="utf-8")  # would fire if derivation ran
    proc = subprocess.run(
        [sys.executable, str(_MOD), "--pattern", "no_such_job_pattern_zzz_unlikely_xyz",
         "--checkpoint", str(ck), "--expected", "5",
         "--history", str(tmp_path / "h.probe"),
         "--deadline-marker", ""],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(proc.stdout)
    assert data["deadline_marker"] is None
    assert data["deadline_fired"] is False
    assert data["verdict"] == "killed_incomplete"


def test_cli_self_match_excludes_own_process(tmp_path):
    # The pattern "compute_job_probe" is literally in the probe's OWN argv;
    # the probe must exclude itself (and ancestors) and report not-running.
    ck = tmp_path / "ck.tsv"
    ck.write_text("u1\t1\n", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(_MOD), "--pattern", "compute_job_probe",
         "--checkpoint", str(ck), "--expected", "5",
         "--history", str(tmp_path / "h.probe")],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(proc.stdout)
    assert data["running"] is False, f"self-match not excluded: {data}"
    assert data["verdict"] == "killed_incomplete"


def test_ps_fallback_detects_running_marked_job(tmp_path):
    if shutil.which("ps") is None or not Path("/bin/ps").exists():
        return  # ps fallback not testable in this environment
    marker = f"psfallback_marker_{os.getpid()}_{int(time.time())}"
    script = tmp_path / f"{marker}.sh"
    script.write_text("#!/bin/sh\nsleep 30\n", encoding="utf-8")
    script.chmod(0o755)
    proc = subprocess.Popen(["/bin/sh", str(script)])
    try:
        time.sleep(0.4)
        ck = tmp_path / "ck.tsv"
        ck.write_text("u1\t1\n", encoding="utf-8")
        env = dict(os.environ)
        env["PATH"] = "/bin"  # no pgrep here -> forces the `ps` fallback (ps is /bin/ps)
        r = subprocess.run(
            [sys.executable, str(_MOD), "--pattern", marker,
             "--checkpoint", str(ck), "--expected", "5",
             "--history", str(tmp_path / "h.probe")],
            capture_output=True, text=True, env=env, check=True,
        )
        data = json.loads(r.stdout)
        assert data["running"] is True, f"ps fallback missed the job: {data} stderr={r.stderr}"
    finally:
        proc.terminate()
        proc.wait(timeout=5)
