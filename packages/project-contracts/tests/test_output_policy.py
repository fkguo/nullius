import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))

from project_contracts.project_policy import assert_path_allowed, assert_path_within_project, dev_repo_root


class TestOutputPolicy(unittest.TestCase):
    def test_real_project_rejects_repo_internal_output_path(self) -> None:
        repo_root = dev_repo_root()
        with self.assertRaisesRegex(ValueError, "outside the autoresearch-lab dev repo"):
            assert_path_allowed(
                repo_root / "skills" / "research-team" / ".tmp" / "output",
                project_policy="real_project",
                label="team output path",
            )

    def test_real_project_allows_external_output_path(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            output_path = Path(td) / "team"
            resolved = assert_path_allowed(output_path, project_policy="real_project", label="team output path")
            self.assertEqual(resolved, output_path.resolve())

    def test_maintainer_fixture_allows_repo_internal_output_path(self) -> None:
        repo_root = dev_repo_root()
        output_path = repo_root / "skills" / "research-team" / ".tmp" / "regression" / "runs"
        resolved = assert_path_allowed(output_path, project_policy="maintainer_fixture", label="team output path")
        self.assertEqual(resolved, output_path.resolve())

    def test_notes_must_stay_inside_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            project_root = Path(td) / "proj"
            project_root.mkdir(parents=True, exist_ok=True)
            outside = Path(td) / "elsewhere" / "research_contract.md"
            outside.parent.mkdir(parents=True, exist_ok=True)
            outside.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "inside project root"):
                assert_path_within_project(outside, project_root=project_root, label="research notebook")
