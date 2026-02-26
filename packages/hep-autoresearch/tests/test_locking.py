"""Tests for H-05: Cross-platform file lock."""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from hep_autoresearch.toolkit.locking import FileLock


class TestFileLock(unittest.TestCase):
    def test_basic_acquire_release(self) -> None:
        with TemporaryDirectory() as td:
            lock = FileLock(Path(td) / "test.lock")
            lock.acquire()
            self.assertTrue(lock.is_locked)
            lock.release()
            self.assertFalse(lock.is_locked)

    def test_context_manager(self) -> None:
        with TemporaryDirectory() as td:
            lock_path = Path(td) / "test.lock"
            with FileLock(lock_path) as lock:
                self.assertTrue(lock.is_locked)
                self.assertTrue(lock_path.exists())
            self.assertFalse(lock.is_locked)

    def test_double_release_is_safe(self) -> None:
        with TemporaryDirectory() as td:
            lock = FileLock(Path(td) / "test.lock")
            lock.acquire()
            lock.release()
            lock.release()  # should not raise
            self.assertFalse(lock.is_locked)

    def test_metadata_written(self) -> None:
        with TemporaryDirectory() as td:
            lock_path = Path(td) / "test.lock"
            lock = FileLock(lock_path)
            lock.acquire()
            meta = lock.read_owner_metadata()
            self.assertIsNotNone(meta)
            self.assertEqual(meta["owner_pid"], os.getpid())
            self.assertIn("acquired_at", meta)
            lock.release()

    def test_stale_detection_live_process(self) -> None:
        with TemporaryDirectory() as td:
            lock_path = Path(td) / "test.lock"
            lock = FileLock(lock_path)
            lock.acquire()
            # Current process is alive, so lock is not stale
            self.assertFalse(lock.is_stale())
            lock.release()

    def test_stale_detection_dead_process(self) -> None:
        import json

        with TemporaryDirectory() as td:
            lock_path = Path(td) / "test.lock"
            # Write metadata with a PID that doesn't exist
            lock_path.write_text(
                json.dumps({"owner_pid": 999999999, "acquired_at": "2020-01-01T00:00:00Z"}),
                encoding="utf-8",
            )
            lock = FileLock(lock_path)
            self.assertTrue(lock.is_stale())

    def test_creates_parent_dirs(self) -> None:
        with TemporaryDirectory() as td:
            lock_path = Path(td) / "nested" / "dir" / "test.lock"
            with FileLock(lock_path):
                self.assertTrue(lock_path.exists())


if __name__ == "__main__":
    unittest.main()
