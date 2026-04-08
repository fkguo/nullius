import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))

from project_contracts.project_policy import assert_project_root_allowed, dev_repo_root


class TestRootPolicy(unittest.TestCase):
    def test_real_project_rejects_repo_internal_root(self) -> None:
        repo_root = dev_repo_root()
        with self.assertRaisesRegex(ValueError, "outside the autoresearch-lab dev repo"):
            assert_project_root_allowed(repo_root / "skills" / "research-team", project_policy="real_project")

    def test_maintainer_fixture_allows_repo_internal_tmp(self) -> None:
        repo_root = dev_repo_root()
        root = repo_root / "skills" / "research-team" / ".tmp" / "fixture"
        resolved = assert_project_root_allowed(root, project_policy="maintainer_fixture")
        self.assertEqual(resolved, root.resolve())

    def test_maintainer_fixture_rejects_other_repo_internal_root(self) -> None:
        repo_root = dev_repo_root()
        with self.assertRaisesRegex(ValueError, "allowed maintainer_fixture"):
            assert_project_root_allowed(repo_root / "packages" / "hep-autoresearch", project_policy="maintainer_fixture")

    def test_real_project_allows_external_root(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            resolved = assert_project_root_allowed(root, project_policy="real_project")
            self.assertEqual(resolved, root.resolve())
