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

    def test_scaffold_agents_template_includes_markdown_link_rules(self) -> None:
        template = (scaffold_template_dir() / "AGENTS.md").read_text(encoding="utf-8")

        self.assertIn("## Markdown and links", template)
        self.assertIn("Prefer Markdown links over bare URLs", template)
        self.assertIn("Use relative Markdown links for files inside the project", template)
        self.assertIn("Inline math must use `$...$`.", template)
        self.assertIn("Display math must use fenced `$$ ... $$`.", template)
        self.assertIn("Only inside multi-line display math blocks", template)
        self.assertIn("`arXiv`, `INSPIRE`, and `DOI` references must use clickable links.", template)
        self.assertIn("new session", template)
        self.assertIn("autoresearch status --json", template)
        self.assertIn("1) [AGENTS.md](AGENTS.md)", template)
        self.assertIn("2) [project_charter.md](project_charter.md)", template)

    def test_minimal_scaffold_does_not_create_mcp_template_or_plan_schema(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            result = ensure_project_scaffold(
                repo_root=root,
                project_name="Minimal Noise",
                profile="mixed",
                variant="minimal",
                project_policy="real_project",
            )

            self.assertFalse((root / ".mcp.template.json").exists())
            self.assertFalse((root / "specs" / "plan.schema.json").exists())
            self.assertNotIn(".mcp.template.json", result["created"])
            self.assertNotIn("specs/plan.schema.json", result["created"])

    def test_full_scaffold_keeps_mcp_template_and_plan_schema(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            result = ensure_project_scaffold(
                repo_root=root,
                project_name="Full Noise",
                profile="mixed",
                variant="full",
                project_policy="real_project",
            )

            self.assertTrue((root / ".mcp.template.json").exists())
            self.assertTrue((root / "specs" / "plan.schema.json").exists())
            self.assertIn(".mcp.template.json", result["created"])
            self.assertIn("specs/plan.schema.json", result["created"])

    def test_project_index_and_research_plan_repeat_reconnect_discipline(self) -> None:
        index_template = (scaffold_template_dir() / "project_index.md").read_text(encoding="utf-8")
        plan_template = (scaffold_template_dir() / "research_plan.md").read_text(encoding="utf-8")

        self.assertIn("If `.autoresearch/` exists, start by running `autoresearch status --json`", index_template)
        self.assertIn("If `.autoresearch/` exists, run `autoresearch status --json` first", plan_template)
