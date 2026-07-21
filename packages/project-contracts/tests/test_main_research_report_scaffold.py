from __future__ import annotations

import sys
import tempfile
from pathlib import Path


SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from project_contracts.main_research_report import validate_main_research_report
from project_contracts.project_scaffold import ensure_project_scaffold
from project_contracts.scaffold_template_loader import scaffold_template_dir


def test_fresh_scaffold_includes_report_template_and_agents_reference() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "project"
        ensure_project_scaffold(repo_root=root, project_policy="real_project")

        assert (root / "reports" / "main_research_report_template.md").is_file()
        assert "`reports/main_research_report_template.md`" in (root / "AGENTS.md").read_text(encoding="utf-8")


def test_main_research_report_template_is_distinct_and_supersession_safe() -> None:
    template = (scaffold_template_dir() / "main_research_report_template.md").read_text(encoding="utf-8")
    index = (scaffold_template_dir() / "project_index.md").read_text(encoding="utf-8")

    for phrase in (
        "Research object",
        "Representation coordinates",
        "Primary-source and full-text coverage",
        "Controlled approximations",
        "Bias magnitude",
        "Uncertainty and resolution",
        "Strongest alternative explanation",
        "Next falsifiable condition",
        "Human-readable evidence chain",
        "Machine provenance",
    ):
        assert phrase in template
    for authoring_phrase in (
        "Copy this template",
        "Passing the structural validator",
        "Add one record per validation",
        "For a replay record",
    ):
        assert authoring_phrase not in template
    assert "word count" not in template.lower()
    for phrase in (
        "A checkpoint/status/closeout summary",
        "Same implementation plus same input",
        "Run `nullius report-validate`",
        "MAIN_RESEARCH_REPORT_REGISTRY_START",
        "Current report ID",
        "Superseded by",
        "Never overwrite a registered report",
    ):
        assert phrase in index


def test_existing_report_contract_migration_fails_closed_until_promotion() -> None:
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        root = base / "existing-project"
        donor = base / "temporary-scaffold"
        ensure_project_scaffold(repo_root=root, project_policy="real_project")
        ensure_project_scaffold(repo_root=donor, project_name="Temporary Scaffold", project_policy="real_project")
        legacy_index = "# project_index.md\n\n## Existing navigation\n\n- Preserve this content.\n"
        (root / "project_index.md").write_text(legacy_index, encoding="utf-8")
        report_template = root / "reports" / "main_research_report_template.md"
        report_template.unlink()

        refreshed = ensure_project_scaffold(repo_root=root, refresh=True, project_policy="real_project")

        assert "reports/main_research_report_template.md" in refreshed["missing"]
        assert (root / "project_index.md").read_text(encoding="utf-8") == legacy_index
        assert not report_template.exists()
        before_merge = validate_main_research_report(root)
        assert "invalid_registry_markers" in {item["code"] for item in before_merge["errors"]}

        report_template.parent.mkdir(parents=True, exist_ok=True)
        report_template.write_bytes((donor / "reports" / "main_research_report_template.md").read_bytes())
        assert report_template.read_bytes() == (donor / "reports" / "main_research_report_template.md").read_bytes()
        registry = """
## Main research report

<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->
- Current report ID: `(none yet)`
- Current report: `(none yet)`

| Report ID | Report | SHA-256 | Supersedes | Superseded by |
|---|---|---|---|---|
<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->
"""
        (root / "project_index.md").write_text(legacy_index + registry, encoding="utf-8")
        after_merge = validate_main_research_report(root)

    assert "no_current_report" in {item["code"] for item in after_merge["errors"]}
