import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))

from project_contracts.project_scaffold import ensure_project_scaffold
from project_contracts.project_surface import SCAFFOLD_TEMPLATE_FILES, SCAFFOLD_TEMPLATE_MAP
from project_contracts.research_contract import sync_research_contract
from project_contracts.scaffold_template_loader import scaffold_template_dir


CANONICAL_SCAFFOLD_FILES = {
    "AGENTS.md",
    "project_charter.md",
    "project_index.md",
    "research_plan.md",
    "research_notebook.md",
    "research_contract.md",
    "docs/APPROVAL_GATES.md",
    "docs/ARTIFACT_CONTRACT.md",
    "docs/EVAL_GATE_CONTRACT.md",
}

ABSENT_DEFAULT_SURFACES = {
    ".mcp.template.json",
    "specs/plan.schema.json",
    "research_preflight.md",
    "project_brief.md",
    "idea_log.md",
    "prompts",
    "team",
    "research_team_config.json",
    ".hep",
    "knowledge_base",
}

TOO_SPECIFIC_SCAFFOLD_TOKENS = (
    "INSPIRE recid",
    "Citekey",
    "research_team_config.json",
    "idea_log.md",
    "Fourier convention",
    "physical interpretation",
    "linear response",
    "path integral",
    "perturbation theory",
    "propagators",
    "vertices",
    "LO/NLO",
    "power counting",
    "Julia",
    "numpy",
    "scipy",
    "KB delta",
    "knowledge_base/methodology_traces",
    "team packet",
    "~/.codex/skills/research-team",
)


