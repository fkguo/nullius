"""H-19: Simple retry decorator — Python temporary stopgap.

WARNING: This module is a temporary stopgap for Pipeline A (Python orchestrator).
Once the TS orchestrator retry (packages/orchestrator/src/retry.ts) is validated,
this file MUST be deleted immediately (no buffer period).
"""

from __future__ import annotations

import logging
import random
import time
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


def retry_with_backoff(
    fn: Callable[..., T],
    *,
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    jitter: float = 0.25,
    is_retryable: Callable[[Exception], bool] | None = None,
) -> T:
    """Call `fn()` with exponential backoff on retryable failures.

    Args:
        fn: Zero-arg callable to retry.
        max_retries: Max retry count (0 = no retries).
        base_delay: Base delay in seconds.
        max_delay: Delay cap in seconds.
        jitter: Jitter factor 0–1 (1 = full jitter).
        is_retryable: Predicate; defaults to checking MCP RATE_LIMIT/UPSTREAM_ERROR.
    """
    if is_retryable is None:
        is_retryable = _default_is_retryable

    attempts: list[dict[str, Any]] = []
    last_exc: Exception | None = None

    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if not is_retryable(exc) or attempt >= max_retries:
                raise RetryExhaustedError(
                    f"Retry exhausted after {attempt + 1} attempt(s): {exc}",
                    last_error=exc,
                    attempts=attempts,
                ) from exc

            exp_delay = min(base_delay * (2 ** attempt), max_delay)
            jitter_range = exp_delay * jitter
            delay = exp_delay - jitter_range + random.random() * jitter_range
            attempts.append({"attempt": attempt, "error": str(exc), "delay": delay})
            logger.warning("Retry %d/%d after %.1fs: %s", attempt + 1, max_retries, delay, exc)
            time.sleep(max(0.0, delay))

    # Unreachable — last_exc is always set when loop exhausts
    assert last_exc is not None
    raise last_exc


def _default_is_retryable(exc: Exception) -> bool:
    """Check if an MCP error response is retryable by inspecting error_code."""
    msg = str(exc).upper()
    return "RATE_LIMIT" in msg or "UPSTREAM_ERROR" in msg


class RetryExhaustedError(Exception):
    """Raised when all retries are exhausted."""

    def __init__(self, message: str, *, last_error: Exception, attempts: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.last_error = last_error
        self.attempts = attempts
