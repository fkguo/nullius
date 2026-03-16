from __future__ import annotations

import sys
from pathlib import Path

import pytest


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))
for name in [key for key in sys.modules if key == "hep_autoresearch" or key.startswith("hep_autoresearch.")]:
    sys.modules.pop(name)

import hep_autoresearch.toolkit.retry as retry_mod
from hep_autoresearch.toolkit.mcp_stdio_client import McpTransportError
from hep_autoresearch.toolkit.retry import RetryExhaustedError, retry_with_backoff


def test_retry_with_backoff_retries_transport_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}
    monkeypatch.setattr(retry_mod.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(retry_mod.random, "random", lambda: 0.0)

    def flaky() -> str:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise McpTransportError("upstream")
        return "ok"

    assert retry_with_backoff(flaky, max_retries=3, base_delay=0.0, max_delay=0.0) == "ok"
    assert attempts["count"] == 3


def test_retry_with_backoff_wraps_retryable_exhaustion(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(retry_mod.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(retry_mod.random, "random", lambda: 0.0)

    with pytest.raises(RetryExhaustedError) as excinfo:
        retry_with_backoff(
            lambda: (_ for _ in ()).throw(McpTransportError("always down")),
            max_retries=1,
            base_delay=0.0,
            max_delay=0.0,
        )

    assert isinstance(excinfo.value.last_error, McpTransportError)
    assert len(excinfo.value.attempts) == 1


def test_retry_with_backoff_does_not_retry_programmer_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}
    monkeypatch.setattr(retry_mod.time, "sleep", lambda _seconds: None)

    def buggy() -> None:
        attempts["count"] += 1
        raise ValueError("bug")

    with pytest.raises(ValueError, match="bug"):
        retry_with_backoff(buggy, max_retries=3, base_delay=0.0, max_delay=0.0)

    assert attempts["count"] == 1
