"""The project-local Claude runner must keep the operator's own context out of reviewer lanes.

`assets/run_claude.sh` is copied into each project as `scripts/run_claude.sh` and preferred by
`run_team_cycle.sh`. Without `--safe-mode` the lane loads the operator's CLAUDE.md, AGENTS.md and
auto memory. These tests drive the asset against a fake `claude` CLI that logs its argv and the
relevant environment, pin the selection rule for copies made before the exclusion existed, and run
a negative control on a scratch copy with the flag removed.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
SKILLS_ROOT = SKILL_DIR.parent
ASSET = SKILL_DIR / "assets" / "run_claude.sh"
RESOLVER = SKILL_DIR / "scripts" / "lib" / "resolve_local_claude_runner.sh"

FAKE_CLAUDE = """#!/usr/bin/env bash
{
  printf 'args='; printf '%q ' "$@"; printf '\\n'
  printf 'git_instructions_off=%s\\n' "${CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS:-unset}"
} >>"${FAKE_LOG}"
cat >/dev/null || true
echo OK
"""


def _invoke(runner: Path, tmp: Path, extra: list[str] | None = None) -> str:
    bin_dir = tmp / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "claude"
    fake.write_text(FAKE_CLAUDE, encoding="utf-8")
    fake.chmod(0o755)
    (tmp / "sys.txt").write_text("system\n", encoding="utf-8")
    (tmp / "prompt.txt").write_text("hello\n", encoding="utf-8")
    log = tmp / "log.txt"
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", FAKE_LOG=str(log))
    env.pop("CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS", None)
    done = subprocess.run(
        ["bash", str(runner), *(extra or []), "--system-prompt-file", str(tmp / "sys.txt"),
         "--prompt-file", str(tmp / "prompt.txt"), "--out", str(tmp / "out.txt"),
         "--max-retries", "1"],
        env=env, capture_output=True, text=True, timeout=60,
    )
    assert done.returncode == 0, done.stderr
    return log.read_text(encoding="utf-8")


def _lane_is_context_excluded(log: str) -> bool:
    return "--safe-mode" in log.split("args=", 1)[1].split("\n", 1)[0].split() \
        and "git_instructions_off=1" in log


def test_asset_passes_safe_mode_and_disables_git_snapshot(tmp_path: Path) -> None:
    assert _lane_is_context_excluded(_invoke(ASSET, tmp_path))


def test_asset_passes_safe_mode_with_explicit_model(tmp_path: Path) -> None:
    log = _invoke(ASSET, tmp_path, ["--model", "some-model"])
    assert _lane_is_context_excluded(log)
    assert "--model some-model" in log


def test_negative_control_copy_without_flag_is_detected(tmp_path: Path) -> None:
    scratch = tmp_path / "scratch_run_claude.sh"
    text = ASSET.read_text(encoding="utf-8")
    assert "--safe-mode" in text
    scratch.write_text(text.replace(" --safe-mode", ""), encoding="utf-8")
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    log = _invoke(scratch, run_dir)
    assert "--safe-mode" not in log
    assert not _lane_is_context_excluded(log)


def _resolve(project: Path, skills: Path, call: str = "") -> subprocess.CompletedProcess[str]:
    """Source the resolver; optionally call the post-resolution check with `call` as its arguments."""
    check = f"research_team_check_local_claude_runner {call} || exit $?; " if call else ""
    return subprocess.run(
        ["bash", "-c", f'PROJECT_ROOT="{project}"; SKILLS_DIR="{skills}"; source "{RESOLVER}"; '
                       f'{check}printf "%s" "$LOCAL_CLAUDE_RUNNER"'],
        capture_output=True, text=True, timeout=30,
    )


def _project_with(tmp_path: Path, text: str | None) -> tuple[Path, Path]:
    project = tmp_path / "proj"
    (project / "scripts").mkdir(parents=True)
    local = project / "scripts" / "run_claude.sh"
    if text is None:
        shutil.copy(ASSET, local)
    else:
        local.write_text(text, encoding="utf-8")
    return project, local


SHARED = SKILLS_ROOT / "claude-cli-runner" / "scripts" / "run_claude.sh"


def test_current_copy_is_kept_without_warning(tmp_path: Path) -> None:
    project, local = _project_with(tmp_path, None)
    kept = _resolve(project, SKILLS_ROOT, "1 1 1")
    assert kept.stdout == str(local) and kept.returncode == 0 and kept.stderr == ""


def test_stale_copy_is_replaced_and_left_untouched(tmp_path: Path) -> None:
    old = "#!/usr/bin/env bash\nclaude --print \"$@\"\n"
    project, local = _project_with(tmp_path, old)
    replaced = _resolve(project, SKILLS_ROOT, "1 0 0")
    assert replaced.stdout == str(SHARED)
    assert "predates the operator-context exclusion" in replaced.stderr
    assert local.read_text(encoding="utf-8") == old
    # No member uses the Claude runner: substitution stays silent.
    quiet = _resolve(project, SKILLS_ROOT, "0 0 1")
    assert quiet.returncode == 0 and quiet.stderr == ""


def test_marker_without_flag_is_stale(tmp_path: Path) -> None:
    text = ASSET.read_text(encoding="utf-8").replace(" --safe-mode", "")
    assert "research-team-claude-runner: context-excluded" in text
    project, _ = _project_with(tmp_path, text)
    assert _resolve(project, SKILLS_ROOT).stdout == str(SHARED)


def test_stale_copy_with_api_option_on_a_claude_member_is_refused(tmp_path: Path) -> None:
    project, _ = _project_with(tmp_path, "#!/usr/bin/env bash\nclaude --print \"$@\"\n")
    refused = _resolve(project, SKILLS_ROOT, "0 1 1")
    assert refused.returncode == 2 and "refresh the copy first" in refused.stderr


def test_stale_copy_without_shared_runner_is_refused(tmp_path: Path) -> None:
    project, _ = _project_with(tmp_path, "#!/usr/bin/env bash\nclaude --print \"$@\"\n")
    empty = tmp_path / "empty_skills"
    empty.mkdir()
    assert _resolve(project, empty, "1 0 0").returncode == 2


def test_no_project_copy_leaves_path_for_shared_fallthrough(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    project.mkdir()
    absent = _resolve(project, SKILLS_ROOT, "1 1 1")
    assert absent.returncode == 0 and absent.stdout == str(project / "scripts" / "run_claude.sh")


def test_cycle_script_passes_api_options_only_for_claude_members() -> None:
    cycle = (SKILL_DIR / "scripts" / "bin" / "run_team_cycle.sh").read_text(encoding="utf-8")
    call = cycle.index("research_team_check_local_claude_runner ")
    window = cycle[call - 900:call]
    assert 'MEMBER_A_RUNNER_KIND_RESOLVED}" == "claude"' in window
    assert 'MEMBER_B_RUNNER_KIND_RESOLVED}" == "claude"' in window


def test_deterministic_failure_is_not_retried(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "claude"
    fake.write_text(
        '#!/usr/bin/env bash\necho x >>"${FAKE_LOG}"\ncat >/dev/null || true\n'
        "echo \"error: unknown option '--safe-mode'\" >&2\nexit 1\n", encoding="utf-8")
    fake.chmod(0o755)
    (tmp_path / "sys.txt").write_text("s\n", encoding="utf-8")
    (tmp_path / "prompt.txt").write_text("p\n", encoding="utf-8")
    log = tmp_path / "log.txt"
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", FAKE_LOG=str(log))
    done = subprocess.run(
        ["bash", str(ASSET), "--system-prompt-file", str(tmp_path / "sys.txt"),
         "--prompt-file", str(tmp_path / "prompt.txt"), "--out", str(tmp_path / "out.txt"),
         "--sleep-secs", "0"],
        env=env, capture_output=True, text=True, timeout=60,
    )
    assert done.returncode == 1 and "deterministic error" in done.stderr
    assert log.read_text(encoding="utf-8").count("x") == 1


def test_cycle_scripts_use_the_resolver() -> None:
    cycle = (SKILL_DIR / "scripts" / "bin" / "run_team_cycle.sh").read_text(encoding="utf-8")
    assert "lib/resolve_local_claude_runner.sh" in cycle
    assert 'LOCAL_CLAUDE_RUNNER="${PROJECT_ROOT}/scripts/run_claude.sh"' not in cycle
