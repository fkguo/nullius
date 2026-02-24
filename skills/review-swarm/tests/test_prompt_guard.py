import importlib.util
import json
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path


def _load_run_multi_task_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "run_multi_task.py"
    spec = importlib.util.spec_from_file_location("run_multi_task", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_trace_events(trace_path: Path) -> list[dict]:
    if not trace_path.exists():
        return []
    return [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line.strip()]


class PromptGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()

    def test_bytes_within_limit_logs_pass(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            src = td_path / "prompt.txt"
            src.write_text("hello", encoding="utf-8")
            trace = td_path / "trace.jsonl"
            out_dir = td_path / "inputs"

            out = self.mod._apply_prompt_limit(
                src,
                label="test",
                out_dir=out_dir,
                trace_path=trace,
                max_bytes=10,
                max_chars=None,
                overflow="fail",
            )

            self.assertEqual(out, src)
            events = _read_trace_events(trace)
            self.assertEqual(events[-1]["event"], "prompt_guard_file")
            self.assertEqual(events[-1]["action"], "none")
            self.assertEqual(events[-1]["limit"]["type"], "bytes")

    def test_bytes_over_limit_fail_logs_violation(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            src = td_path / "prompt.txt"
            src.write_text("X" * 100, encoding="utf-8")
            trace = td_path / "trace.jsonl"
            out_dir = td_path / "inputs"

            with self.assertRaises(ValueError):
                self.mod._apply_prompt_limit(
                    src,
                    label="test",
                    out_dir=out_dir,
                    trace_path=trace,
                    max_bytes=10,
                    max_chars=None,
                    overflow="fail",
                )

            events = _read_trace_events(trace)
            self.assertEqual(events[-1]["event"], "prompt_guard_violation")
            self.assertEqual(events[-1]["action"], "fail")

    def test_bytes_over_limit_truncate_records_audit_fields(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            src = td_path / "prompt.txt"

            # 9 ASCII bytes + 1 byte of a 4-byte emoji => triggers UTF-8 boundary drop.
            src_bytes = ("A" * 9 + "😀" + "Z" * 5).encode("utf-8")
            src.write_bytes(src_bytes)

            trace = td_path / "trace.jsonl"
            out_dir = td_path / "inputs"

            out = self.mod._apply_prompt_limit(
                src,
                label="test",
                out_dir=out_dir,
                trace_path=trace,
                max_bytes=10,
                max_chars=None,
                overflow="truncate",
            )

            self.assertNotEqual(out, src)
            self.assertTrue(out.exists())
            self.assertLessEqual(out.stat().st_size, 10)

            events = _read_trace_events(trace)
            self.assertEqual(events[-1]["event"], "prompt_guard_truncate")
            self.assertEqual(events[-1]["action"], "truncate")
            self.assertIn("source_prefix_bytes", events[-1])
            self.assertIn("source_prefix_sha256", events[-1])
            self.assertIn("dropped_invalid_utf8_bytes", events[-1])

            raw_prefix = src_bytes[:10]
            self.assertEqual(events[-1]["source_prefix_bytes"], 10)
            self.assertEqual(events[-1]["source_prefix_sha256"], sha256(raw_prefix).hexdigest())
            self.assertEqual(events[-1]["dropped_invalid_utf8_bytes"], 1)
            self.assertEqual(events[-1]["truncated_sha256"], sha256(out.read_bytes()).hexdigest())

    def test_chars_over_limit_truncate(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            src = td_path / "prompt.txt"
            src.write_text("ab😀cd", encoding="utf-8")
            trace = td_path / "trace.jsonl"
            out_dir = td_path / "inputs"

            out = self.mod._apply_prompt_limit(
                src,
                label="test",
                out_dir=out_dir,
                trace_path=trace,
                max_bytes=None,
                max_chars=3,
                overflow="truncate",
            )

            self.assertNotEqual(out, src)
            self.assertEqual(out.read_text(encoding="utf-8"), "ab😀")

    def test_chars_within_limit_logs_pass(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            src = td_path / "prompt.txt"
            src.write_text("ab😀", encoding="utf-8")
            trace = td_path / "trace.jsonl"
            out_dir = td_path / "inputs"

            out = self.mod._apply_prompt_limit(
                src,
                label="test",
                out_dir=out_dir,
                trace_path=trace,
                max_bytes=None,
                max_chars=3,
                overflow="fail",
            )

            self.assertEqual(out, src)
            events = _read_trace_events(trace)
            self.assertEqual(events[-1]["event"], "prompt_guard_file")
            self.assertEqual(events[-1]["action"], "none")
            self.assertEqual(events[-1]["limit"]["type"], "chars")


if __name__ == "__main__":
    unittest.main()
