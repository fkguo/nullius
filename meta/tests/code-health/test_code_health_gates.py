"""LOC diagnostics and the independent CODE-01 filename quality gate."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"


class TestCheckLoc:
    def test_small_file_is_reported_without_a_quality_verdict(self, tmp_path: Path) -> None:
        f = tmp_path / "small.py"
        f.write_text("x = 1\ny = 2\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "INFO" in result.stdout
        assert str(f) in result.stdout
        assert "PASS" not in result.stdout and "FAIL" not in result.stdout

    def test_large_file_is_reported_without_rejection(self, tmp_path: Path) -> None:
        f = tmp_path / "big.py"
        f.write_text("\n".join(f"x_{i} = {i}" for i in range(250)) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--json", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert json.loads(result.stdout)["files"][0]["eloc"] == 250

    def test_typescript_exemption_does_not_hide_size(self, tmp_path: Path) -> None:
        f = tmp_path / "existing.ts"
        content = "// CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 bounded change\n" + "\n".join(
            f"const x_{i} = {i};" for i in range(250)
        )
        f.write_text(content + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--json", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert json.loads(result.stdout)["files"][0]["eloc"] == 250

    def test_non_code_files_skipped(self, tmp_path: Path) -> None:
        f = tmp_path / "big.md"
        f.write_text("\n".join(f"line {i}" for i in range(500)) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--json", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert json.loads(result.stdout)["excluded"] == [{"path": str(f), "reason": "non_code"}]

    def test_arbitrary_generated_directory_is_not_exempt(self, tmp_path: Path) -> None:
        generated = tmp_path / "generated"
        generated.mkdir()
        f = generated / "model.py"
        f.write_text("\n".join(f"x_{i} = {i}" for i in range(250)) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--json", "--files", str(f)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert json.loads(result.stdout)["files"][0]["eloc"] == 250

    @pytest.mark.parametrize("relative", [
        "packages/shared/src/generated/workflow-recipe-v1.ts",
        "meta/generated/python/workflow_recipe_v1.py",
    ])
    def test_declared_generated_authority_is_explicitly_excluded(self, relative: str) -> None:
        generated = SCRIPTS_DIR.parent.parent / relative
        assert generated.is_file(), "fixture must name a real generated source, not a silently skipped missing path"
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--json", "--files", str(generated)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        payload = json.loads(result.stdout)
        assert payload["status"] == "no_files" and payload["files"] == []
        assert payload["excluded"] == [{"path": str(generated), "reason": "generated"}]
        assert payload["errors"] == []

    def test_external_lookalike_of_generated_authority_is_measured(self, tmp_path: Path) -> None:
        fake = tmp_path / "packages/shared/src/generated/handwritten.ts"
        fake.parent.mkdir(parents=True)
        fake.write_text("const value = 1;\n" * 250, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "check_loc.py"), "--json", "--files", str(fake)],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        payload = json.loads(result.stdout)
        assert payload["files"][0]["eloc"] == 250 and payload["excluded"] == []


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
