import json
import unittest
from pathlib import Path


class TestRevisionFixtureSurface(unittest.TestCase):
    def test_e5_revision_fixture_uses_research_contract_surface(self) -> None:
        package_root = Path(__file__).resolve().parents[1]
        case_path = package_root / "evals" / "cases" / "E5-revision-compile-provenance" / "case.json"
        fixture_path = package_root / "evals" / "fixtures" / "revision_project" / "research_contract.md"
        main_tex_path = package_root / "evals" / "fixtures" / "revision_project" / "paper" / "main.tex"

        payload = json.loads(case_path.read_text(encoding="utf-8"))
        required_paths = payload["acceptance"]["required_paths_exist"]

        self.assertIn("evals/fixtures/revision_project/research_contract.md", required_paths)
        self.assertNotIn("evals/fixtures/revision_project/Draft_Derivation.md", required_paths)
        self.assertTrue(fixture_path.is_file(), msg="revision fixture contract should be checked in")
        self.assertTrue(main_tex_path.is_file(), msg="revision fixture paper should be checked in")

        text = fixture_path.read_text(encoding="utf-8")
        self.assertIn("# research_contract.md", text)
        self.assertIn("### E) Headline numbers", text)
