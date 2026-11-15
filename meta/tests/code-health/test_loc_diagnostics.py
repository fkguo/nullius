"""Exercise real LOC diagnostics without treating file size as a quality verdict."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_loc.py"


def invoke(*args: str, cwd: Path | None = None, stdin: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], cwd=cwd, input=stdin,
        capture_output=True, text=True, timeout=10,
    )


def report(*args: str, cwd: Path | None = None, stdin: str = "") -> tuple[subprocess.CompletedProcess[str], dict]:
    process = invoke("--json", *args, cwd=cwd, stdin=stdin)
    payload = json.loads(process.stdout)
    assert payload["scope"] == "maintainability_context"
    return process, payload


def source(path: Path, lines: int, prefix: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(prefix + "".join(f"value_{index} = {index}\n" for index in range(lines)), encoding="utf-8")
    return path


@pytest.mark.parametrize("suffix", [".py", ".sh", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"])
def test_all_supported_sources_report_size_without_a_limit(tmp_path: Path, suffix: str) -> None:
    path = source(tmp_path / f"large{suffix}", 2001)
    process, payload = report("--files", str(path))
    assert process.returncode == 0, process.stderr
    assert payload["status"] == "reported"
    assert payload["files"] == [{"path": str(path), "eloc": 2001, "base_eloc": None, "delta_eloc": None}]
    assert payload["errors"] == []
    assert payload["excluded"] == []
    assert payload["base_ref"] is None and payload["base_commit"] is None


@pytest.mark.parametrize("prefix", [
    "# CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 bounded change\n",
    "# CONTRACT-EXEMPT: CODE-01.1 sunset:2000-01-01 expired\n",
    "# CONTRACT-EXEMPT: CODE-01.1 missing sunset\n",
    "// CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 other comment dialect\n",
    "\n" * 8 + "# CONTRACT-EXEMPT: CODE-01.1 sunset:2099-12-31 late marker\n",
])
def test_old_exemption_comments_never_hide_the_measured_file(tmp_path: Path, prefix: str) -> None:
    path = source(tmp_path / "existing.py", 250, prefix)
    process, payload = report("--files", str(path))
    assert process.returncode == 0, process.stderr
    assert payload["files"] == [{"path": str(path), "eloc": 250, "base_eloc": None, "delta_eloc": None}]
    assert payload["excluded"] == [] and payload["errors"] == []


def test_count_is_a_line_estimate_with_blank_and_comment_lines_excluded(tmp_path: Path) -> None:
    path = tmp_path / "estimate.py"
    path.write_text("\n# comment\n    # indented comment\nx = 1\n\ny = 2  # inline comment\n", encoding="utf-8")
    process, payload = report("--files", str(path))
    assert process.returncode == 0
    assert payload["files"][0]["eloc"] == 2


def test_plain_stdin_preserves_unicode_spaces_and_leading_whitespace(tmp_path: Path) -> None:
    names = ["研究 输入.py", " leading.py"]
    for index, name in enumerate(names, start=1):
        source(tmp_path / name, index)
    process, payload = report(cwd=tmp_path, stdin="\n".join(names) + "\n")
    assert process.returncode == 0, process.stderr
    assert {item["path"]: item["eloc"] for item in payload["files"]} == {names[0]: 1, names[1]: 2}


def test_nul_stdin_preserves_a_newline_inside_a_filename(tmp_path: Path) -> None:
    name = "研究\ninput.py"
    source(tmp_path / name, 3)
    process, payload = report("--null", cwd=tmp_path, stdin=name + "\0")
    assert process.returncode == 0, process.stderr
    assert payload["files"][0]["path"] == name
    assert payload["files"][0]["eloc"] == 3


def test_empty_stdin_reports_no_files_without_claiming_quality(tmp_path: Path) -> None:
    process, payload = report(cwd=tmp_path)
    assert process.returncode == 0
    assert payload["status"] == "no_files"
    assert payload["files"] == payload["excluded"] == payload["errors"] == []
    assert "PASS" not in process.stdout and "FAIL" not in process.stdout


@pytest.mark.parametrize("args", [
    ("--files",),
    ("--files", "one.py", "--base-ref", "HEAD"),
    ("--files", "one.py", "--null"),
    ("--base-ref", "HEAD", "--null"),
])
def test_invalid_selection_arguments_are_errors(tmp_path: Path, args: tuple[str, ...]) -> None:
    source(tmp_path / "one.py", 1)
    process = invoke(*args, cwd=tmp_path, stdin="one.py\n")
    assert process.returncode == 2
    assert "PASS" not in process.stdout


@pytest.mark.parametrize("name", ["missing.py", "missing.md"])
def test_missing_selected_path_is_not_silently_skipped(tmp_path: Path, name: str) -> None:
    source(tmp_path / "good.py", 2)
    process, payload = report("--files", "good.py", name, cwd=tmp_path)
    assert process.returncode == 2
    assert payload["status"] == "error"
    assert payload["files"][0]["path"] == "good.py"
    assert payload["files"][0]["eloc"] == 2
    assert any(error["path"] == name and error["message"] for error in payload["errors"])


@pytest.mark.parametrize("kind", ["directory", "symlink", "dangling_symlink", "fifo"])
def test_nonregular_selected_paths_fail_without_blocking(tmp_path: Path, kind: str) -> None:
    selected = tmp_path / "selected.py"
    if kind == "directory":
        selected.mkdir()
    elif kind == "fifo":
        if not hasattr(os, "mkfifo"):
            pytest.skip("FIFO creation is unavailable on this platform")
        os.mkfifo(selected)
    else:
        target = source(tmp_path / "target.py", 1) if kind == "symlink" else tmp_path / "missing.py"
        try:
            selected.symlink_to(target)
        except (OSError, NotImplementedError):
            pytest.skip("symlink creation is unavailable on this platform")
    process, payload = report("--files", str(selected))
    assert process.returncode == 2
    assert payload["status"] == "error" and payload["errors"]
    assert payload["files"] == []


@pytest.mark.parametrize("name", ["unreadable.py", "unreadable.md"])
def test_unreadable_file_is_an_error_before_measurement_or_exclusion(tmp_path: Path, name: str) -> None:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root can read chmod-zero files")
    path = source(tmp_path / name, 10)
    path.chmod(0)
    try:
        process, payload = report("--files", str(path))
    finally:
        path.chmod(0o600)
    assert process.returncode == 2
    assert payload["status"] == "error" and payload["errors"]
    assert payload["files"] == []


@pytest.mark.skipif(os.name != "posix", reason="requires a POSIX pseudo-terminal")
def test_interactive_stdin_requests_explicit_selection_without_hanging(tmp_path: Path) -> None:
    import pty

    master, slave = pty.openpty()
    try:
        process = subprocess.run(
            [sys.executable, str(SCRIPT), "--json"], cwd=tmp_path,
            stdin=slave, capture_output=True, text=True, timeout=5,
        )
    finally:
        os.close(slave)
        os.close(master)
    assert process.returncode == 2
    assert "--files" in process.stderr and "--base-ref" in process.stderr


def test_invalid_utf8_is_an_error_instead_of_replacement_text(tmp_path: Path) -> None:
    path = tmp_path / "invalid.py"
    path.write_bytes(b"value = 1\n\xff\n")
    process, payload = report("--files", str(path))
    assert process.returncode == 2
    assert payload["status"] == "error" and payload["errors"]
    assert payload["files"] == []


def test_multiple_input_errors_are_reported_with_successful_measurements(tmp_path: Path) -> None:
    source(tmp_path / "good.py", 3)
    (tmp_path / "bad.py").write_bytes(b"\xff")
    process, payload = report("--files", "missing.py", "good.py", "bad.py", cwd=tmp_path)
    assert process.returncode == 2
    assert payload["status"] == "error"
    assert payload["files"] == [{"path": "good.py", "eloc": 3, "base_eloc": None, "delta_eloc": None}]
    assert {error["path"] for error in payload["errors"]} == {"missing.py", "bad.py"}


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def git_project(tmp_path: Path) -> tuple[Path, str]:
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.name", "LOC fixture")
    git(tmp_path, "config", "user.email", "loc-fixture@example.invalid")
    git(tmp_path, "config", "commit.gpgsign", "false")
    for name in ("branch.py", "staged.py", "unstaged.py", "deleted-staged.py", "deleted-working.py", "upstream.py"):
        source(tmp_path / name, 2)
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "fixture base")
    return tmp_path, git(tmp_path, "rev-parse", "HEAD")


def test_base_ref_includes_branch_index_worktree_and_untracked_from_merge_base(git_project: tuple[Path, str]) -> None:
    root, base = git_project
    git(root, "checkout", "-qb", "work")
    source(root / "branch.py", 2001)
    git(root, "add", "branch.py")
    git(root, "commit", "-qm", "fixture branch change")
    git(root, "checkout", "-q", "main")
    source(root / "upstream.py", 8)
    git(root, "add", "upstream.py")
    git(root, "commit", "-qm", "fixture independent upstream change")
    git(root, "checkout", "-q", "work")
    source(root / "staged.py", 3)
    git(root, "add", "staged.py")
    source(root / "unstaged.py", 5)
    source(root / "新建 文件.py", 2100)
    git(root, "rm", "-q", "deleted-staged.py")
    (root / "deleted-working.py").unlink()

    process, payload = report("--base-ref", "main", cwd=root)
    assert process.returncode == 0, process.stderr
    assert payload["status"] == "reported"
    assert payload["base_ref"] == "main" and payload["base_commit"] == base
    measured = {item["path"]: (item["eloc"], item["base_eloc"], item["delta_eloc"]) for item in payload["files"]}
    assert measured == {
        "branch.py": (2001, 2, 1999), "staged.py": (3, 2, 1),
        "unstaged.py": (5, 2, 3), "新建 文件.py": (2100, 0, 2100),
    }
    assert payload["errors"] == []


def test_clean_base_ref_selection_is_explicitly_empty(git_project: tuple[Path, str]) -> None:
    root, base = git_project
    process, payload = report("--base-ref", "HEAD", cwd=root)
    assert process.returncode == 0
    assert payload["status"] == "no_files" and payload["base_commit"] == base
    assert payload["files"] == payload["errors"] == []


def test_untraversable_untracked_directory_reports_incomplete_selection(git_project: tuple[Path, str]) -> None:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root can traverse chmod-zero directories")
    root, _ = git_project
    source(root / "visible.py", 1)
    candidate = source(root / "unreadable-untracked" / "candidate.py", 3)
    directory = candidate.parent
    previous_mode = directory.stat().st_mode & 0o7777
    directory.chmod(0)
    try:
        try:
            candidate.read_bytes()
        except PermissionError:
            pass
        else:
            pytest.skip("this filesystem does not enforce the directory permission fixture")
        process, payload = report("--base-ref", "HEAD", cwd=root)
    finally:
        directory.chmod(previous_mode)
    assert process.returncode == 2
    assert payload["status"] == "error"
    assert any(error["path"] is None and directory.name in error["message"] for error in payload["errors"])


def test_staged_change_remains_selected_when_worktree_matches_baseline(git_project: tuple[Path, str]) -> None:
    root, _ = git_project
    source(root / "branch.py", 3)
    git(root, "add", "branch.py")
    source(root / "branch.py", 2)
    process, payload = report("--base-ref", "HEAD", cwd=root)
    assert process.returncode == 0
    assert payload["status"] == "reported"
    assert payload["files"] == [{"path": "branch.py", "eloc": 2, "base_eloc": 2, "delta_eloc": 0}]
    assert payload["errors"] == []


def test_staged_addition_deleted_from_worktree_is_a_legal_deletion(git_project: tuple[Path, str]) -> None:
    root, _ = git_project
    path = source(root / "abandoned.py", 3)
    git(root, "add", path.name)
    path.unlink()
    process, payload = report("--base-ref", "HEAD", cwd=root)
    assert process.returncode == 0
    assert payload["status"] == "no_files"
    assert payload["files"] == payload["errors"] == []


def test_base_ref_reports_negative_size_delta_without_assigning_quality(git_project: tuple[Path, str]) -> None:
    root, _ = git_project
    source(root / "branch.py", 1)
    process, payload = report("--base-ref", "HEAD", cwd=root)
    assert process.returncode == 0
    assert payload["files"] == [{"path": "branch.py", "eloc": 1, "base_eloc": 2, "delta_eloc": -1}]
    assert payload["errors"] == []


def test_replacing_a_historical_symlink_counts_only_the_new_regular_source(git_project: tuple[Path, str]) -> None:
    root, _ = git_project
    path = root / "formerly-linked.py"
    try:
        path.symlink_to("branch.py")
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable on this platform")
    git(root, "add", path.name)
    git(root, "commit", "-qm", "fixture historical symlink")
    path.unlink()
    source(path, 6)
    process, payload = report("--base-ref", "HEAD", cwd=root)
    assert process.returncode == 0
    assert payload["files"] == [{"path": path.name, "eloc": 6, "base_eloc": 0, "delta_eloc": 6}]
    assert payload["errors"] == []


def test_unreadable_baseline_text_is_not_treated_as_absent_source(git_project: tuple[Path, str]) -> None:
    root, _ = git_project
    path = root / "branch.py"
    path.write_bytes(b"\xff\n")
    git(root, "add", path.name)
    git(root, "commit", "-qm", "fixture invalid baseline encoding")
    source(path, 2)
    process, payload = report("--base-ref", "HEAD", cwd=root)
    assert process.returncode == 2
    assert payload["status"] == "error" and payload["errors"]
    assert payload["errors"][0]["path"] == path.name
    assert payload["files"] == []


def test_unknown_base_ref_cannot_be_reported_as_an_empty_success(git_project: tuple[Path, str]) -> None:
    root, _ = git_project
    process, payload = report("--base-ref", "missing-reference", cwd=root)
    assert process.returncode == 2
    assert payload["status"] == "error" and payload["errors"]


def test_base_ref_outside_a_git_repository_reports_selection_error(tmp_path: Path) -> None:
    process, payload = report("--base-ref", "HEAD", cwd=tmp_path)
    assert process.returncode == 2
    assert payload["status"] == "error" and payload["errors"]
