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
    "HEP",
    "INSPIRE recid",
    "inspire_",
    "hep_",
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
        self.assertIn("## Scientific writing discipline", template)
        self.assertIn("use the field's native scientific language", template)
        for metaphor in ("pinning down", "closing the loop", "bridging", "building a pipeline", "opening a surface", "running a lane"):
            self.assertIn(metaphor, template)
        self.assertIn("only when they name a literal domain concept", template)
        self.assertIn("actual code, tooling, automation, environments, repository operations, control systems", template)
        for scientific_verb in ("derive", "estimate", "bound", "test", "compare", "constrain", "quantify uncertainty", "relate observables"):
            self.assertIn(scientific_verb, template)
        self.assertIn("## Literature note quality and reading depth", template)
        self.assertIn("Treat abstracts as triage only", template)
        self.assertIn("Do not use an abstract-only reading as decisive evidence", template)
        self.assertIn("important or directly related papers, read the full text", template)
        self.assertIn("If arXiv LaTeX source is available, prefer reading the source", template)
        self.assertIn("PDF, Zotero, Crossref, library, or browser tools", template)
        self.assertIn("If the host provides a `crossref` full-text skill or helper", template)
        self.assertIn("for example a local `crossref` skill", template)
        self.assertIn("obtain a full-text PDF", template)
        for access_level in ("abstract_only", "available_full_text", "full_text_pdf", "latex_source", "unavailable"):
            self.assertIn(access_level, template)
        self.assertIn("ask the project owner to provide it before relying on the paper for a central claim", template)
        self.assertIn("Do not present `abstract_only` or `unavailable` as read evidence for central claims", template)
        self.assertIn("Literature notes should record scientific content, not tool-use logs", template)
        self.assertIn("search traces, metadata checks, download attempts, and API/tool call details", template)
        self.assertIn("[research_plan.md](research_plan.md) progress entries or `artifacts/runs/<run_id>/", template)
        self.assertIn("sections/pages/equations/figures actually read", template)
        self.assertIn("central equations and assumptions", template)
        self.assertIn("what was not read and why", template)
        self.assertIn("project relevance, limitations, and remaining reading gaps", template)
        self.assertIn('Do not write only "PDF-body read for X"', template)
        self.assertIn("Prefer a safe, sortable, readable shape", template)
        self.assertIn("<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN", template)
        self.assertIn("do not use bare UUIDs, `run_<uuid>`", template)
        self.assertIn("source form read, relevant sections/pages/equations, claims used, limitations, and remaining reading gaps", template)
        self.assertIn("Format arXiv, DOI, PDF, source, library, and project-file references as clickable Markdown links", template)
        self.assertIn("Do not leave bare URLs in literature notes", template)
        self.assertIn("Do not wrap scientific notation in backticks", template)
        self.assertIn("physical quantities, formulas, variables, operators, state vectors, cross sections, S-matrix elements, transfer functions, equations, and assumptions", template)
        self.assertIn("Backticks are only for filenames, commands, literal field or key names, and code identifiers", template)
        self.assertIn("opt-in support layers", template)
        self.assertNotIn("run_team_cycle.sh", template)
        self.assertNotIn("prompts/_system_member_a.txt", template)
        self.assertNotIn("research_team_config.json", template)

    def test_literature_note_quality_contract_is_repeated_on_project_surfaces(self) -> None:
        template_root = scaffold_template_dir()
        agents_template = (template_root / "AGENTS.md").read_text(encoding="utf-8")
        contract_template = (template_root / "research_contract.md").read_text(encoding="utf-8")
        notebook_template = (template_root / "research_notebook.md").read_text(encoding="utf-8")
        index_template = (template_root / "project_index.md").read_text(encoding="utf-8")
        artifact_template = (template_root / "ARTIFACT_CONTRACT.md").read_text(encoding="utf-8")

        for template in (agents_template, contract_template, notebook_template):
            self.assertIn("latex_source", template)
            self.assertIn("full_text_pdf", template)
            self.assertIn("available_full_text", template)
            self.assertIn("abstract_only", template)
            self.assertIn("unavailable", template)
            self.assertIn("sections/pages/equations/figures actually read", template)
            self.assertIn("central equations and assumptions", template)
            self.assertIn("what was not read and why", template)

        self.assertIn("prefer arXiv LaTeX source when available", contract_template)
        self.assertIn("not completed evidence for central claims", contract_template)
        self.assertIn("Use clickable Markdown links for source references", contract_template)
        self.assertIn("scientific notation as LaTeX math instead of inline-code backticks", contract_template)
        self.assertIn("If the project creates literature notes", index_template)
        self.assertIn("full-text/source-first reading", index_template)
        self.assertIn("auditable coverage fields", index_template)
        self.assertIn("Literature access traces, metadata checks, download attempts, and API/tool call logs", artifact_template)
        self.assertIn("not in literature notes", artifact_template)

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
        self.assertIn("Store meaningful run outputs under `artifacts/runs/<run_id>/`", template)
        self.assertIn("If a provider records its own UUID or `run_<uuid>` identifier", template)
        self.assertIn("project-local artifact root name", template)

    def test_canonical_scaffold_templates_are_domain_neutral(self) -> None:
        rendered = "\n".join(
            (scaffold_template_dir() / SCAFFOLD_TEMPLATE_MAP[rel]).read_text(encoding="utf-8")
            for rel in SCAFFOLD_TEMPLATE_FILES
        )
        for token in TOO_SPECIFIC_SCAFFOLD_TOKENS:
            self.assertNotIn(token, rendered)
        self.assertNotIn("artifacts/runs/<TAG>", rendered)
        self.assertIn("artifacts/runs/<run_id>/", rendered)
        self.assertIn("20260502T023000Z-m3-branch-scan-r1", rendered)

    def test_research_notebook_template_is_logic_first_not_date_first(self) -> None:
        template = (scaffold_template_dir() / "research_notebook.md").read_text(encoding="utf-8")

        self.assertIn("Organize it by the logic of the research problem, not by run date.", template)
        self.assertIn("Write dated run logs and raw step summaries in [research_plan.md](research_plan.md) or `artifacts/runs/<run_id>/`", template)
        self.assertIn("## Problem Statement", template)
        self.assertIn("## Current Understanding", template)
        self.assertIn("## Question Map", template)
        self.assertIn("## Evidence Map", template)
        self.assertIn("## Conventions and Definitions", template)
        self.assertIn("## Reasoning Threads", template)
        self.assertIn("## Claims and Results", template)
        self.assertIn("## Uncertainties and Kill Criteria", template)
        self.assertIn("## Change Log", template)
        self.assertIn("source form read (`latex_source`, `full_text_pdf`, `available_full_text`, `abstract_only`, or `unavailable`)", template)
        self.assertIn("sections/pages/equations/figures actually read", template)
        self.assertIn("Tool-use logs, metadata checks, download attempts, and API/MCP call details belong in [research_plan.md](research_plan.md)", template)
        self.assertIn("LaTeX math for scientific notation rather than inline-code backticks", template)
        self.assertNotIn("## Derivation Notes", template)
        self.assertNotIn("## Results", template)
