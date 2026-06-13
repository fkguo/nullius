from __future__ import annotations

from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
RUN_TEAM_CYCLE = SKILL_ROOT / "scripts" / "bin" / "run_team_cycle.sh"


def _shell_function_body(script: str, name: str) -> str:
    marker = f"{name}() {{"
    start = script.find(marker)
    assert start != -1, f"missing shell function {name}"
    i = start + len(marker)
    depth = 1
    while i < len(script):
        ch = script[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return script[start:i]
        i += 1
    raise AssertionError(f"unterminated shell function {name}")


def test_on_exit_restores_clean_room_permissions_before_workspace_cleanup() -> None:
    script = RUN_TEAM_CYCLE.read_text(encoding="utf-8")
    body = _shell_function_body(script, "on_exit")

    restore_idx = body.find("restore_isolated_output_permissions")
    cleanup_idx = body.find("cleanup_workspaces_post_run")

    assert restore_idx != -1
    assert cleanup_idx != -1
    assert restore_idx < cleanup_idx


def test_restore_helper_covers_all_chmod_locked_clean_room_outputs() -> None:
    script = RUN_TEAM_CYCLE.read_text(encoding="utf-8")
    body = _shell_function_body(script, "restore_isolated_output_permissions")

    for token in (
        '"${run_dir}/member_a"',
        '"${run_dir}/member_b"',
        '"${attempt_logs_dir}/member_a"',
        '"${attempt_logs_dir}/member_b"',
        '"${member_artifacts_root}/member_a"',
        '"${member_artifacts_root}/member_b"',
        '"${run_dir}/workspaces/member_a_"*',
        '"${run_dir}/workspaces/member_b_"*',
    ):
        assert token in body
