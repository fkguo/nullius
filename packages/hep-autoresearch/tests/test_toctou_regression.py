"""TOCTOU regression tests for state-mutating functions (R1/R2/R3 review fixes).

Tests that ``maybe_mark_needs_recovery``, ``check_approval_timeout``, and
``check_approval_budget`` re-read state inside the lock and re-check all
trigger conditions, preventing race conditions where concurrent processes
modify state between the initial check and lock acquisition.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from hep_autoresearch.toolkit.orchestrator_state import (
    check_approval_budget,
    check_approval_timeout,
    default_state,
    ensure_runtime_dirs,
    load_state,
    maybe_mark_needs_recovery,
    save_state,
    state_lock,
)


def _setup_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    ensure_runtime_dirs(repo)
    return repo


def _make_state(repo: Path, **overrides: Any) -> dict[str, Any]:
    st = default_state()
    st["run_id"] = "test-run"
    st["workflow_id"] = "custom"
    st.update(overrides)
    save_state(repo, st)
    return st


# ─── maybe_mark_needs_recovery: TOCTOU regression ───


def test_recovery_skipped_when_checkpoint_refreshed_concurrently(tmp_path: Path) -> None:
    """R2 fix: if checkpoint is refreshed between pre-lock check and lock acquisition,
    the function should NOT mark needs_recovery."""
    repo = _setup_repo(tmp_path)

    stale_ts = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).isoformat()
    fresh_ts = dt.datetime.now(dt.timezone.utc).isoformat()

    # Create state with stale checkpoint (triggers pre-lock check)
    state = _make_state(
        repo,
        run_status="running",
        checkpoints={"last_checkpoint_at": stale_ts, "checkpoint_interval_seconds": 900},
    )

    # Simulate concurrent checkpoint refresh: when load_state is called inside the lock,
    # return a state with a fresh checkpoint.
    original_load_state = load_state

    def _patched_load_state(repo_root: Path) -> dict[str, Any] | None:
        fresh = original_load_state(repo_root)
        if fresh is not None:
            fresh["checkpoints"]["last_checkpoint_at"] = fresh_ts
        return fresh

    with patch(
        "hep_autoresearch.toolkit.orchestrator_state.load_state",
        side_effect=_patched_load_state,
    ):
        result = maybe_mark_needs_recovery(repo, state)

    # Should NOT have marked needs_recovery since fresh checkpoint is within bounds
    assert result is False
    assert state.get("run_status") == "running"


def test_recovery_skipped_when_status_changed_concurrently(tmp_path: Path) -> None:
    """R1 fix: if run_status is changed between pre-lock check and lock acquisition,
    the function should NOT mark needs_recovery."""
    repo = _setup_repo(tmp_path)

    stale_ts = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).isoformat()

    state = _make_state(
        repo,
        run_status="running",
        checkpoints={"last_checkpoint_at": stale_ts, "checkpoint_interval_seconds": 900},
    )

    # Simulate concurrent status change
    original_load_state = load_state

    def _patched_load_state(repo_root: Path) -> dict[str, Any] | None:
        fresh = original_load_state(repo_root)
        if fresh is not None:
            fresh["run_status"] = "paused"  # another process paused it
        return fresh

    with patch(
        "hep_autoresearch.toolkit.orchestrator_state.load_state",
        side_effect=_patched_load_state,
    ):
        result = maybe_mark_needs_recovery(repo, state)

    assert result is False
    assert state.get("run_status") == "paused"


def test_recovery_proceeds_when_conditions_still_hold(tmp_path: Path) -> None:
    """Positive case: when reload confirms conditions still hold, recovery proceeds."""
    repo = _setup_repo(tmp_path)

    stale_ts = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).isoformat()

    state = _make_state(
        repo,
        run_status="running",
        checkpoints={"last_checkpoint_at": stale_ts, "checkpoint_interval_seconds": 900},
    )

    result = maybe_mark_needs_recovery(repo, state)

    assert result is True
    assert state.get("run_status") == "needs_recovery"


# ─── check_approval_timeout: TOCTOU regression ───


def test_timeout_skipped_when_approval_resolved_concurrently(tmp_path: Path) -> None:
    """If pending_approval is resolved between pre-lock check and lock acquisition,
    the function should return None (no action)."""
    repo = _setup_repo(tmp_path)

    past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    state = _make_state(
        repo,
        run_status="awaiting_approval",
        pending_approval={
            "approval_id": "A1-0001",
            "category": "A1",
            "timeout_at": past,
            "on_timeout": "block",
        },
    )

    # Simulate concurrent approval resolution
    original_load_state = load_state

    def _patched_load_state(repo_root: Path) -> dict[str, Any] | None:
        fresh = original_load_state(repo_root)
        if fresh is not None:
            fresh["pending_approval"] = None  # resolved by another process
        return fresh

    with patch(
        "hep_autoresearch.toolkit.orchestrator_state.load_state",
        side_effect=_patched_load_state,
    ):
        result = check_approval_timeout(repo, state)

    assert result is None


# ─── check_approval_budget: TOCTOU regression ───


def test_budget_skipped_when_history_changes_concurrently(tmp_path: Path) -> None:
    """If approval count changes between pre-lock check and lock acquisition,
    the function should re-evaluate and potentially return False."""
    repo = _setup_repo(tmp_path)

    # State with 3 approved (at budget limit of 3)
    state = _make_state(
        repo,
        run_status="running",
        approval_history=[
            {"decision": "approved"},
            {"decision": "approved"},
            {"decision": "approved"},
        ],
    )

    # Simulate concurrent rollback: inside lock, only 2 approved
    original_load_state = load_state

    def _patched_load_state(repo_root: Path) -> dict[str, Any] | None:
        fresh = original_load_state(repo_root)
        if fresh is not None:
            fresh["approval_history"] = [
                {"decision": "approved"},
                {"decision": "approved"},
            ]
        return fresh

    with patch(
        "hep_autoresearch.toolkit.orchestrator_state.load_state",
        side_effect=_patched_load_state,
    ):
        result = check_approval_budget(repo, state, max_approvals=3)

    assert result is False


def test_budget_proceeds_when_still_exhausted(tmp_path: Path) -> None:
    """Positive case: when reload confirms budget is still exhausted, block proceeds."""
    repo = _setup_repo(tmp_path)

    state = _make_state(
        repo,
        run_status="running",
        approval_history=[
            {"decision": "approved"},
            {"decision": "approved"},
            {"decision": "approved"},
        ],
    )

    result = check_approval_budget(repo, state, max_approvals=3)

    assert result is True
    assert state.get("run_status") == "blocked"


# ─── Nested lock regression (Codex full-review fix) ───


def test_maybe_mark_needs_recovery_inside_outer_lock_no_deadlock(tmp_path: Path) -> None:
    """Regression: calling maybe_mark_needs_recovery with _caller_holds_lock=True
    inside an outer state_lock must NOT deadlock (FileLock is non-reentrant)."""
    repo = _setup_repo(tmp_path)

    stale_ts = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).isoformat()
    state = _make_state(
        repo,
        run_status="running",
        checkpoints={"last_checkpoint_at": stale_ts, "checkpoint_interval_seconds": 900},
    )

    with state_lock(repo, timeout_seconds=2.0):
        # This would deadlock without _caller_holds_lock
        result = maybe_mark_needs_recovery(repo, state, _caller_holds_lock=True)

    assert result is True
    assert state.get("run_status") == "needs_recovery"


def test_maybe_mark_needs_recovery_inside_outer_lock_skips_when_not_running(tmp_path: Path) -> None:
    """When called with _caller_holds_lock=True and state is not running, returns False."""
    repo = _setup_repo(tmp_path)

    state = _make_state(repo, run_status="paused")

    with state_lock(repo, timeout_seconds=2.0):
        result = maybe_mark_needs_recovery(repo, state, _caller_holds_lock=True)

    assert result is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
