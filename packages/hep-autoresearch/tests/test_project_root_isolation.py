import argparse
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


sys.path.insert(0, str(_src_root()))

from hep_autoresearch.orchestrator_cli import _mcp_env


class TestProjectRootIsolation(unittest.TestCase):
    def test_init_rejects_repo_internal_root_before_mutation(self) -> None:
        repo_tmp = _repo_root() / "skills" / "research-team" / ".tmp"
        repo_tmp.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=repo_tmp) as td:
            target = Path(td) / "repo-internal-project"
            env = dict(os.environ)
            env["PYTHONPATH"] = str(_src_root()) + os.pathsep + env.get("PYTHONPATH", "")
            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "hep_autoresearch.orchestrator_cli",
                    "--project-root",
                    str(target),
                    "init",
                ],
                capture_output=True,
                check=False,
                env=env,
                text=True,
            )
            self.assertNotEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
            self.assertIn("outside the autoresearch-lab dev repo", proc.stdout + proc.stderr)
            self.assertFalse((target / ".autoresearch").exists(), msg="init should fail before mutating repo-internal roots")

    def test_mcp_env_rejects_cli_repo_internal_hep_data_dir(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            args = argparse.Namespace(hep_data_dir=str(_repo_root() / "skills"))
            with self.assertRaisesRegex(ValueError, "HEP_DATA_DIR"):
                _mcp_env(repo_root, {}, args, create_data_dir=False, project_policy="real_project")

    def test_mcp_env_rejects_env_repo_internal_hep_data_dir(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            args = argparse.Namespace(hep_data_dir=None)
            old = os.environ.get("HEP_DATA_DIR")
            os.environ["HEP_DATA_DIR"] = str(_repo_root() / "packages")
            try:
                with self.assertRaisesRegex(ValueError, "HEP_DATA_DIR"):
                    _mcp_env(repo_root, {}, args, create_data_dir=False, project_policy="real_project")
            finally:
                if old is None:
                    os.environ.pop("HEP_DATA_DIR", None)
                else:
                    os.environ["HEP_DATA_DIR"] = old
