"""A formatting pass must preserve valid row breaks, not guess TeX intent."""

from pathlib import Path
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/bin/markdown_hygiene.py"

CASES = [
    r"An aligned result: $\begin{aligned}a&=b\\c&=d\end{aligned}$.",
    r"A matrix: $\begin{smallmatrix}a&b\\c&d\end{smallmatrix}$.",
    r"A spaced row: $\begin{aligned}a&=b\\[2pt]c&=d\end{aligned}$.",
    "## Table of Contents\n\n- " + r"$\begin{smallmatrix}a&b\\c&d\end{smallmatrix}$" + "\n\n---\n",
    # Ambiguous escapes cannot be diagnosed from a backslash followed by a letter.
    r"The source supplied this expression: $\\Delta$.",
]


@pytest.mark.parametrize("source", CASES)
def test_check_and_fix_preserve_math_bytes(tmp_path, source):
    document = tmp_path / "math.md"
    original = (source + "\n").encode()
    document.write_bytes(original)
    for command in ("check", "fix", "fix-toc"):
        result = subprocess.run([sys.executable, str(SCRIPT), command, "--root", str(document)], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        assert document.read_bytes() == original
