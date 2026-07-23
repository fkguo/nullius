"""Golden tests for CODE-01 CI gate scripts (NEW-R02a)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from textwrap import dedent

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"


class TestCheckLoc:
    def test_under_limit_passes(self, tmp_path: Path) -> None:
        f = tmp_path / "small.py"
        f.write_text("x = 1\ny = 2\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "PASS" in result.stdout

    def test_over_limit_fails(self, tmp_path: Path) -> None:
        f = tmp_path / "big.py"
        f.write_text("\n".join(f"x_{i} = {i}" for i in range(250)) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1
        assert "FAIL" in result.stderr

    def test_exempt_skips(self, tmp_path: Path) -> None:
        f = tmp_path / "exempt.py"
        content = "# CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 bounded change\n" + "\n".join(
            f"x_{i} = {i}" for i in range(250)
        ) + "\n"
        f.write_text(content, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

    def test_typescript_exempt_skips(self, tmp_path: Path) -> None:
        f = tmp_path / "existing.ts"
        content = "// CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 bounded change\n" + "\n".join(
            f"const x_{i} = {i};" for i in range(250)
        )
        f.write_text(content + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

    @pytest.mark.parametrize(
        "marker",
        [
            "# CONTRACT-EXEMPT: CODE-01.1 missing sunset",
            "# CONTRACT-EXEMPT: CODE-01.1 sunset:2000-01-01 expired",
        ],
    )
    def test_invalid_exemption_fails(self, tmp_path: Path, marker: str) -> None:
        f = tmp_path / "invalid.py"
        f.write_text(marker + "\n" + "\n".join(f"x_{i} = {i}" for i in range(250)), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1

    def test_late_exemption_fails(self, tmp_path: Path) -> None:
        f = tmp_path / "late.py"
        prefix = "\n".join(f"x_{i} = {i}" for i in range(6))
        marker = "# CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 too late"
        body = "\n".join(f"y_{i} = {i}" for i in range(250))
        f.write_text(f"{prefix}\n{marker}\n{body}\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1

    def test_non_code_files_skipped(self, tmp_path: Path) -> None:
        f = tmp_path / "big.md"
        f.write_text("\n".join(f"line {i}" for i in range(500)) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

    def test_arbitrary_generated_directory_is_not_exempt(self, tmp_path: Path) -> None:
        generated = tmp_path / "generated"
        generated.mkdir()
        f = generated / "model.py"
        f.write_text("\n".join(f"x_{i} = {i}" for i in range(250)) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "200", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1

    def test_declared_generated_authority_is_outside_handwritten_gate(self) -> None:
        generated = SCRIPTS_DIR.parent / "packages" / "shared" / "src" / "generated" / "workflow-recipe-v1.ts"
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--max-eloc", "1", "--files", str(generated)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0


class TestCheckEntryFiles:
    def test_normal_filename_passes(self, tmp_path: Path) -> None:
        f = tmp_path / "parser.py"
        f.write_text("pass\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_entry_files.py"), "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "PASS" in result.stdout

    def test_prohibited_name_fails(self, tmp_path: Path) -> None:
        f = tmp_path / "utils.py"
        f.write_text("pass\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_entry_files.py"), "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1
        assert "FAIL" in result.stderr

    def test_prohibited_ts_fails(self, tmp_path: Path) -> None:
        f = tmp_path / "helpers.ts"
        f.write_text("export {};\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_entry_files.py"), "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1

    def test_exempt_passes(self, tmp_path: Path) -> None:
        f = tmp_path / "utils.py"
        f.write_text("# CONTRACT-EXEMPT: CODE-01.2\npass\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_entry_files.py"), "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
