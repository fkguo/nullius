"""Tests for the compute-job liveness/progress/stall probe."""
from __future__ import annotations

import importlib.util
import os
import subprocess
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
