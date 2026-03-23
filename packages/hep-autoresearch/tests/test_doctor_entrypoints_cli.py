import json
import os
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestDoctorEntrypointDiscovery(unittest.TestCase):
    def _run_cli(self, repo_root: Path, argv: list[str]) -> tuple[int, str, str]:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        src_root = str(_src_root())
        added_path = False
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
            added_path = True

        from hep_autoresearch.orchestrator_cli import main as cli_main

        argv0 = list(sys.argv)
        try:
            sys.argv = list(argv)
            buf_out, buf_err = StringIO(), StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = int(cli_main())
            return rc, buf_out.getvalue(), buf_err.getvalue()
        finally:
            sys.argv = argv0
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def test_entrypoint_discovery_warning_non_strict(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            prev_path = os.environ.get("PATH", "")
            os.environ["PATH"] = "/usr/bin:/bin"
            try:
                rc, out, err = self._run_cli(repo_root, ["hepar", "--project-root", str(repo_root), "doctor", "--json"])
            finally:
                os.environ["PATH"] = prev_path
            self.assertEqual(rc, 0, msg=out + err)
            data = json.loads(out)
            self.assertIn("entrypoint_discovery", data)
            self.assertIn("autoresearch", data["entrypoint_discovery"]["entrypoints"])
            warnings = data.get("warnings") or []
            self.assertTrue(any((isinstance(w, dict) and w.get("code") == "entrypoints_missing") for w in warnings))

    def test_entrypoint_discovery_strict_fails(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            prev_path = os.environ.get("PATH", "")
            os.environ["PATH"] = "/usr/bin:/bin"
            try:
                rc, out, err = self._run_cli(
                    repo_root,
                    ["hepar", "--project-root", str(repo_root), "doctor", "--json", "--strict-entrypoints"],
                )
            finally:
                os.environ["PATH"] = prev_path
            self.assertEqual(rc, 2, msg=out + err)
            data = json.loads(out)
            self.assertFalse(bool(data.get("ok")))
            self.assertIn("autoresearch", data["entrypoint_discovery"]["entrypoints"])
            warnings = data.get("warnings") or []
            self.assertTrue(any((isinstance(w, dict) and w.get("code") == "entrypoints_missing") for w in warnings))


if __name__ == "__main__":
    unittest.main()
