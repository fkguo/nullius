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


def _resolve(project: Path, skills: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", f'PROJECT_ROOT="{project}"; SKILLS_DIR="{skills}"; source "{RESOLVER}"; '
                       'printf "%s" "$LOCAL_CLAUDE_RUNNER"'],
        capture_output=True, text=True, timeout=30,
    )


def test_current_project_copy_is_kept_and_stale_copy_is_replaced(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    (project / "scripts").mkdir(parents=True)
    local = project / "scripts" / "run_claude.sh"

    shutil.copy(ASSET, local)
    kept = _resolve(project, SKILLS_ROOT)
    assert kept.stdout == str(local) and "[warn]" not in kept.stderr

    local.write_text("#!/usr/bin/env bash\nclaude --print \"$@\"\n", encoding="utf-8")
    replaced = _resolve(project, SKILLS_ROOT)
    shared = SKILLS_ROOT / "claude-cli-runner" / "scripts" / "run_claude.sh"
    assert replaced.stdout == str(shared)
    assert "predates the operator-context exclusion" in replaced.stderr
    assert local.read_text(encoding="utf-8").startswith("#!/usr/bin/env bash\nclaude --print")  # untouched

    no_shared = tmp_path / "empty_skills"
    no_shared.mkdir()
    refused = _resolve(project, no_shared)
    assert refused.returncode == 2

    local.unlink()
    absent = _resolve(project, SKILLS_ROOT)
    assert absent.stdout == str(local)  # no project copy: callers fall through to the shared runner


def test_cycle_scripts_use_the_resolver() -> None:
    cycle = (SKILL_DIR / "scripts" / "bin" / "run_team_cycle.sh").read_text(encoding="utf-8")
    assert "lib/resolve_local_claude_runner.sh" in cycle
    assert 'LOCAL_CLAUDE_RUNNER="${PROJECT_ROOT}/scripts/run_claude.sh"' not in cycle
