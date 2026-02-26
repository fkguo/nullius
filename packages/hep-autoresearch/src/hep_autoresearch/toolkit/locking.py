"""Cross-platform advisory file lock (H-05).

Provides a ``FileLock`` context manager for serialising access to shared
resources (ledger, state file, artifacts) across concurrent processes.

On POSIX (macOS/Linux) the lock uses ``fcntl.flock``.  On platforms without
``fcntl`` the lock is a best-effort no-op (single-process safety only).

**Important**: ``FileLock`` is **NOT reentrant**.  Each call to ``acquire()``
opens a new file descriptor and calls ``flock`` on it.  On Linux, ``flock``
treats distinct file descriptors independently — a process that holds an
exclusive lock on ``fd1`` will block (and eventually ``TimeoutError``) when
trying to acquire an exclusive lock on ``fd2`` for the same file, even within
the same thread.  Callers must ensure that locked functions never call other
locked functions.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class FileLock:
    """Advisory exclusive file lock with timeout.

    Usage::

        with FileLock(Path("/tmp/my.lock"), timeout_seconds=5):
            # critical section
            ...

    The lock file will contain JSON metadata (``owner_pid``, ``acquired_at``)
    for diagnostic purposes.
    """

    def __init__(
        self,
        path: Path,
        *,
        timeout_seconds: float = 10.0,
        poll_seconds: float = 0.1,
    ) -> None:
        self._path = Path(path)
        self._timeout = max(float(timeout_seconds), 0.0)
        self._poll = max(float(poll_seconds), 0.01)
        self._fd: int | None = None
        self._has_fcntl = True
        try:
            import fcntl as _  # noqa: F401
        except ImportError:
            self._has_fcntl = False

    # -- context manager ---------------------------------------------------

    def __enter__(self) -> "FileLock":
        self.acquire()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.release()

    # -- public API --------------------------------------------------------

    def acquire(self) -> None:
        """Acquire the lock, blocking up to *timeout_seconds*.

        Raises ``TimeoutError`` if the lock cannot be acquired within the
        timeout window.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)

        if not self._has_fcntl:
            # Non-POSIX fallback: touch the file but don't actually lock.
            self._path.touch(exist_ok=True)
            return

        import errno
        import time

        import fcntl  # type: ignore[import-not-found]

        fd = os.open(str(self._path), os.O_CREAT | os.O_RDWR, 0o644)
        deadline = time.time() + self._timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as e:
                if e.errno not in {errno.EACCES, errno.EAGAIN}:
                    os.close(fd)
                    raise
                if time.time() >= deadline:
                    os.close(fd)
                    raise TimeoutError(
                        f"timed out acquiring lock after {self._timeout}s: {self._path}"
                    )
                time.sleep(self._poll)

        # Write diagnostic metadata (best-effort; never fail the lock).
        try:
            from ._time import utc_now_iso

            metadata = json.dumps(
                {"owner_pid": os.getpid(), "acquired_at": utc_now_iso()},
                sort_keys=True,
            )
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, metadata.encode("utf-8"))
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort metadata write
            pass

        self._fd = fd

    def release(self) -> None:
        """Release the lock.  Safe to call multiple times."""
        fd = self._fd
        if fd is None:
            return
        self._fd = None
        if self._has_fcntl:
            try:
                import fcntl  # type: ignore[import-not-found]

                fcntl.flock(fd, fcntl.LOCK_UN)
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort lock release
                pass
        try:
            os.close(fd)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort fd close
            pass

    @property
    def is_locked(self) -> bool:
        return self._fd is not None

    # -- stale lock detection (startup reconcile) --------------------------

    def read_owner_metadata(self) -> dict[str, Any] | None:
        """Read the lock file metadata without acquiring the lock.

        Returns ``None`` if the file doesn't exist or can't be parsed.
        """
        try:
            data = self._path.read_text(encoding="utf-8").strip()
            if not data:
                return None
            parsed = json.loads(data)
            return parsed if isinstance(parsed, dict) else None
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort metadata read
            return None

    def is_stale(self) -> bool:
        """Check if the lock file references a dead process (stale lock).

        Returns ``True`` if the lock file exists and the owner PID is no
        longer running.  Returns ``False`` if no metadata, no PID, or the
        process is still alive.
        """
        meta = self.read_owner_metadata()
        if meta is None:
            return False
        pid = meta.get("owner_pid")
        if not isinstance(pid, int) or pid <= 0:
            return False
        try:
            os.kill(pid, 0)
            return False  # process alive
        except ProcessLookupError:
            return True  # process dead → stale
        except PermissionError:
            return False  # process alive but different user