class TestScaffoldContract(unittest.TestCase):
    def test_every_template_managed_file_has_a_template(self) -> None:
        template_root = scaffold_template_dir()
        missing = [
            f"{rel} -> {SCAFFOLD_TEMPLATE_MAP[rel]}"
            for rel in SCAFFOLD_TEMPLATE_FILES
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
        self.assertNotIn("(refresh to populate)", contract_text)

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
        self.assertIn("External references must use clickable stable links when available.", template)
        self.assertIn("new session", template)
        self.assertIn("autoresearch status --json", template)
        self.assertIn("1) [project_index.md](project_index.md)", template)
        self.assertIn("2) [AGENTS.md](AGENTS.md)", template)
        self.assertIn("Keep `research_notebook.md` organized by the problem's logic", template)
        self.assertIn("Do not append large dated run logs there", template)
        self.assertIn("opt-in support layers", template)
        self.assertNotIn("run_team_cycle.sh", template)
        self.assertNotIn("prompts/_system_member_a.txt", template)
        self.assertNotIn("research_team_config.json", template)

    def test_canonical_scaffold_creates_only_canonical_files(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            result = ensure_project_scaffold(
                repo_root=root,
                project_name="Canonical Noise",
                profile="mixed",
                project_policy="real_project",
            )

            self.assertEqual(set(result["created"]), CANONICAL_SCAFFOLD_FILES)
            self.assertEqual(set(result["context_files"]), CANONICAL_SCAFFOLD_FILES)
            self.assertEqual(result["scaffold"], "canonical")
            self.assertNotIn("variant", result)
            for rel in CANONICAL_SCAFFOLD_FILES:
                self.assertTrue((root / rel).is_file(), msg=rel)
            for rel in ABSENT_DEFAULT_SURFACES:
                self.assertFalse((root / rel).exists(), msg=rel)

    def test_project_scaffold_cli_has_no_variant_surface(self) -> None:
        env = {**os.environ, "PYTHONPATH": str(_src_root())}
        deprecated_flag = "--" + "variant"
        help_result = subprocess.run(
            [sys.executable, "-m", "project_contracts.project_scaffold_cli", "--help"],
            check=True,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertIn("canonical generic project scaffold", help_result.stdout)
        self.assertNotIn(deprecated_flag, help_result.stdout)

        with tempfile.TemporaryDirectory() as td:
            rejected = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "project_contracts.project_scaffold_cli",
                    "--root",
                    str(Path(td) / "proj"),
                    deprecated_flag,
                    "minimal",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn(f"unrecognized arguments: {deprecated_flag}", rejected.stderr)

    def test_project_index_and_research_plan_repeat_reconnect_discipline(self) -> None:
        agents_template = (scaffold_template_dir() / "AGENTS.md").read_text(encoding="utf-8")
        index_template = (scaffold_template_dir() / "project_index.md").read_text(encoding="utf-8")
        plan_template = (scaffold_template_dir() / "research_plan.md").read_text(encoding="utf-8")
        contract_template = (scaffold_template_dir() / "research_contract.md").read_text(encoding="utf-8")

        templates = [
            agents_template,
            index_template,
            plan_template,
            contract_template,
        ]
        for template in templates:
            self.assertIn("autoresearch status --json", template)
            self.assertIn(".autoresearch/bin/autoresearch status --json", template)
            self.assertIn("authoritative recovery briefing", template)
            self.assertIn("research_notebook.md", template)
        self.assertIn("1) [project_index.md](project_index.md) — checked-in front door for restart and navigation", index_template)
        self.assertIn("2) [AGENTS.md](AGENTS.md) — workflow anchor, reconnect discipline, and output rules", index_template)
        self.assertIn("If `.autoresearch/` exists, start by running `autoresearch status --json`", index_template)
        self.assertIn("# project_index.md\n", index_template)
        self.assertNotIn("# project_index.md (Template)", index_template)
        self.assertIn("organized by the research problem's logic", index_template)
        self.assertIn("# research_plan.md\n", plan_template)
        self.assertNotIn("# research_plan.md (Template)", plan_template)
        self.assertIn("not by appending a dated run log", plan_template)
        self.assertIn("If `.autoresearch/` exists, run `autoresearch status --json` first", plan_template)
        self.assertIn("opt-in support layers", index_template)
        self.assertNotIn("[prompts/](prompts/)", index_template)
        self.assertNotIn("[team/](team/)", index_template)
        self.assertIn("opt-in support layers", plan_template)
        self.assertNotIn("[prompts/](prompts/)", plan_template)
        self.assertNotIn("[team/](team/)", plan_template)

    def test_research_contract_template_drops_legacy_host_surface_residue(self) -> None:
        template = (scaffold_template_dir() / "research_contract.md").read_text(encoding="utf-8")

        self.assertNotIn("# research_contract.md (Template)", template)
        self.assertNotIn("run_team_cycle.sh --preflight-only", template)
        self.assertNotIn("fix_markdown_double_backslash_math.py --notes research_contract.md --in-place", template)
        self.assertNotIn("[research_team_config.json](research_team_config.json)", template)
        self.assertIn("durable restart truth", template)
        self.assertIn("<!-- REPRO_CAPSULE_START -->", template)
        self.assertIn("<!-- REPRO_CAPSULE_END -->", template)
        self.assertIn("## Reproducibility Capsule", template)
        self.assertIn("## Claims And Results", template)
        self.assertIn("## Final Conclusion Gate", template)

    def test_canonical_scaffold_templates_are_domain_neutral(self) -> None:
        rendered = "\n".join(
            (scaffold_template_dir() / SCAFFOLD_TEMPLATE_MAP[rel]).read_text(encoding="utf-8")
            for rel in SCAFFOLD_TEMPLATE_FILES
        )
        for token in TOO_SPECIFIC_SCAFFOLD_TOKENS:
            self.assertNotIn(token, rendered)

    def test_research_notebook_template_is_logic_first_not_date_first(self) -> None:
        template = (scaffold_template_dir() / "research_notebook.md").read_text(encoding="utf-8")

        self.assertIn("Organize it by the logic of the research problem, not by run date.", template)
        self.assertIn("Write dated run logs and raw step summaries in [research_plan.md](research_plan.md) or `artifacts/runs/<TAG>/`", template)
        self.assertIn("## Problem Statement", template)
        self.assertIn("## Current Understanding", template)
        self.assertIn("## Question Map", template)
        self.assertIn("## Evidence Map", template)
        self.assertIn("## Conventions and Definitions", template)
        self.assertIn("## Reasoning Threads", template)
        self.assertIn("## Claims and Results", template)
        self.assertIn("## Uncertainties and Kill Criteria", template)
        self.assertIn("## Change Log", template)
        self.assertNotIn("## Derivation Notes", template)
        self.assertNotIn("## Results", template)
