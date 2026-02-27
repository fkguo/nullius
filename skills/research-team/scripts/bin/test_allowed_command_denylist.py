#!/usr/bin/env python3
"""Regression tests for _allowed_command() denylist in run_member_review.py."""

import importlib.util
import pathlib
import pytest

# Import _allowed_command directly from run_member_review.py without running
# the script's argparse / __main__ block.
_SCRIPT = pathlib.Path(__file__).parent / "run_member_review.py"
_spec = importlib.util.spec_from_file_location("run_member_review", _SCRIPT)
_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]
_allowed_command = _mod._allowed_command


def _ok(cmd: str) -> bool:
    ok, _, _ = _allowed_command(cmd)
    return ok


def _denied(cmd: str) -> bool:
    return not _ok(cmd)


# ── bash/sh -c ───────────────────────────────────────────────────────────────

def test_bash_c_denied():
    assert _denied("bash -c echo")

def test_sh_c_denied():
    assert _denied("sh -c id")

def test_bash_script_allowed():
    assert _ok("bash /workspace/script.sh")

# ── python -c ────────────────────────────────────────────────────────────────

def test_python3_c_denied():
    assert _denied("python3 -c pass")

def test_python_c_denied():
    assert _denied("python -c pass")

def test_python_script_allowed():
    assert _ok("python3 /workspace/run.py")

# ── julia -e ─────────────────────────────────────────────────────────────────

def test_julia_e_denied():
    assert _denied("julia -e println")

def test_julia_eval_denied():
    assert _denied("julia --eval println")

def test_julia_script_allowed():
    assert _ok("julia /workspace/run.jl")

# ── find -exec ───────────────────────────────────────────────────────────────

def test_find_exec_denied():
    assert _denied("find /workspace -name x.py -exec cat x ;")

def test_find_execdir_denied():
    assert _denied("find /workspace -execdir ls x ;")

def test_find_ok_denied():
    assert _denied("find /workspace -ok rm x ;")

def test_find_name_allowed():
    assert _ok("find /workspace -name x.py")

# ── awk system/popen ─────────────────────────────────────────────────────────
# Note: shlex.split("awk 'BEGIN{system(\"id\")}'") → ["awk", 'BEGIN{system("id")}']

def test_awk_system_denied():
    assert _denied("awk 'BEGIN{system(\"id\")}'")

def test_awk_system_space_denied():
    # Regression for R17 BLOCKING: whitespace before '(' must not bypass check.
    assert _denied("awk 'BEGIN{system (\"id\")}'")

def test_awk_popen_denied():
    assert _denied("awk 'BEGIN{popen(\"id\",\"r\")}'")

def test_awk_popen_space_denied():
    assert _denied("awk 'BEGIN{popen (\"id\",\"r\")}'")

def test_awk_plain_print_allowed():
    assert _ok("awk '{print $1}'")

def test_gawk_system_denied():
    assert _denied("gawk 'BEGIN{system(\"id\")}'")
