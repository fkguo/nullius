"""CLI checks for source/brief identity aliases, independent of metadata layout."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import unicodedata
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "task_brief.py"
BRIEF = "artifacts/runs/alias-check/task.md"
BODY = "Facts retained as written. 未决项保持可见。\r\n".encode()


def fixture(tmp_path):
    root = tmp_path / "project"
    brief = root / BRIEF
    brief.parent.mkdir(parents=True)
    brief.write_bytes(BODY)
    brief.chmod(0o640)
    (root / "inputs").mkdir()
    for name in ("first.md", "second.md"):
        path = root / "inputs" / name
        path.write_bytes(b"identical original source bytes\n")
        path.chmod(0o600)
    return root


def run(root, action, *sources, brief=BRIEF):
    args = [sys.executable, str(SCRIPT), action, "--project-root", str(root), "--brief", brief]
    for source in sources:
        args += ["--source", source]
    result = subprocess.run(args, capture_output=True, timeout=15,
                            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    try:
        report = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError):
        pytest.fail(f"non-JSON CLI output: {result.returncode}, {result.stdout!r}, {result.stderr!r}")
    return result.returncode, report


def snapshot(root):
    result = {}
    for path in root.rglob("*"):
        info = path.lstat()
        result[path.relative_to(root).as_posix()] = (
            stat.S_IFMT(info.st_mode), stat.S_IMODE(info.st_mode),
            info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size,
            path.read_bytes() if path.is_file() else None,
        )
    return result


def captured(root, *sources):
    code, report = run(root, "capture", *sources)
    assert (code, report.get("status")) == (0, "captured"), report


def rejected_without_writes(root, action, *sources, brief=BRIEF):
    before = snapshot(root)
    code, report = run(root, action, *sources, brief=brief)
    assert (code, report.get("status")) == (2, "invalid"), report
    assert snapshot(root) == before


def link(source, destination):
    try:
        os.link(source, destination)
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"filesystem does not support hard links for this fixture: {exc}")


def test_equal_bytes_in_distinct_files_are_not_duplicate_identity(tmp_path):
    root = fixture(tmp_path)
    first, second = root / "inputs/first.md", root / "inputs/second.md"
    assert first.read_bytes() == second.read_bytes()
    assert not first.samefile(second)
    captured(root, "inputs/first.md", "inputs/second.md")
    code, report = run(root, "check")
    assert (code, report.get("status")) == (0, "fresh"), report
    assert (root / BRIEF).read_bytes().endswith(BODY)


def test_capture_rejects_two_hardlinked_source_names(tmp_path):
    root = fixture(tmp_path)
    alias = root / "inputs/linked.md"
    link(root / "inputs/first.md", alias)
    rejected_without_writes(root, "capture", "inputs/first.md", "inputs/linked.md")


def test_capture_rejects_brief_hardlink_as_source(tmp_path):
    root = fixture(tmp_path)
    link(root / BRIEF, root / "inputs/brief-copy.md")
    rejected_without_writes(root, "capture", "inputs/brief-copy.md")


def test_check_rejects_sources_that_became_hardlink_aliases(tmp_path):
    root = fixture(tmp_path)
    captured(root, "inputs/first.md", "inputs/second.md")
    (root / "inputs/second.md").unlink()
    link(root / "inputs/first.md", root / "inputs/second.md")
    rejected_without_writes(root, "check")


def test_check_rejects_source_replaced_by_a_hardlink_to_brief(tmp_path):
    root = fixture(tmp_path)
    captured(root, "inputs/first.md")
    (root / "inputs/first.md").unlink()
    link(root / BRIEF, root / "inputs/first.md")
    rejected_without_writes(root, "check")


@pytest.mark.parametrize("alternate", ["inputs/./first.md", "inputs//first.md"])
def test_capture_rejects_duplicate_source_with_alternate_path_spelling(tmp_path, alternate):
    root = fixture(tmp_path)
    assert (root / alternate).samefile(root / "inputs/first.md")
    rejected_without_writes(root, "capture", "inputs/first.md", alternate)


@pytest.mark.parametrize("alternate", ["artifacts/runs/alias-check/./task.md", "artifacts/runs/alias-check//task.md"])
def test_capture_rejects_self_reference_with_alternate_path_spelling(tmp_path, alternate):
    root = fixture(tmp_path)
    assert (root / alternate).samefile(root / BRIEF)
    rejected_without_writes(root, "capture", alternate)


def test_capture_rejects_source_case_alias_on_case_insensitive_host(tmp_path):
    root = fixture(tmp_path)
    alias = root / "inputs/FIRST.md"
    if not alias.exists() or not alias.samefile(root / "inputs/first.md"):
        pytest.skip("host filesystem has no case alias for this fixture")
    rejected_without_writes(root, "capture", "inputs/first.md", "inputs/FIRST.md")


def test_capture_rejects_brief_case_alias_on_case_insensitive_host(tmp_path):
    root = fixture(tmp_path)
    alias = root / "artifacts/runs/alias-check/TASK.md"
    if not alias.exists() or not alias.samefile(root / BRIEF):
        pytest.skip("host filesystem has no case alias for this fixture")
    rejected_without_writes(root, "capture", "artifacts/runs/alias-check/TASK.md")


def test_capture_rejects_unicode_normalization_alias_when_host_provides_it(tmp_path):
    root = fixture(tmp_path)
    canonical = "inputs/caf\u00e9.md"
    alternate = unicodedata.normalize("NFD", canonical)
    assert canonical != alternate
    (root / canonical).write_bytes(b"original Unicode-name source\n")
    alias = root / alternate
    if not alias.exists() or not alias.samefile(root / canonical):
        pytest.skip("host filesystem has no Unicode normalization alias for this fixture")
    rejected_without_writes(root, "capture", canonical, alternate)
