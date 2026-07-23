"""Adversarial coverage for CODE-01.1 exemption parsing."""

from __future__ import annotations

import runpy
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
VALID_HASH = "# CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 bounded change"
VALID_SLASH = "// CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 bounded change"


def _run_gate(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(path)],
        capture_output=True,
        text=True,
    )


def _write_oversized(path: Path, first_lines: list[str]) -> None:
    body = [f"value_{index} = {index}" for index in range(250)]
    path.write_text("\n".join([*first_lines, *body]) + "\n", encoding="utf-8")


@pytest.mark.parametrize(
    ("suffix", "lines"),
    [
        (".py", [VALID_HASH]),
        (".sh", ["#!/usr/bin/env bash", VALID_HASH]),
        (".ts", [VALID_SLASH]),
        (".tsx", [VALID_SLASH]),
        (".js", [VALID_SLASH]),
        (".jsx", [VALID_SLASH]),
        (".mjs", [VALID_SLASH]),
        (".mts", [VALID_SLASH]),
    ],
)
def test_language_correct_complete_exemption_passes(tmp_path: Path, suffix: str, lines: list[str]) -> None:
    path = tmp_path / f"valid{suffix}"
    _write_oversized(path, lines)
    assert _run_gate(path).returncode == 0


@pytest.mark.parametrize(
    ("suffix", "line"),
    [
        (".py", VALID_SLASH),
        (".sh", VALID_SLASH),
        (".ts", VALID_HASH),
        (".js", VALID_HASH),
    ],
)
def test_cross_language_comment_marker_fails(tmp_path: Path, suffix: str, line: str) -> None:
    path = tmp_path / f"wrong{suffix}"
    _write_oversized(path, [line])
    assert _run_gate(path).returncode == 1


@pytest.mark.parametrize(
    ("suffix", "line"),
    [
        (".py", f'marker = "{VALID_HASH}"'),
        (".sh", f"marker='{VALID_HASH}'"),
        (".ts", f'const marker = "{VALID_SLASH}";'),
        (".js", f'const marker = "{VALID_SLASH}";'),
    ],
)
def test_marker_inside_string_literal_fails(tmp_path: Path, suffix: str, line: str) -> None:
    path = tmp_path / f"string{suffix}"
    _write_oversized(path, [line])
    assert _run_gate(path).returncode == 1


@pytest.mark.parametrize(
    ("suffix", "lines"),
    [
        (".py", ['description = """', VALID_HASH, '"""']),
        (".sh", ["cat <<'DOCUMENT'", VALID_HASH, "DOCUMENT"]),
        (".ts", ["const description = `", VALID_SLASH, "`;"]),
        (".js", ["/*", VALID_SLASH, "*/"]),
    ],
)
def test_marker_inside_multiline_noncomment_construct_fails(
    tmp_path: Path, suffix: str, lines: list[str]
) -> None:
    path = tmp_path / f"multiline{suffix}"
    _write_oversized(path, lines)
    assert _run_gate(path).returncode == 1


@pytest.mark.parametrize(
    ("suffix", "line"),
    [
        (".py", f"value = 1  {VALID_HASH}"),
        (".sh", f"value=1  {VALID_HASH}"),
        (".ts", f"const value = 1; {VALID_SLASH}"),
        (".js", f"const value = 1; {VALID_SLASH}"),
    ],
)
def test_marker_after_code_fails(tmp_path: Path, suffix: str, line: str) -> None:
    path = tmp_path / f"trailing{suffix}"
    _write_oversized(path, [line])
    assert _run_gate(path).returncode == 1


@pytest.mark.parametrize(
    "line",
    [
        "# CONTRACT-EXEMPT: CODE-01.1 missing sunset",
        "# CONTRACT-EXEMPT: CODE-01.1 sunset:2000-01-01 expired",
        "# CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31",
    ],
)
def test_incomplete_or_expired_marker_fails(tmp_path: Path, line: str) -> None:
    path = tmp_path / "invalid.py"
    _write_oversized(path, [line])
    assert _run_gate(path).returncode == 1


def test_marker_after_first_five_physical_lines_fails(tmp_path: Path) -> None:
    path = tmp_path / "late.py"
    _write_oversized(path, ["", "", "", "", "", VALID_HASH])
    assert _run_gate(path).returncode == 1


def test_indented_pseudo_shebang_cannot_precede_exemption(tmp_path: Path) -> None:
    path = tmp_path / "pseudo-shebang.ts"
    _write_oversized(path, ["   #!/usr/bin/env node", VALID_SLASH])
    assert _run_gate(path).returncode == 1


def test_unknown_suffix_cannot_claim_exemption(tmp_path: Path) -> None:
    path = tmp_path / "unknown.rb"
    path.write_text(VALID_HASH + "\n", encoding="utf-8")
    module = runpy.run_path(str(SCRIPTS_DIR / "check_loc.py"), run_name="check_loc_test")
    assert module["is_exempt"](path) is False
