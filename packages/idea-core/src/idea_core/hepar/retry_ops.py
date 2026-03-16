from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
import time
from typing import Callable, TypeVar


T = TypeVar("T")


@dataclass(frozen=True)
class RetryPolicy:
    timeout_s: float = 15.0
    max_attempts: int = 3
    backoff_initial_s: float = 0.05
    backoff_max_s: float = 0.5

    def normalized(self) -> "RetryPolicy":
        attempts = max(1, int(self.max_attempts))
        timeout_s = max(float(self.timeout_s), 0.0)
        backoff_initial_s = max(float(self.backoff_initial_s), 0.0)
        backoff_max_s = max(float(self.backoff_max_s), backoff_initial_s)
        return RetryPolicy(
            timeout_s=timeout_s,
            max_attempts=attempts,
            backoff_initial_s=backoff_initial_s,
            backoff_max_s=backoff_max_s,
        )


def _run_with_timeout(func: Callable[[], T], *, timeout_s: float, op_name: str) -> T:
    if timeout_s <= 0:
        return func()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"{op_name}-timeout")
    future = executor.submit(func)
    try:
        return future.result(timeout=timeout_s)
    except FutureTimeoutError as exc:
        future.cancel()
        raise TimeoutError(f"{op_name} timed out after {timeout_s:.3f}s") from exc
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def call_with_retry(func: Callable[[], T], *, op_name: str, policy: RetryPolicy) -> T:
    normalized = policy.normalized()
    retryable = (TimeoutError, ConnectionError, OSError)

    attempt = 1
    while True:
        try:
            return _run_with_timeout(func, timeout_s=normalized.timeout_s, op_name=op_name)
        except retryable as exc:
            if attempt >= normalized.max_attempts:
                raise
            sleep_s = min(
                normalized.backoff_initial_s * (2 ** (attempt - 1)),
                normalized.backoff_max_s,
            )
            if sleep_s > 0:
                time.sleep(sleep_s)
            attempt += 1
