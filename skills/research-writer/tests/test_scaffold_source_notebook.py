"""Regression test for research-writer source-notebook resolution (interop fix).

Upstream research-team now emits research_notebook.md + research_contract.md; older
projects used Draft_Derivation.md. The scaffold/draft readers must probe the current
names first (falling back to the legacy one) instead of silently degrading to a
template-only skeleton when pointed at a current research-team project.
"""

import importlib.util
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parents[1] / "scripts" / "bin" / "research_writer_scaffold.py"
_spec = importlib.util.spec_from_file_location("research_writer_scaffold", _MOD)
sc = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = sc  # dataclasses on 3.12 need the module registered
_spec.loader.exec_module(sc)


def test_resolve_prefers_current_then_legacy(tmp_path):
    assert sc._resolve_source_notebook(tmp_path) is None
    (tmp_path / "Draft_Derivation.md").write_text("# Legacy\n", encoding="utf-8")
    assert sc._resolve_source_notebook(tmp_path).name == "Draft_Derivation.md"
    (tmp_path / "research_contract.md").write_text("# Contract\n", encoding="utf-8")
    assert sc._resolve_source_notebook(tmp_path).name == "research_contract.md"
    (tmp_path / "research_notebook.md").write_text("# Notebook\n", encoding="utf-8")
    assert sc._resolve_source_notebook(tmp_path).name == "research_notebook.md"


def test_read_draft_outline_reads_current_notebook(tmp_path):
    # A current research-team project (research_notebook.md, no legacy file) must
    # still enrich the scaffold rather than returning an empty outline.
    (tmp_path / "research_notebook.md").write_text("# Title\n## Method\n## Results\n", encoding="utf-8")
    assert sc._read_draft_outline(tmp_path) == ["Title", "Method", "Results"]
