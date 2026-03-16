from __future__ import annotations

import pytest

from idea_core.hepar.retry_ops import RetryPolicy, call_with_retry


def test_call_with_retry_retries_timeout_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}
    monkeypatch.setattr("idea_core.hepar.retry_ops.time.sleep", lambda _seconds: None)

    def flaky() -> str:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise TimeoutError("slow")
        return "ok"

    policy = RetryPolicy(timeout_s=0.0, max_attempts=3, backoff_initial_s=0.0, backoff_max_s=0.0)
    assert call_with_retry(flaky, op_name="retry.test", policy=policy) == "ok"
    assert attempts["count"] == 3


def test_call_with_retry_does_not_retry_non_retryable_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}
    monkeypatch.setattr("idea_core.hepar.retry_ops.time.sleep", lambda _seconds: None)

    def buggy() -> None:
        attempts["count"] += 1
        raise ValueError("bug")

    policy = RetryPolicy(timeout_s=0.0, max_attempts=3, backoff_initial_s=0.0, backoff_max_s=0.0)
    with pytest.raises(ValueError, match="bug"):
        call_with_retry(buggy, op_name="retry.test", policy=policy)

    assert attempts["count"] == 1
