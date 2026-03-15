import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))

from hep_autoresearch.toolkit.project_scaffold import ensure_project_scaffold
from hep_autoresearch.toolkit.project_surface import FULL_TEMPLATE_FILES, SCAFFOLD_TEMPLATE_MAP
from hep_autoresearch.toolkit.scaffold_template_loader import scaffold_template_dir


class TestScaffoldTemplateSync(unittest.TestCase):
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

    def test_project_index_stays_host_agnostic_in_minimal_scaffold(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            ensure_project_scaffold(repo_root=root, project_name="Template Sync")
            text = (root / "project_index.md").read_text(encoding="utf-8")

        for token in (
            "[team/LATEST.md](team/LATEST.md)",
            "[.hep/workspace.json](.hep/workspace.json)",
            "[knowledge_graph/](knowledge_graph/)",
            "[research_preflight.md](research_preflight.md)",
        ):
            self.assertNotIn(token, text)
        for token in ("project_charter.md", "research_plan.md", "research_notebook.md", "research_contract.md", "AGENTS.md", ".mcp.json.example"):
            self.assertIn(token, text)
