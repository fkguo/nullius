"""Regression tests for the LaTeX evidence gate's brace-parity handling.

The macro-block scanner must treat a literal backslash (``\\``) followed by a real
``{group}`` as a genuine brace, not an escaped one. A naive ``text[idx-1] == '\\'``
check closed the macro group prematurely, truncating the scanned content and letting
a risky unanchored claim after ``\\{...}`` escape the fail-closed gate.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parents[1] / "scripts" / "bin" / "check_latex_evidence_gate.py"
_spec = importlib.util.spec_from_file_location("check_latex_evidence_gate", _MOD)
gate = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
# Register before exec so the module's @dataclass can resolve its own module.
sys.modules[_spec.name] = gate
_spec.loader.exec_module(gate)


def test_preceding_backslashes_odd():
    assert gate._preceding_backslashes_odd(r"\{", 1) is True      # \{   -> escaped brace
    assert gate._preceding_backslashes_odd(r"\\{", 2) is False    # \\{  -> literal backslash, real brace
    assert gate._preceding_backslashes_odd(r"\\\{", 3) is True    # \\\{ -> literal backslash + escaped brace
    assert gate._preceding_backslashes_odd("x{", 1) is False      # no backslash


def test_extract_macro_blocks_not_truncated_after_literal_backslash():
    # A literal backslash immediately before a real {group}: the group must NOT close
    # the macro scan early. Regression for the brace-parity bug.
    text = r"\revadd{a literal \\{group} here uniform}"
    blocks = gate._extract_macro_blocks(text, macros=["revadd"])
    assert len(blocks) == 1
    _macro, _start, _end, content = blocks[0]
    assert content == r"a literal \\{group} here uniform"
    assert "uniform" in content  # trailing text was NOT truncated


def _run_cli(args):
    return subprocess.run([sys.executable, str(_MOD), *args], capture_output=True, text=True)


def test_risky_claim_after_literal_backslash_is_caught(tmp_path):
    # A risky (systematic/uncertainty) UNANCHORED claim placed AFTER a \\{...} construct
    # must be caught by the fail-closed gate. Pre-fix, the brace bug truncated the scan
    # before this text and let the claim escape (exit 0).
    tex = tmp_path / "draft.tex"
    tex.write_text(
        r"\revadd{adds a literal \\{grp} systematic uncertainty with no anchor here}" + "\n",
        encoding="utf-8",
    )
    proc = _run_cli(["--tex", str(tex), "--fail"])
    assert proc.returncode == 2, proc.stdout + proc.stderr


def test_anchored_claim_after_literal_backslash_passes(tmp_path):
    # Same shape but with a real file-path anchor -> not a violation -> exit 0.
    tex = tmp_path / "draft.tex"
    tex.write_text(
        r"\revadd{adds a literal \\{grp} systematic uncertainty from artifacts/runs/r1/value.json}" + "\n",
        encoding="utf-8",
    )
    proc = _run_cli(["--tex", str(tex), "--fail"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
