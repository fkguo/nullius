"""Exercise the actual diff gate against repository state and failed inputs."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/check_as_any.sh"
GIT = shutil.which("git")
AS_ANY = "const value = input as any;\n"
CATCH = "Promise.resolve().catch(() => {});\n"


def git(root, *args):
    return subprocess.run([GIT, "-C", str(root), "-c", "commit.gpgsign=false",
                           "-c", "core.hooksPath=/dev/null", *args],
                          text=True, capture_output=True, check=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    root = tmp_path / "research repo"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.name", "Protocol fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    (root / "tracked.ts").write_text("const initial = 1;\n")
    (root / "historical.ts").write_text(AS_ANY)
    (root / ".gitignore").write_text("ignored/\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "baseline")
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    return root


def check(root, *flags, env=None):
    return subprocess.run(["bash", str(SCRIPT), *flags], cwd=root, env=env,
                          text=True, capture_output=True, timeout=10)


@pytest.mark.parametrize("surface", ["committed", "staged", "unstaged", "untracked"])
@pytest.mark.parametrize("content", [AS_ANY, CATCH])
def test_current_tree_selection_blocks_each_new_code_surface(repo, surface, content):
    name = "new.ts" if surface == "untracked" else "tracked.ts"
    (repo / name).write_text(content)
    if surface in ("committed", "staged"):
        git(repo, "add", name)
    if surface == "committed":
        git(repo, "commit", "-qm", "candidate")
    result = check(repo, "--vs-main")
    assert result.returncode == 1, result.stderr
    assert "NEW-R02 FAIL" in result.stderr
    assert "PASS" not in result.stdout


@pytest.mark.parametrize("flags", [(), ("--staged",)])
def test_default_staged_scope_does_not_silently_expand_to_other_work(repo, flags):
    (repo / "tracked.ts").write_text(AS_ANY)
    (repo / "untracked.ts").write_text(CATCH)
    assert check(repo, *flags).returncode == 0
    git(repo, "add", "tracked.ts")
    assert check(repo, *flags).returncode == 1


@pytest.mark.parametrize("committed", [False, True])
def test_unstaged_repair_cannot_mask_violations_that_would_be_committed(repo, committed):
    (repo / "tracked.ts").write_text(AS_ANY)
    git(repo, "add", "tracked.ts")
    if committed:
        git(repo, "commit", "-qm", "unrepaired branch result")
    (repo / "tracked.ts").write_text("const repaired = 2;\n")
    result = check(repo, "--vs-main")
    assert result.returncode == 1, result.stderr
    assert "FAIL [index]" in result.stderr and "FAIL [worktree]" not in result.stderr
    # Staging the actual repair makes both current snapshots safe.
    git(repo, "add", "tracked.ts")
    assert check(repo, "--vs-main").returncode == 0


@pytest.mark.parametrize("name", ["space name.ts", "nested path/非ASCII.tsx", "line\nbreak.ts", "-option.ts", "back\\slash.ts"])
def test_untracked_file_names_are_nul_delimited_and_read_as_literal_arguments(repo, name):
    source = repo / name
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(AS_ANY)
    result = check(repo, "--vs-main")
    assert result.returncode == 1, result.stderr


@pytest.mark.parametrize("name", ["sample.test.ts", "nested/sample.test.tsx", "sample.js", "ignored/sample.ts"])
def test_existing_suffix_test_and_gitignore_exclusions_are_preserved(repo, name):
    source = repo / name
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(AS_ANY + CATCH)
    assert check(repo, "--vs-main").returncode == 0
    if not name.startswith("ignored/"):
        git(repo, "add", name)
        assert check(repo, "--staged").returncode == 0
        assert check(repo, "--vs-main").returncode == 0


def test_deletions_and_unchanged_historical_risks_are_not_new_violations(repo):
    assert check(repo, "--vs-main").returncode == 0
    (repo / "historical.ts").unlink()
    assert check(repo, "--vs-main").returncode == 0
    git(repo, "add", "-u")
    assert check(repo, "--staged").returncode == 0


def test_subdirectory_invocation_checks_the_same_project(repo):
    nested = repo / "subdir"
    nested.mkdir()
    (repo / "new.ts").write_text(AS_ANY)
    assert check(nested, "--vs-main").returncode == 1


def test_repository_path_with_trailing_newline_is_not_redirected(repo):
    renamed = repo.with_name("repository\n")
    repo.rename(renamed)
    (renamed / "new.ts").write_text(AS_ANY)
    assert check(renamed, "--vs-main").returncode == 1


def test_large_violation_report_still_exits_one_instead_of_sigpipe(repo):
    (repo / "new.ts").write_text(AS_ANY * 5000)
    result = check(repo, "--vs-main")
    assert result.returncode == 1, result.stderr
    assert "5000 violation(s)" in result.stderr
    assert result.stderr.count("+const value") == 20


def test_missing_base_is_unavailable_not_an_empty_success(repo):
    git(repo, "update-ref", "-d", "refs/remotes/origin/main")
    result = check(repo, "--vs-main")
    assert result.returncode == 2
    assert "merge-base" in result.stderr and "PASS" not in result.stdout


@pytest.mark.parametrize("flags", [(), ("--vs-main",), ("--unknown",), ("--staged", "extra")])
def test_missing_repository_or_invalid_arguments_never_pass(tmp_path, flags):
    result = check(tmp_path, *flags)
    assert result.returncode == 2
    assert "NEW-R02 ERROR" in result.stderr and "PASS" not in result.stdout


def with_failing_tool(tmp_path, name, source):
    tools = tmp_path / "test tools"
    tools.mkdir()
    command = tools / name
    command.write_text("#!" + sys.executable + "\n" + source)
    command.chmod(0o755)
    return {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]}


@pytest.mark.parametrize("operation", ["diff", "index", "ls-files"])
def test_git_failure_is_not_swallowed_as_no_added_lines(repo, tmp_path, operation):
    condition = ("sys.argv[1] == 'diff' and '--cached' in sys.argv"
                 if operation == "index" else f"sys.argv[1] == {operation!r}")
    source = ("import os,sys\n"
              f"if {condition}:\n sys.stderr.write('injected Git read failure\\n'); sys.exit(73)\n"
              f"os.execv({GIT!r}, [{GIT!r}, *sys.argv[1:]])\n")
    result = check(repo, "--vs-main", env=with_failing_tool(tmp_path, "git", source))
    assert result.returncode == 2
    assert "injected Git read failure" in result.stderr and "PASS" not in result.stdout


def test_untracked_read_failure_remains_unavailable(repo, tmp_path):
    (repo / "new.ts").write_text(AS_ANY)
    env = with_failing_tool(tmp_path, "sed", "import sys\nsys.stderr.write('read denied\\n');sys.exit(77)\n")
    result = check(repo, "--vs-main", env=env)
    assert result.returncode == 2
    assert "cannot read untracked source" in result.stderr and "PASS" not in result.stdout


def test_exit_zero_enumeration_warning_does_not_hide_unread_sources(repo, tmp_path):
    (repo / "new.ts").write_text(AS_ANY)
    source = ("import os,sys\nif sys.argv[1] == 'ls-files':\n"
              " sys.stderr.write('warning: could not open directory: Permission denied\\n'); sys.exit(0)\n"
              f"os.execv({GIT!r}, [{GIT!r}, *sys.argv[1:]])\n")
    result = check(repo, "--vs-main", env=with_failing_tool(tmp_path, "git", source))
    assert result.returncode == 2
    assert "cannot completely enumerate" in result.stderr and "PASS" not in result.stdout


def test_untracked_symlink_is_not_followed_or_reported_as_checked(repo, tmp_path):
    outside = tmp_path / "outside.ts"
    outside.write_text(AS_ANY)
    (repo / "linked.ts").symlink_to(outside)
    result = check(repo, "--vs-main")
    assert result.returncode == 2
    assert "not a regular file" in result.stderr and "PASS" not in result.stdout
