from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent
RESEARCH_TEAM_DIR = TESTS_DIR.parent
GATE = RESEARCH_TEAM_DIR / "scripts" / "gates" / "check_knowledge_layers.py"
CONFIG_TEMPLATE = RESEARCH_TEAM_DIR / "assets" / "research_team_config_template.json"


def _write_config(tmp_path: Path, *, require_literature_reading_evidence: bool = False) -> None:
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(
            {
                "features": {
                    "knowledge_layers_gate": True,
                },
                "knowledge_layers": {
                    "base_dir": "knowledge_base",
                    "require_min_methodology_traces": 1,
                    "require_min_literature": 1,
                    "require_min_priors": 1,
                    "allow_none": False,
                    "require_literature_reading_evidence": require_literature_reading_evidence,
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _write_template_default_config(tmp_path: Path) -> None:
    data = json.loads(CONFIG_TEMPLATE.read_text(encoding="utf-8"))
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(data, indent=2) + "\n",
        encoding="utf-8",
    )


def _write_project_files(tmp_path: Path, literature_note: str) -> Path:
    kb_root = tmp_path / "knowledge_base"
    (kb_root / "literature").mkdir(parents=True, exist_ok=True)
    (kb_root / "methodology_traces").mkdir(parents=True, exist_ok=True)
    (kb_root / "priors").mkdir(parents=True, exist_ok=True)

    (kb_root / "literature" / "demo.md").write_text(literature_note, encoding="utf-8")
    (kb_root / "methodology_traces" / "trace.md").write_text("# Trace\n\n- validated\n", encoding="utf-8")
    (kb_root / "priors" / "prior.md").write_text("# Prior\n\n- convention\n", encoding="utf-8")

    notes = tmp_path / "research_contract.md"
    notes.write_text(
        "<!-- REPRO_CAPSULE_START -->\n"
        "### I) Knowledge base references (MANDATORY when enabled)\n"
        "Literature:\n"
        "- [Demo](knowledge_base/literature/demo.md)\n"
        "Methodology traces:\n"
        "- [Trace](knowledge_base/methodology_traces/trace.md)\n"
        "Priors:\n"
        "- [Prior](knowledge_base/priors/prior.md)\n"
        "<!-- REPRO_CAPSULE_END -->\n",
        encoding="utf-8",
    )
    return notes


def _run_gate(tmp_path: Path, literature_note: str, *, require_literature_reading_evidence: bool) -> subprocess.CompletedProcess[str]:
    _write_config(tmp_path, require_literature_reading_evidence=require_literature_reading_evidence)
    notes = _write_project_files(tmp_path, literature_note)
    return subprocess.run(
        [sys.executable, str(GATE), "--notes", str(notes)],
        text=True,
        capture_output=True,
        check=False,
    )


def _run_gate_with_template_default_config(tmp_path: Path, literature_note: str) -> subprocess.CompletedProcess[str]:
    _write_template_default_config(tmp_path)
    notes = _write_project_files(tmp_path, literature_note)
    return subprocess.run(
        [sys.executable, str(GATE), "--notes", str(notes)],
        text=True,
        capture_output=True,
        check=False,
    )


def _metadata_only_note() -> str:
    return (
        "# Demo Note\n\n"
        "RefKey: demo-ref\n"
        "Authors: Doe et al.\n"
        "Publication: Phys. Rev. 1 1 1968\n"
        "Links:\n"
        "- INSPIRE: https://inspirehep.net/literature/1234\n\n"
        "Verification status: metadata-only (auto-generated; full text not yet deep-read)\n"
        "Evidence readiness: reading-required\n"
        "Reading evidence needed:\n"
        "- Source form actually read: (fill: latex_source | full_text_pdf | available_full_text | abstract_only | unavailable | other)\n"
        "- Sections/pages/equations/figures actually read: (fill)\n"
        "- Central equations/assumptions extracted: (fill)\n"
        "- What was not read and why: (fill)\n"
        "- Project relevance: (fill)\n"
        "- Limitations / caveats for using this note: (fill)\n"
    )


def _reading_ready_note() -> str:
    return (
        "# Demo Note\n\n"
        "RefKey: demo-ref\n"
        "Authors: Doe et al.\n"
        "Publication: Phys. Rev. 1 1 1968\n"
        "Links:\n"
        "- INSPIRE: https://inspirehep.net/literature/1234\n\n"
        "Verification status: spot-checked\n"
        "Evidence readiness: evidence-ready\n"
        "Reading evidence needed:\n"
        "- Source form actually read: full_text_pdf\n"
        "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n"
        "- Central equations/assumptions extracted: dispersion relation assumes one subtraction and elastic dominance\n"
        "- What was not read and why: appendices not needed for current bound check\n"
        "- Project relevance: baseline method for the continuation step used in this milestone\n"
        "- Limitations / caveats for using this note: no independent reproduction yet; use only for method comparison\n"
    )


def test_metadata_only_note_passes_when_reading_evidence_not_required(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _metadata_only_note(), require_literature_reading_evidence=False)
    assert result.returncode == 0
    assert "[ok] knowledge layers gate passed" in result.stdout


def test_metadata_only_note_fails_when_reading_evidence_required(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _metadata_only_note(), require_literature_reading_evidence=True)
    assert result.returncode == 1
    assert "allowed values: spot-checked, replicated, contradicted" in result.stdout


def test_reading_ready_note_passes_when_reading_evidence_required(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _reading_ready_note(), require_literature_reading_evidence=True)
    assert result.returncode == 0
    assert "[ok] knowledge layers gate passed" in result.stdout


def test_chinese_reading_evidence_values_pass_when_reading_evidence_required(tmp_path: Path) -> None:
    note = (
        _reading_ready_note()
        .replace("- Source form actually read: full_text_pdf\n", "- Source form actually read: other\n")
        .replace(
            "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n",
            "- Sections/pages/equations/figures actually read: sections 2-5; 第3页; 公式(3); 图1; 表2; 附录A\n",
        )
        .replace(
            "- Central equations/assumptions extracted: dispersion relation assumes one subtraction and elastic dominance\n",
            "- Central equations/assumptions extracted: 核心假设是色散关系只需要一次减法，并在当前能区把弹性主导当作主要近似。\n",
        )
        .replace(
            "- Project relevance: baseline method for the continuation step used in this milestone\n",
            "- Project relevance: 这篇笔记直接给出当前里程碑延拓步骤所需的基线方法与误差来源判断。\n",
        )
        .replace(
            "- Limitations / caveats for using this note: no independent reproduction yet; use only for method comparison\n",
            "- Limitations / caveats for using this note: 目前还没有独立复算，因此这里只能把它当作方法比较与参数范围交叉检查的依据。\n",
        )
    )
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 0
    assert "[ok] knowledge layers gate passed" in result.stdout


def test_short_chinese_reading_statements_pass_when_reading_evidence_required(tmp_path: Path) -> None:
    note = (
        _reading_ready_note()
        .replace(
            "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n",
            "- Sections/pages/equations/figures actually read: 第3页; 公式(3); 表2\n",
        )
        .replace(
            "- Central equations/assumptions extracted: dispersion relation assumes one subtraction and elastic dominance\n",
            "- Central equations/assumptions extracted: 色散关系只需一次减法\n",
        )
        .replace(
            "- Project relevance: baseline method for the continuation step used in this milestone\n",
            "- Project relevance: 可直接用于当前延拓步骤\n",
        )
        .replace(
            "- Limitations / caveats for using this note: no independent reproduction yet; use only for method comparison\n",
            "- Limitations / caveats for using this note: 暂无独立复算，只能作比较\n",
        )
    )
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 0
    assert "[ok] knowledge layers gate passed" in result.stdout


def test_plural_sections_locator_passes_when_reading_evidence_required(tmp_path: Path) -> None:
    note = _reading_ready_note().replace(
        "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n",
        "- Sections/pages/equations/figures actually read: sections 2-5\n",
    )
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 0
    assert "[ok] knowledge layers gate passed" in result.stdout


def test_source_file_locator_passes_when_reading_evidence_required(tmp_path: Path) -> None:
    note = _reading_ready_note().replace(
        "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n",
        "- Sections/pages/equations/figures actually read: latex source: main.tex\n",
    )
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 0
    assert "[ok] knowledge layers gate passed" in result.stdout


def test_tab_locator_passes_when_reading_evidence_required(tmp_path: Path) -> None:
    note = _reading_ready_note().replace(
        "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n",
        "- Sections/pages/equations/figures actually read: Tab. 2\n",
    )
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 0
    assert "[ok] knowledge layers gate passed" in result.stdout


def test_template_default_config_requires_literature_reading_evidence(tmp_path: Path) -> None:
    cfg = json.loads(CONFIG_TEMPLATE.read_text(encoding="utf-8"))
    assert cfg["knowledge_layers"]["require_literature_reading_evidence"] is True

    result = _run_gate_with_template_default_config(tmp_path, _metadata_only_note())
    assert result.returncode == 1
    assert "knowledge_layers.require_literature_reading_evidence=true" in result.stdout


def test_missing_reading_coverage_field_fails_when_reading_evidence_required(tmp_path: Path) -> None:
    note = _reading_ready_note().replace("- Project relevance: baseline method for the continuation step used in this milestone\n", "")
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 1
    assert "missing required reading-evidence field" in result.stdout


def test_natural_language_source_form_fails_when_reading_evidence_required(tmp_path: Path) -> None:
    note = _reading_ready_note().replace(
        "- Source form actually read: full_text_pdf\n",
        "- Source form actually read: journal PDF downloaded on 2026-05-03\n",
    )
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 1
    assert "must use controlled enum values" in result.stdout


def test_weak_reading_evidence_fields_fail_when_reading_evidence_required(tmp_path: Path) -> None:
    weak_cases = [
        (
            "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n",
            "- Sections/pages/equations/figures actually read: latex source\n",
            "Sections/pages/equations/figures actually read",
        ),
        (
            "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n",
            "- Sections/pages/equations/figures actually read: arxiv source\n",
            "Sections/pages/equations/figures actually read",
        ),
        (
            "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n",
            "- Sections/pages/equations/figures actually read: some pages\n",
            "Sections/pages/equations/figures actually read",
        ),
        (
            "- Central equations/assumptions extracted: dispersion relation assumes one subtraction and elastic dominance\n",
            "- Central equations/assumptions extracted: main result\n",
            "Central equations/assumptions extracted",
        ),
        (
            "- Project relevance: baseline method for the continuation step used in this milestone\n",
            "- Project relevance: useful\n",
            "Project relevance",
        ),
        (
            "- Limitations / caveats for using this note: no independent reproduction yet; use only for method comparison\n",
            "- Limitations / caveats for using this note: none\n",
            "Limitations / caveats for using this note",
        ),
        (
            "- What was not read and why: appendices not needed for current bound check\n",
            "- What was not read and why: n/a\n",
            "What was not read and why",
        ),
    ]
    for old, new, field_name in weak_cases:
        note = _reading_ready_note().replace(old, new)
        result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
        assert result.returncode == 1
        assert field_name in result.stdout


def test_bogus_verification_and_evidence_status_fail_when_reading_evidence_required(tmp_path: Path) -> None:
    note = (
        _reading_ready_note()
        .replace("Verification status: spot-checked\n", "Verification status: ingest-failed\n")
        .replace("Evidence readiness: evidence-ready\n", "Evidence readiness: banana\n")
    )
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 1
    assert "allowed values: spot-checked, replicated, contradicted" in result.stdout
    assert "must be 'evidence-ready'" in result.stdout
