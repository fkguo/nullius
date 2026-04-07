import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _run_cli(repo_root: Path, args: list[str]) -> tuple[int, str, str]:
    env = dict(os.environ)
    src = str(_src_root())
    prev = env.get("PYTHONPATH", "").strip()
    env["PYTHONPATH"] = src + (os.pathsep + prev if prev else "")
    cp = subprocess.run(
        [sys.executable, "-m", "hep_autoresearch.orchestrator_cli", "--project-root", str(repo_root), *args],
        cwd=str(repo_root),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return int(cp.returncode), str(cp.stdout), str(cp.stderr)


class TestDoctorBridgeRetiredFromInternalParser(unittest.TestCase):
    def test_internal_parser_rejects_doctor_command(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(repo_root, ["doctor"])
            self.assertEqual(rc, 2, msg=out + err)
            self.assertIn("invalid choice", out + err)
            self.assertIn("doctor", out + err)

    def test_internal_parser_rejects_bridge_command(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(repo_root, ["bridge"])
            self.assertEqual(rc, 2, msg=out + err)
            self.assertIn("invalid choice", out + err)
            self.assertIn("bridge", out + err)
