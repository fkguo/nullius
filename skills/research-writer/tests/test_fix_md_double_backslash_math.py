r"""Tests for the deterministic Markdown double-backslash-in-math fixer.

Pins the core transformation: inside math regions, ``\\Delta`` -> ``\Delta``
(and ``\\_ \\^ \\*`` -> ``\_ \^ \*``) while genuine LaTeX line breaks (``\\``
NOT followed by a letter or ``*_^``) and everything outside math are preserved.
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "bin" / "fix_md_double_backslash_math.py"
_spec = importlib.util.spec_from_file_location("fix_md_double_backslash_math", _MOD)
fx = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = fx  # dataclasses on 3.12 needs the module registered
_spec.loader.exec_module(fx)


def _fix(text: str):
    return fx._fix_text(Path("doc.md"), text)


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(_MOD), *args],
        capture_output=True,
        text=True,
        check=False,
    )


# --- core transformation inside inline math ---

def test_inline_math_double_backslash_before_letter_is_fixed():
    new, changes = _fix(r"The value $\\Delta$ is small." + "\n")
    assert new == "The value $\\Delta$ is small.\n"
    assert [c.kind for c in changes] == ["inline_math_double_backslash"]


def test_inline_math_symbol_escapes_are_fixed():
    # \\_ -> \_ , \\^ -> \^ , \\* -> \*  inside inline math
    new, changes = _fix(r"$k^\\* + a\\_i + b\\^2$" + "\n")
    assert new == "$k^\\* + a\\_i + b\\^2$\n"
    assert len(changes) == 1


def test_multiple_fixes_on_one_line_counted_as_one_change_record():
    new, changes = _fix(r"$\\gamma \\Delta \\omega$" + "\n")
    assert new == "$\\gamma \\Delta \\omega$\n"
    # one Change record per line, though three substitutions happened
    assert len(changes) == 1
    assert changes[0].line == 1


# --- core transformation inside display math ---

def test_display_math_block_is_fixed():
    src = "before\n$$\n\\\\Delta = \\\\gamma\n$$\nafter\n"
    new, changes = _fix(src)
    assert new == "before\n$$\n\\Delta = \\gamma\n$$\nafter\n"
    assert [c.kind for c in changes] == ["display_math_double_backslash"]


# --- what MUST be preserved (negative cases) ---

def test_real_latex_line_break_outside_math_is_preserved():
    # A trailing '\\' line break (not before a letter/symbol) must survive.
    src = "plain text with a break \\\\\nnext line\n"
    new, changes = _fix(src)
    assert new == src
    assert changes == []


def test_line_break_inside_display_math_is_preserved():
    # In a matrix, '\\' followed by a newline is a genuine row break and must
    # NOT be collapsed; only '\\' immediately before a letter/symbol is fixed.
    src = "$$\na \\\\\nb \\\\Delta\n$$\n"
    new, changes = _fix(src)
    # row break after 'a' preserved; the '\\Delta' collapses to '\Delta'
    assert new == "$$\na \\\\\nb \\Delta\n$$\n"
    assert len(changes) == 1


def test_prose_double_backslash_outside_math_is_untouched():
    src = r"This \\Delta is not math and stays as-is." + "\n"
    new, changes = _fix(src)
    assert new == src
    assert changes == []


def test_fenced_code_block_is_never_touched():
    src = "```\n$\\\\Delta$\n```\n"
    new, changes = _fix(src)
    assert new == src
    assert changes == []


def test_inline_code_span_is_never_touched():
    # backticked code containing math-looking content must be preserved.
    src = "Use `$\\\\Delta$` in a span.\n"
    new, changes = _fix(src)
    assert new == src
    assert changes == []


def test_escaped_dollar_does_not_open_math():
    # A '\$' is a literal dollar, not a math delimiter, so nothing inside fixes.
    src = "price \\$5 and \\\\Delta stays\n"
    new, changes = _fix(src)
    assert new == src
    assert changes == []


def test_trailing_newline_preserved_and_absent_when_missing():
    with_nl = "$\\\\Delta$\n"
    new1, _ = _fix(with_nl)
    assert new1.endswith("\n")
    without_nl = "$\\\\Delta$"
    new2, _ = _fix(without_nl)
    assert not new2.endswith("\n")
    assert new2 == "$\\Delta$"


def test_no_changes_returns_input_unchanged():
    src = "Already clean $\\Delta$ math and prose.\n"
    new, changes = _fix(src)
    assert new == src
    assert changes == []


# --- CLI contract: exit codes 0/1/2 ---

def test_cli_missing_path_exits_2(tmp_path):
    r = _run_cli(["--root", str(tmp_path / "nope")])
    assert r.returncode == 2
    assert "not found" in (r.stdout + r.stderr)


def test_cli_reports_needed_fix_without_in_place_exit_1(tmp_path):
    md = tmp_path / "doc.md"
    md.write_text("$\\\\Delta$\n", encoding="utf-8")
    r = _run_cli(["--root", str(md)])
    assert r.returncode == 1
    assert "inline_math_double_backslash" in r.stdout
    # dry run: file untouched
    assert md.read_text(encoding="utf-8") == "$\\\\Delta$\n"


def test_cli_in_place_applies_and_exits_0(tmp_path):
    md = tmp_path / "doc.md"
    md.write_text("$\\\\Delta$\n", encoding="utf-8")
    r = _run_cli(["--root", str(md), "--in-place"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert md.read_text(encoding="utf-8") == "$\\Delta$\n"


def test_cli_clean_tree_exits_0(tmp_path):
    md = tmp_path / "doc.md"
    md.write_text("Clean $\\Delta$ only.\n", encoding="utf-8")
    r = _run_cli(["--root", str(tmp_path)])
    assert r.returncode == 0
    assert "No obvious double-backslash" in r.stdout
