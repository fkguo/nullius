#!/usr/bin/env python3
"""Unit tests for prune_team_workspaces.py.

Builds synthetic team/runs/<tag>/ fixtures, exercises find_plans() under each
combination of status / keep_last / keep_failed / min_age_hours, and verifies
both the deletion plan and the actual --apply behavior, including the case
where a workspace has been chmod'd a-rwx by run_team_cycle.sh isolation logic.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))

from prune_team_workspaces import (  # noqa: E402  (path setup must precede import)
    _dir_size,
    _rmtree_force,
    find_plans,
)


def _make_run(
    project_root: Path,
    tag: str,
    *,
    status: str | None,
    updated_at: str | None,
    workspace_kb: int = 1,
    chmod_locked: bool = False,
) -> Path:
    run_dir = project_root / "team" / "runs" / tag
    ws_dir = run_dir / "workspaces" / "member_a_aaa"
    ws_dir.mkdir(parents=True)
    payload = bytes(workspace_kb * 1024)
    (ws_dir / "big.csv").write_bytes(payload)
    (run_dir / "member_a_evidence.json").write_text("evidence-placeholder")
    if status is not None or updated_at is not None:
        state: dict[str, str] = {}
        if status is not None:
            state["status"] = status
        if updated_at is not None:
            state["updated_at"] = updated_at
        (run_dir / "cycle_state.json").write_text(json.dumps(state))
    if chmod_locked:
        os.chmod(ws_dir, 0)
        os.chmod(ws_dir.parent, 0)
    return ws_dir


def _restore_perms(path: Path) -> None:
    # Test cleanup helper: pytest's tmp_path cleanup chokes on chmod 0 dirs.
    if path.exists():
        try:
            os.chmod(path, stat.S_IRWXU)
        except OSError:
            pass
        for root, dirs, _files in os.walk(path, followlinks=False):
            for d in dirs:
                try:
                    os.chmod(Path(root) / d, stat.S_IRWXU)
                except OSError:
                    pass


@pytest.fixture
def project_root(tmp_path: Path):
    yield tmp_path
    _restore_perms(tmp_path)


def test_no_team_runs_returns_empty(project_root: Path) -> None:
    assert find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0) == []


def test_completed_run_marked_for_deletion(project_root: Path) -> None:
    _make_run(project_root, "tagA", status="completed", updated_at="2026-05-01T00:00:00Z")
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    assert len(plans) == 1
    assert plans[0].action == "delete"
    assert plans[0].status == "completed"
    assert plans[0].size_bytes >= 1024


def test_running_with_fresh_mtime_is_skipped(project_root: Path) -> None:
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    _make_run(project_root, "tagB", status="running", updated_at=now_iso)
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    assert len(plans) == 1
    assert plans[0].action == "skip"
    assert "running" in plans[0].skip_reason


def test_running_with_stale_mtime_is_deleted(project_root: Path, tmp_path: Path) -> None:
    ws = _make_run(project_root, "tagB-stale", status="running", updated_at="2026-01-01T00:00:00Z")
    # Force the workspaces dir mtime to be old.
    old = (datetime.now(timezone.utc) - timedelta(hours=24)).timestamp()
    os.utime(ws.parent, (old, old))
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    assert plans[0].action == "delete"


def test_failed_run_kept_when_keep_failed_set(project_root: Path) -> None:
    _make_run(project_root, "tagC", status="error", updated_at="2026-01-01T00:00:00Z")
    plans = find_plans(project_root, keep_last=0, keep_failed=True, min_age_hours=1.0)
    assert plans[0].action == "skip"
    assert "keep-failed" in plans[0].skip_reason


def test_failed_run_deleted_when_keep_failed_unset(project_root: Path) -> None:
    _make_run(project_root, "tagC", status="error", updated_at="2026-01-01T00:00:00Z")
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    assert plans[0].action == "delete"


def test_keep_last_preserves_most_recent(project_root: Path) -> None:
    _make_run(project_root, "tag-old", status="completed", updated_at="2026-01-01T00:00:00Z")
    _make_run(project_root, "tag-mid", status="completed", updated_at="2026-03-01T00:00:00Z")
    _make_run(project_root, "tag-new", status="completed", updated_at="2026-05-01T00:00:00Z")
    plans = find_plans(project_root, keep_last=2, keep_failed=False, min_age_hours=1.0)
    plans_by_tag = {p.tag: p for p in plans}
    assert plans_by_tag["tag-new"].action == "skip"
    assert plans_by_tag["tag-mid"].action == "skip"
    assert plans_by_tag["tag-old"].action == "delete"


def test_apply_actually_deletes_workspace(project_root: Path) -> None:
    _make_run(project_root, "tagX", status="completed", updated_at="2026-01-01T00:00:00Z")
    ws_root = project_root / "team" / "runs" / "tagX" / "workspaces"
    assert ws_root.is_dir()
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    assert plans[0].action == "delete"
    _rmtree_force(Path(plans[0].workspaces_dir))
    assert not ws_root.exists()
    # Forensic data is untouched.
    assert (project_root / "team" / "runs" / "tagX" / "cycle_state.json").is_file()
    assert (project_root / "team" / "runs" / "tagX" / "member_a_evidence.json").is_file()


def test_apply_handles_chmod_locked_workspace(project_root: Path) -> None:
    _make_run(
        project_root,
        "tag-locked",
        status="completed",
        updated_at="2026-01-01T00:00:00Z",
        chmod_locked=True,
    )
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    target = Path(plans[0].workspaces_dir)
    assert target.exists()
    _rmtree_force(target)
    assert not target.exists()


def test_dir_size_counts_only_workspace_contents(project_root: Path) -> None:
    ws = _make_run(project_root, "tagS", status="completed", updated_at="2026-01-01T00:00:00Z", workspace_kb=64)
    assert _dir_size(ws.parent) >= 64 * 1024


def test_missing_cycle_state_with_stale_mtime_is_deleted(project_root: Path) -> None:
    ws = _make_run(project_root, "tag-no-state", status=None, updated_at=None)
    # Push mtime back so the "unknown == possibly mid-crash" guard does not fire.
    old = (datetime.now(timezone.utc) - timedelta(hours=24)).timestamp()
    os.utime(ws.parent, (old, old))
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    assert plans[0].status == "unknown"
    assert plans[0].action == "delete"


def test_missing_cycle_state_with_fresh_mtime_is_skipped(project_root: Path) -> None:
    # Crash window: workspaces/ exists, cycle_state.json was never written, and
    # the workspace was touched recently. Treat as in-progress to avoid racing
    # a still-running cycle that hasn't yet emitted state.
    _make_run(project_root, "tag-fresh-unknown", status=None, updated_at=None)
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    assert plans[0].status == "unknown"
    assert plans[0].action == "skip"


def test_symlinked_workspaces_is_excluded(project_root: Path, tmp_path_factory) -> None:
    # An attacker (or a broken project) could symlink team/runs/<tag>/workspaces
    # to a directory outside team/runs/. The prune tool must refuse to plan a
    # deletion for such targets — never escape the runs root via realpath.
    external = tmp_path_factory.mktemp("outside-runs")
    (external / "decoy.txt").write_text("must not be deleted")
    tag_dir = project_root / "team" / "runs" / "tag-symlink"
    tag_dir.mkdir(parents=True)
    os.symlink(external, tag_dir / "workspaces", target_is_directory=True)
    plans = find_plans(project_root, keep_last=0, keep_failed=False, min_age_hours=1.0)
    # The symlinked workspaces is skipped entirely (does not appear in plans).
    assert all(p.tag != "tag-symlink" for p in plans)
    # And the external decoy is intact.
    assert (external / "decoy.txt").read_text() == "must not be deleted"
