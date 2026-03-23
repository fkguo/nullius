import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))

from project_contracts.project_scaffold import ensure_project_scaffold
from project_contracts.project_surface import FULL_TEMPLATE_FILES, SCAFFOLD_TEMPLATE_MAP
from project_contracts.research_contract import sync_research_contract
from project_contracts.scaffold_template_loader import scaffold_template_dir


class TestScaffoldContract(unittest.TestCase):
    def test_every_template_managed_file_has_a_template(self) -> None:
        template_root = scaffold_template_dir()
        missing = [
            f"{rel} -> {SCAFFOLD_TEMPLATE_MAP[rel]}"
            for rel in FULL_TEMPLATE_FILES
            if not (template_root / SCAFFOLD_TEMPLATE_MAP[rel]).is_file()
        ]
        self.assertEqual(missing, [], msg="missing scaffold templates: " + ", ".join(missing))

    def test_template_inventory_has_no_orphans(self) -> None:
        template_names = {path.name for path in scaffold_template_dir().glob("*.md")}
        mapped_templates = set(SCAFFOLD_TEMPLATE_MAP.values())
        self.assertEqual(sorted(template_names), sorted(mapped_templates))

    def test_scaffold_and_contract_sync_use_neutral_authority(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            result = ensure_project_scaffold(
                repo_root=root,
                project_name="Neutral Scaffold",
                profile="mixed",
                variant="minimal",
                project_policy="real_project",
            )
            notebook = root / "research_notebook.md"
            notebook.write_text(
                "# research_notebook.md\n\n## Goal\n\n- Keep the scaffold generic.\n\n## References\n\n- [DemoRef](knowledge_base/literature/demo.md)\n",
                encoding="utf-8",
            )
            sync_research_contract(repo_root=root, create_missing=False, project_policy="real_project")
            contract_text = (root / "research_contract.md").read_text(encoding="utf-8")

        self.assertIn("research_contract.md", result["created"])
        self.assertIn("Source notebook: [research_notebook.md](research_notebook.md)", contract_text)
        self.assertIn("- Goal", contract_text)
        self.assertIn("- [DemoRef](knowledge_base/literature/demo.md)", contract_text)

    def test_scaffold_and_contract_sync_default_to_real_project_policy(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        with self.assertRaisesRegex(ValueError, "must resolve outside the autoresearch-lab dev repo"):
            ensure_project_scaffold(repo_root=repo_root, project_name="Repo Internal")
        with self.assertRaisesRegex(ValueError, "must resolve outside the autoresearch-lab dev repo"):
            sync_research_contract(repo_root=repo_root, create_missing=False)
