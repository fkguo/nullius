"""C-01: Approval watchdog — timeout + budget enforcement tests."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from hep_autoresearch.toolkit.orchestrator_state import (
    append_ledger_event,
    check_approval_budget,
    check_approval_timeout,
    ensure_runtime_dirs,
    save_state,
    default_state,
    read_approval_policy,
    APPROVAL_POLICY_FILENAME,
    LEDGER_FILENAME,
    autoresearch_dir,
    ledger_path,
)


def _setup_repo(tmp_path: Path) -> Path:
    """Create minimal .autoresearch structure."""
    repo = tmp_path / "repo"
    repo.mkdir()
    ensure_runtime_dirs(repo)
    return repo


def _make_state(repo: Path, **overrides: Any) -> dict[str, Any]:
    st = default_state()
    st["run_id"] = "test-run"
    st["workflow_id"] = "W_test"
    st["run_status"] = "awaiting_approval"
    st.update(overrides)
    save_state(repo, st)
    return st


def _read_ledger(repo: Path) -> list[dict[str, Any]]:
    lp = ledger_path(repo)
    if not lp.exists():
        return []
    lines = lp.read_text(encoding="utf-8").strip().splitlines()
    return [json.loads(line) for line in lines]


# ─── check_approval_timeout ───


def test_timeout_no_pending(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    st = _make_state(repo, pending_approval=None)
    assert check_approval_timeout(repo, st) is None


def test_timeout_no_timeout_at(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    st = _make_state(repo, pending_approval={"approval_id": "A1-0001", "timeout_at": None})
    assert check_approval_timeout(repo, st) is None


def test_timeout_not_yet_expired(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat(timespec="seconds").replace("+00:00", "Z")
    st = _make_state(repo, pending_approval={"approval_id": "A1-0001", "timeout_at": future, "on_timeout": "block"})
    assert check_approval_timeout(repo, st) is None


def test_timeout_expired_block(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat(timespec="seconds").replace("+00:00", "Z")
    st = _make_state(
        repo,
        pending_approval={
            "approval_id": "A1-0001",
            "category": "A1",
            "timeout_at": past,
            "on_timeout": "block",
        },
    )
    result = check_approval_timeout(repo, st)
    assert result == "block"
    assert st["run_status"] == "blocked"
    events = _read_ledger(repo)
    timeout_events = [e for e in events if e["event_type"] == "approval_timeout"]
    assert len(timeout_events) == 1
    assert timeout_events[0]["details"]["approval_id"] == "A1-0001"
    assert timeout_events[0]["details"]["policy_action"] == "block"


def test_timeout_expired_reject(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat(timespec="seconds").replace("+00:00", "Z")
    st = _make_state(
        repo,
        pending_approval={
            "approval_id": "A1-0001",
            "category": "A1",
            "timeout_at": past,
            "on_timeout": "reject",
        },
    )
    result = check_approval_timeout(repo, st)
    assert result == "reject"
    assert st["run_status"] == "rejected"
    assert st["pending_approval"] is None
    # Should have approval_history entry
    history = st.get("approval_history", [])
    assert any(h.get("decision") == "timeout_rejected" for h in history)


def test_timeout_expired_escalate(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat(timespec="seconds").replace("+00:00", "Z")
    st = _make_state(
        repo,
        pending_approval={
            "approval_id": "A1-0001",
            "category": "A1",
            "timeout_at": past,
            "on_timeout": "escalate",
        },
    )
    result = check_approval_timeout(repo, st)
    assert result == "escalate"
    assert st["run_status"] == "needs_recovery"


# ─── check_approval_budget ───


def test_budget_no_limit(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    st = _make_state(repo)
    assert check_approval_budget(repo, st) is False


def test_budget_not_exhausted(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    st = _make_state(
        repo,
        approval_history=[
            {"decision": "approved", "approval_id": "A1-0001", "ts": "2026-01-01T00:00:00Z"},
        ],
    )
    assert check_approval_budget(repo, st, max_approvals=5) is False


def test_budget_exhausted(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    history = [
        {"decision": "approved", "approval_id": f"A1-{i:04d}", "ts": "2026-01-01T00:00:00Z"}
        for i in range(3)
    ]
    st = _make_state(repo, approval_history=history)
    result = check_approval_budget(repo, st, max_approvals=3)
    assert result is True
    assert st["run_status"] == "blocked"
    events = _read_ledger(repo)
    budget_events = [e for e in events if e["event_type"] == "approval_budget_exhausted"]
    assert len(budget_events) == 1
    assert budget_events[0]["details"]["granted"] == 3
    assert budget_events[0]["details"]["max_approvals"] == 3


def test_budget_from_policy(tmp_path: Path) -> None:
    repo = _setup_repo(tmp_path)
    # Write policy with max_approvals
    policy = read_approval_policy(repo)
    policy.setdefault("budgets", {})["max_approvals"] = 2
    policy_path = autoresearch_dir(repo) / APPROVAL_POLICY_FILENAME
    policy_path.write_text(json.dumps(policy, indent=2), encoding="utf-8")

    history = [
        {"decision": "approved", "approval_id": f"A1-{i:04d}", "ts": "2026-01-01T00:00:00Z"}
        for i in range(2)
    ]
    st = _make_state(repo, approval_history=history)
    result = check_approval_budget(repo, st)
    assert result is True


def test_budget_rejected_not_counted(tmp_path: Path) -> None:
    """Only 'approved' decisions count toward the budget."""
    repo = _setup_repo(tmp_path)
    history = [
        {"decision": "approved", "approval_id": "A1-0001", "ts": "2026-01-01T00:00:00Z"},
        {"decision": "timeout_rejected", "approval_id": "A1-0002", "ts": "2026-01-01T00:00:00Z"},
    ]
    st = _make_state(repo, approval_history=history)
    result = check_approval_budget(repo, st, max_approvals=2)
    assert result is False
